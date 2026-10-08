import Foundation

/// One candidate home for a recording. `folderId` is `nil` when the model
/// proposed a folder the user does not have yet, which the caller must create
/// (`CloudClient.createFolder`) before it can file anything into it.
public struct FilingFolderSuggestion: Equatable, Sendable {
    /// nil = a folder that does not exist yet and must be created on accept.
    public let folderId: String?
    public let name: String
    public let reason: String

    public init(folderId: String?, name: String, reason: String) {
        self.folderId = folderId
        self.name = name
        self.reason = reason
    }
}

/// What the filing pass proposes for one finished recording.
public struct FilingSuggestion: Equatable, Sendable {
    /// "" when the model had nothing better to propose than the current title.
    public let title: String
    public let folders: [FilingFolderSuggestion]

    public init(title: String, folders: [FilingFolderSuggestion]) {
        self.title = title
        self.folders = folders
    }
}

/// The pass that runs once a recording has been transcribed: read the
/// conversation and say what the recording should be CALLED and where it should
/// be FILED.
///
/// Every door into a recording names it badly — on the phone a recording
/// arrives as "Meeting Sep 7, 3:20 PM" — so this is usually the first honest
/// title a recording gets. It is also, like the dictation rewrite, entirely
/// optional: the recording already has a name and a home, so a failure of any
/// kind (no network, an unparsable answer, a model that ignored the folder
/// menu) resolves to "leave it exactly as it is". That is why `suggest` returns
/// an optional rather than an error the caller has to interpret, and why
/// nothing the model says is used before it has been through `acceptTitle` and
/// `resolveFolders`.
public enum FilingSuggester {
    /// The UI language the title and the reasons are written in.
    ///
    /// Not the transcript's language: the title is shown in the library next to
    /// every other title, so it follows the app the user is reading, exactly as
    /// the desktop's does. Resolved the way the rest of the app resolves its UI
    /// language (`Bundle.main.preferredLocalizations.first`, see
    /// `Announcement.copy(forLocalization:)`): any `zh` localization is the
    /// Traditional one — the app ships no Simplified — and everything else is
    /// English.
    public enum Language: Equatable, Sendable {
        case traditionalChinese
        case english

        public init(localization: String) {
            self = localization.hasPrefix("zh") ? .traditionalChinese : .english
        }

        /// The app's own UI language, as the app bundle resolves it.
        public static var current: Language {
            Language(localization: Bundle.main.preferredLocalizations.first ?? "en")
        }

        var instruction: String {
            switch self {
            case .traditionalChinese: return FilingPrompt.languageInstructionZhTW
            case .english: return FilingPrompt.languageInstructionEn
            }
        }
    }

    /// The standing instruction: the shared rules, the language the answer is
    /// written in, and the JSON shape asked for in words. Every piece comes out
    /// of `FilingPrompt` (generated from `shared/prompts/filing.json`), which the
    /// desktop and Android read too — drift between the platforms shows up as
    /// the phone and the Mac disagreeing about what a meeting is called.
    ///
    /// The JSON shape is asked for in words rather than with an OpenAI
    /// `response_format`: we have not verified that the worker in front of the
    /// model passes it through, and a request rejected for an unknown field
    /// costs the whole pass — while a model that answers in prose costs
    /// nothing, because `parse` shrugs and the recording keeps its name.
    static func systemPrompt(language: Language) -> String {
        FilingPrompt.rules + language.instruction + FilingPrompt.jsonInstruction
    }

    // MARK: the call

    /// Run the pass over a recording's meta as it stands in the cloud: its
    /// transcript, the speaker names somebody gave it, its meeting context and
    /// the name it carries now.
    public static func suggest(
        meta: RecordingMeta,
        folders: [CloudFolder],
        language: Language,
        cloud: CloudClient
    ) async throws -> FilingSuggestion? {
        try await suggest(
            segments: meta.segments,
            speakerNames: meta.speakerNames,
            meetingContext: meta.meetingContext,
            currentTitle: meta.title,
            folders: folders,
            language: language,
            cloud: cloud)
    }

    /// Ask for a title and 2-3 folders for a finished recording.
    ///
    /// Returns `nil` when there is nothing to read, when the answer could not be
    /// parsed, or when nothing in it survived the gates — the caller keeps the
    /// current title and leaves the recording where it is. Throws only on
    /// transport/HTTP failure, which means the same thing to the caller.
    public static func suggest(
        segments: [TranscriptSegment],
        speakerNames: [String: String],
        meetingContext: String,
        currentTitle: String,
        folders: [CloudFolder],
        language: Language,
        cloud: CloudClient
    ) async throws -> FilingSuggestion? {
        let transcript = transcript(segments, speakerNames: speakerNames)
        guard !transcript.isEmpty else { return nil }
        let excerpt = capped(transcript)

        let body = try JSONEncoder().encode(
            request(
                meetingContext: meetingContext, currentTitle: currentTitle, folders: folders,
                transcript: excerpt, language: language))
        let data = try await cloud.postJSON(CloudChat.path, body: body)
        guard let content = CloudChat.content(from: data), let payload = parse(content) else {
            return nil
        }
        return gate(payload, currentTitle: currentTitle, folders: folders, transcript: excerpt)
    }

    /// The whole request, as it goes on the wire. `transcript` is the already
    /// rendered and capped excerpt.
    static func request(
        meetingContext: String, currentTitle: String, folders: [CloudFolder],
        transcript: String, language: Language
    ) -> CloudChat.Request {
        CloudChat.Request(
            model: FilingPrompt.model,
            temperature: FilingPrompt.temperature,
            maxTokens: FilingPrompt.maxTokens,
            messages: [
                .init(role: "system", content: systemPrompt(language: language)),
                .init(
                    role: "user",
                    content: userMessage(
                        meetingContext: meetingContext, currentTitle: currentTitle,
                        folders: folders, transcript: transcript)),
            ])
    }

    /// What survives of the model's answer. A title we will not use does not
    /// sink the folder suggestions with it: the two halves of this pass fail
    /// independently, and half an answer is still worth showing. Nothing left
    /// standing is the same as no answer.
    static func gate(
        _ payload: RawSuggestion, currentTitle: String, folders: [CloudFolder], transcript: String
    ) -> FilingSuggestion? {
        let resolved = resolveFolders(payload.folders, folders: folders)
        let candidate = payload.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let title =
            acceptTitle(candidate, currentTitle: currentTitle, transcript: transcript)
            ? candidate : ""
        if title.isEmpty, resolved.isEmpty { return nil }
        return FilingSuggestion(title: title, folders: resolved)
    }

    /// The context block, in the order every platform sends it: the meeting
    /// context the user wrote (when there is one), what the recording is called
    /// now (so the model can decline to rename it), the menu of existing homes,
    /// then the conversation.
    static func userMessage(
        meetingContext: String, currentTitle: String, folders: [CloudFolder], transcript: String
    ) -> String {
        let context = meetingContext.trimmingCharacters(in: .whitespacesAndNewlines)
        let named = currentTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        return (context.isEmpty ? "" : FilingPrompt.meetingContextPrefix + context + "\n\n")
            + FilingPrompt.currentTitlePrefix + (named.isEmpty ? FilingPrompt.untitled : named)
            + "\n\n"
            + folderMenu(folders)
            + FilingPrompt.transcriptHeader + "\n" + transcript
    }

    /// Render the folder registry as the model's menu of existing homes.
    static func folderMenu(_ folders: [CloudFolder]) -> String {
        let names = personal(folders)
            .map { $0.name.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        if names.isEmpty {
            return FilingPrompt.noFolders + "\n\n"
        }
        return FilingPrompt.foldersHeader + "\n"
            + names.map { "- \($0)" }.joined(separator: "\n") + "\n\n"
    }

    /// Filing is a personal-library action: a recording on the phone lives in
    /// the signed-in account's own registry, and an org's shared folders belong
    /// to a workspace the user may only be able to read. Offering one as a home
    /// would produce a suggestion that cannot be accepted.
    static func personal(_ folders: [CloudFolder]) -> [CloudFolder] {
        folders.filter { $0.orgId == nil }
    }

    // MARK: the transcript we send

    /// The transcript as the model reads it, in the desktop's
    /// `transcriptWithTimestamps` shape (`src/lib/store.ts`): final segments
    /// only, oldest first, one line of `[m:ss] [Speaker] text` each.
    ///
    /// Written here rather than borrowed from the app's `TranscriptClipboard`
    /// because that shape is for a human pasting into a mail draft — two lines
    /// per turn, blank line between — and it lives in the app target, which this
    /// package cannot see. The speaker labels themselves are not re-derived:
    /// they come from `RecordingMeta`, so a name the user set on the desktop
    /// reads the same to the model as it does on screen.
    static func transcript(_ segments: [TranscriptSegment], speakerNames: [String: String])
        -> String
    {
        segments
            .filter { $0.isFinal && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .sorted { $0.startMs < $1.startMs }
            .map { seg in
                let label = RecordingMeta.speakerLabel(for: seg, names: speakerNames)
                let text = seg.text.trimmingCharacters(in: .whitespacesAndNewlines)
                return "[\(clock(seg.startMs))] [\(label)] \(text)"
            }
            .joined(separator: "\n")
    }

    /// A meeting-relative offset as m:ss, matching the desktop's `formatClock`.
    static func clock(_ ms: UInt64) -> String {
        let seconds = ms / 1000
        return "\(seconds / 60):\(String(format: "%02d", seconds % 60))"
    }

    /// Head + tail, with the middle marked as removed.
    ///
    /// An hour of conversation is comfortably past any context window we can
    /// afford on the fast lane, and an over-long request is not a worse
    /// suggestion, it is a rejected request and no suggestion at all. So a long
    /// transcript is sent as its head and its tail with the middle elided,
    /// rather than truncated: the opening frames what the meeting is and who is
    /// in it, the close carries the decision and the next step. The split
    /// (two thirds to the head) and the limit come from `FilingPrompt`.
    ///
    /// Counted in Unicode code points (`unicodeScalars`), not grapheme
    /// clusters: that is what a JavaScript `Array.from` and a Kotlin
    /// `codePointCount` count, so all three platforms cut the same transcript
    /// at the same place.
    static func capped(_ transcript: String) -> String {
        let scalars = Array(transcript.unicodeScalars)
        let limit = FilingPrompt.maxTranscriptCharacters
        guard scalars.count > limit else { return transcript }
        let head = limit * FilingPrompt.headShareNumerator / FilingPrompt.headShareDenominator
        let tail = limit - head
        var out = String.UnicodeScalarView()
        out.append(contentsOf: scalars[0..<head])
        var end = String.UnicodeScalarView()
        end.append(contentsOf: scalars[(scalars.count - tail)...])
        return String(out) + FilingPrompt.elisionMarker + String(end)
    }

    // MARK: what came back

    /// One folder as the model wrote it, before any of the product's rules have
    /// been applied to it. `isNew` and `reason` default rather than fail the
    /// whole parse: a row missing a field still names a folder, and dropping the
    /// entire suggestion over a missing boolean would be a poor trade.
    public struct RawFolder: Decodable {
        public let name: String
        public let isNew: Bool
        public let reason: String

        public init(name: String, isNew: Bool, reason: String) {
            self.name = name
            self.isNew = isNew
            self.reason = reason
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            name = (try? c.decode(String.self, forKey: .name)) ?? ""
            isNew = (try? c.decode(Bool.self, forKey: .isNew)) ?? false
            reason = (try? c.decode(String.self, forKey: .reason)) ?? ""
        }

        enum CodingKeys: String, CodingKey { case name, isNew, reason }
    }

    /// The whole object as the model wrote it.
    struct RawSuggestion: Decodable {
        let title: String
        let folders: [RawFolder]

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            title = (try? c.decode(String.self, forKey: .title)) ?? ""
            folders = (try? c.decode([RawFolder].self, forKey: .folders)) ?? []
        }

        enum CodingKeys: String, CodingKey { case title, folders }
    }

    /// Decode the answer, forgiving the packaging.
    ///
    /// Asking for JSON in words gets JSON most of the time and JSON in a ```
    /// fence, or after a line of "Sure, here's the suggestion:", the rest of the
    /// time. None of that is a reason to throw away a good suggestion, so the
    /// first balanced object in the reply is what gets decoded. A reply with no
    /// object in it at all is `nil` — the caller's cue to leave the recording
    /// alone.
    static func parse(_ content: String) -> RawSuggestion? {
        guard let json = firstJSONObject(in: content) else { return nil }
        return try? JSONDecoder().decode(RawSuggestion.self, from: Data(json.utf8))
    }

    /// The first balanced `{…}` in `s`, braces inside string literals ignored.
    /// Brace counting rather than a regex because a `reason` is free text and
    /// may well contain a brace of its own.
    static func firstJSONObject(in s: String) -> String? {
        guard let start = s.firstIndex(of: "{") else { return nil }
        var depth = 0
        var inString = false
        var escaped = false
        var i = start
        while i < s.endIndex {
            let c = s[i]
            if inString {
                if escaped {
                    escaped = false
                } else if c == "\\" {
                    escaped = true
                } else if c == "\"" {
                    inString = false
                }
            } else if c == "\"" {
                inString = true
            } else if c == "{" {
                depth += 1
            } else if c == "}" {
                depth -= 1
                if depth == 0 { return String(s[start...i]) }
            }
            i = s.index(after: i)
        }
        // Unbalanced: a truncated answer, or a stray brace in a preamble. Either
        // way there is no object here to trust.
        return nil
    }

    // MARK: what we are willing to show

    /// Whether `candidate` is a title we are willing to put in front of the
    /// user. The same discipline as `TranscriptPolisher.accept`: the model is
    /// not trusted to have followed the prompt. Rejected: empty, longer than
    /// `FilingPrompt.maxTitleCharacters` code points, identical to the current
    /// title, or a newly introduced Simplified script.
    ///
    /// `transcript` is not read for content — only to answer "was this
    /// conversation already in Simplified Chinese", so that a user whose
    /// meeting was conducted in Simplified is not handed a rejection for a title
    /// that matches what was said.
    public static func acceptTitle(
        _ candidate: String, currentTitle: String, transcript: String
    ) -> Bool {
        let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        // Code points, like the transcript cap, so the three platforms agree on
        // where "too long" starts. A title longer than this is not a title: it
        // is a model that answered with a sentence, or with the summary.
        guard trimmed.unicodeScalars.count <= FilingPrompt.maxTitleCharacters else { return false }
        // The model handing back the name the recording already has is it
        // following the "return it UNCHANGED" rule — there is nothing to offer.
        guard trimmed != currentTitle.trimmingCharacters(in: .whitespacesAndNewlines) else {
            return false
        }

        // Simplified drift: renaming a Traditional Chinese meeting into
        // Simplified is the failure that looks like success — the suggestion
        // reads fine and the user accepts it before noticing the script
        // changed. Judged per character against the shared list
        // (`FilingPrompt.simplifiedOnlyChars`, the same rule the desktop and
        // Android apply): a Simplified-only character is rejected unless the
        // current title or the transcript as sent already contains that very
        // character — a meeting conducted in Simplified keeps its own script,
        // and nothing else is let in with it.
        if introducesSimplified(trimmed, currentTitle: currentTitle, transcript: transcript) {
            return false
        }
        return true
    }

    /// The shared Simplified-only characters, as a set of code points.
    static let simplifiedOnly = Set(FilingPrompt.simplifiedOnlyChars.unicodeScalars)

    /// Whether `title` carries a Simplified-only character that neither the
    /// current title nor the transcript (as sent, after capping) contains.
    static func introducesSimplified(_ title: String, currentTitle: String, transcript: String)
        -> Bool
    {
        let candidates = Set(title.unicodeScalars).intersection(simplifiedOnly)
        guard !candidates.isEmpty else { return false }
        let seen = Set(currentTitle.unicodeScalars).union(transcript.unicodeScalars)
        return !candidates.isSubset(of: seen)
    }

    /// Turn the model's raw folder picks into suggestions the UI can act on.
    ///
    /// Pure and public because this is where the product's rules actually live:
    /// the model is asked for the same constraints in the prompt, but a filing
    /// suggestion that quietly creates three folders (or five) is worse than no
    /// suggestion at all, so nothing here trusts the model to have complied.
    /// A faithful port of the desktop's `resolveFilingFolders`
    /// (`src/lib/ai/filing.ts`).
    public static func resolveFolders(
        _ raw: [RawFolder], folders: [CloudFolder]
    ) -> [FilingFolderSuggestion] {
        let byName = indexByName(personal(folders))
        var out: [FilingFolderSuggestion] = []
        var seenIds = Set<String>()
        var newTaken = false

        for entry in raw {
            // Cap at 3. The model returns best-first, so truncating the tail
            // drops its weakest picks; the UI has room for three chips.
            if out.count >= 3 { break }

            let name = entry.name.trimmingCharacters(in: .whitespacesAndNewlines)
            // A blank name names no folder. Half-finished and hallucinated rows
            // both land here, and there is nothing to file into either way.
            if name.isEmpty { continue }

            let reason = entry.reason.trimmingCharacters(in: .whitespacesAndNewlines)

            if let match = byName[name.lowercased()] {
                // isNew is deliberately ignored when a real folder matches: the
                // model claiming "new" about a folder that already exists is a
                // model error, not the user asking for a duplicate. Filing into
                // the existing one is always what was meant.
                if seenIds.contains(match.id) { continue }  // one entry per folder — repeats are noise
                seenIds.insert(match.id)
                // The registry's spelling wins, so the chip reads exactly like
                // the folder the user already knows.
                out.append(
                    FilingFolderSuggestion(folderId: match.id, name: match.name, reason: reason))
                continue
            }

            // Unmatched → a folder that would have to be created. Only the FIRST
            // one survives: a new folder per meeting would explode the registry,
            // and the model orders best-first, so the first is the one worth
            // offering. (This also subsumes de-duping new suggestions by name —
            // a second one is dropped whether or not it repeats the first.)
            if newTaken { continue }
            newTaken = true
            out.append(FilingFolderSuggestion(folderId: nil, name: name, reason: reason))
        }

        return out
    }

    /// Index the folder registry by trimmed, lowercased name. Models re-type
    /// folder names rather than copying them, and "Acme Corp" vs "acme corp " is
    /// the model being sloppy about spelling, not the user wanting a second
    /// folder. First occurrence wins, so two folders sharing a name resolve to
    /// the older one.
    static func indexByName(_ folders: [CloudFolder]) -> [String: CloudFolder] {
        var byName: [String: CloudFolder] = [:]
        for folder in folders {
            let key = folder.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if key.isEmpty || byName[key] != nil { continue }
            byName[key] = folder
        }
        return byName
    }
}
