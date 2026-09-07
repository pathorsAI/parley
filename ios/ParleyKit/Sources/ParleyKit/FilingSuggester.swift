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
    /// The same alias the dictation rewrite uses. This is one short label off an
    /// already-transcribed conversation, not an analysis, so it rides the cheap
    /// fast lane — exactly as the desktop puts it on the "realtime" workload.
    static let model = "parley-fast"

    /// The standing instruction, kept word-for-word in sync with the desktop's
    /// `SYSTEM` (`src/lib/ai/filing.ts`): both platforms file the same person's
    /// recordings into the same folder registry, and drift between them shows
    /// up as the phone and the Mac disagreeing about where a meeting belongs.
    static let filingRules = """
        Given a finished meeting transcript, decide what the recording should be CALLED and where it should be FILED. Both doors into a recording name it badly — a live meeting arrives as "即時會議 · <date>" and an upload arrives as its file name — so this is usually the first honest title the recording gets.

        TITLE
        - Say what the meeting was ABOUT and, where it is clear, WITH WHOM: a company or a person plus the topic or the decision reached.
        - No date and no time. The library card already shows those, so spending the title on them wastes the only line the user reads.
        - No filler as the subject: "meeting", "recording", "call", "討論" and the like describe every recording in the library and therefore identify none of them. A title that would fit any meeting is a failed title.
        - Keep it short — roughly 10-24 characters of CJK, or about 4-8 English words.
        - If the current title is already specific and accurate, return it UNCHANGED. Churn for its own sake makes the library harder to trust, not easier.

        FOLDERS
        - The user's existing folders are listed below. Strongly prefer them. One folder is typically one customer/company or one ongoing workstream, so ask which of those this conversation belongs to.
        - Return 2-3 candidates ordered best-first. If only one is genuinely defensible, return one — a padded list is worse than a short one.
        - Copy an existing folder's name EXACTLY (character for character) when you mean that folder, and set isNew to false.
        - AT MOST ONE candidate may be a folder that does not exist yet (isNew: true), and only when no existing folder honestly fits. A new folder per meeting would grow the registry faster than the user can prune it.
        - reason is ONE short clause saying why the folder fits — it is shown as a tooltip, not read as prose.
        """

    /// The desktop gets its JSON out of the provider's schema-constrained JSON
    /// mode; here the shape has to be asked for in words.
    ///
    /// Deliberately NOT an OpenAI `response_format` parameter: we have not
    /// verified that the worker in front of the model passes it through, and a
    /// request rejected for an unknown field costs the whole pass — while a
    /// model that answers in prose costs nothing, because `parse` shrugs and
    /// the recording keeps its name. `resolveFolders` has to survive a
    /// disobedient model anyway, so the constraints are stated here and
    /// ENFORCED there.
    static let jsonInstruction = """


        Return your answer strictly as a single JSON object and nothing else — no preamble, no explanation, no code fences. Use these property names EXACTLY (verbatim): {"title": string, "folders": [{"name": string, "isNew": boolean, "reason": string}]}.
        """

    static var systemPrompt: String { filingRules + jsonInstruction }

    /// A title longer than this is not a title. The prompt asks for 4-8 English
    /// words or 10-24 CJK characters; the cap is loose enough to let a long but
    /// honest title through and tight enough to catch the failure this gate is
    /// really for — a model that answered with a sentence, or with the meeting's
    /// summary, where a label was asked for. The library shows one line.
    static let maximumTitleCharacters = 80

    /// How much transcript travels with the request.
    ///
    /// The dictation rewrite this pass is modelled on never had to think about
    /// length: dictation is capped at 120 s. A meeting is not — an hour of
    /// conversation is comfortably past any context window we can afford on the
    /// fast lane, and an over-long request is not a worse suggestion, it is a
    /// rejected request and no suggestion at all.
    ///
    /// So a long transcript is sent as its head and its tail with the middle
    /// elided, rather than truncated. Truncation keeps the opening — which
    /// frames what the meeting is and who is in it, and is most of what the
    /// title needs — but throws away the close, which is where the decision, the
    /// next step and the customer's name-drop usually are. Both ends earn their
    /// place; the middle is the part a title can most afford to lose.
    static let maximumTranscriptCharacters = 24_000

    /// Marked, not silent: the model should know it is reading an excerpt so it
    /// does not conclude the meeting simply stopped mid-sentence.
    static let elisionMarker = "\n\n[… transcript trimmed …]\n\n"

    // MARK: the call

    /// Ask for a title and 2-3 folders for a finished recording.
    ///
    /// Returns `nil` when there is nothing to read, when the answer could not be
    /// parsed, or when nothing in it survived the gates — the caller keeps the
    /// current title and leaves the recording where it is. Throws only on
    /// transport/HTTP failure, which means the same thing to the caller.
    public static func suggest(
        segments: [TranscriptSegment],
        speakerNames: [String: String],
        currentTitle: String,
        folders: [CloudFolder],
        cloud: CloudClient
    ) async throws -> FilingSuggestion? {
        let transcript = transcript(segments, speakerNames: speakerNames)
        guard !transcript.isEmpty else { return nil }
        let excerpt = capped(transcript)

        let body = try JSONEncoder().encode(
            CloudChat.Request(
                model: model,
                temperature: 0.2,
                maxTokens: 512,
                messages: [
                    .init(role: "system", content: systemPrompt),
                    .init(
                        role: "user",
                        content: userMessage(
                            currentTitle: currentTitle, folders: folders, transcript: excerpt)),
                ]))
        let data = try await cloud.postJSON(CloudChat.path, body: body)
        guard let content = CloudChat.content(from: data), let payload = parse(content) else {
            return nil
        }

        let resolved = resolveFolders(payload.folders, folders: folders)
        let candidate = payload.title.trimmingCharacters(in: .whitespacesAndNewlines)
        // A title we will not use does not sink the folder suggestions with it:
        // the two halves of this pass fail independently, and half an answer is
        // still worth showing. Nothing left standing is the same as no answer.
        let title =
            acceptTitle(candidate, currentTitle: currentTitle, transcript: excerpt)
            ? candidate : ""
        if title.isEmpty, resolved.isEmpty { return nil }
        return FilingSuggestion(title: title, folders: resolved)
    }

    /// The context block, mirroring the desktop's prompt: what the recording is
    /// called now (so the model can decline to rename it), the menu of existing
    /// homes, then the conversation.
    static func userMessage(
        currentTitle: String, folders: [CloudFolder], transcript: String
    ) -> String {
        let named = currentTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        return "The recording is currently called: \(named.isEmpty ? "(untitled)" : named)\n\n"
            + folderMenu(folders)
            + "Transcript:\n\(transcript)"
    }

    /// Render the folder registry as the model's menu of existing homes.
    static func folderMenu(_ folders: [CloudFolder]) -> String {
        let names = personal(folders)
            .map { $0.name.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        if names.isEmpty {
            return "The user has NO folders yet, so every suggestion would have to be created — "
                + "return exactly ONE folder, with isNew: true.\n\n"
        }
        return "The user's existing folders:\n" + names.map { "- \($0)" }.joined(separator: "\n")
            + "\n\n"
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

    /// Head + tail, with the middle marked as removed. See
    /// `maximumTranscriptCharacters` for why the middle is the part that goes.
    static func capped(_ transcript: String) -> String {
        guard transcript.count > maximumTranscriptCharacters else { return transcript }
        // Two thirds to the opening, one third to the close: the opening has to
        // carry who is in the room and what this is, which is most of a title,
        // while the close only has to carry how it ended.
        let head = maximumTranscriptCharacters * 2 / 3
        let tail = maximumTranscriptCharacters - head
        return String(transcript.prefix(head)) + elisionMarker + String(transcript.suffix(tail))
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
    /// not trusted to have followed the prompt.
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
        guard trimmed.count <= maximumTitleCharacters else { return false }

        // Simplified drift: renaming a Traditional Chinese meeting into
        // Simplified is the failure that looks like success — the suggestion
        // reads fine and the user accepts it before noticing the script
        // changed. Only a NEWLY introduced simplified character counts.
        if TranscriptPolisher.containsSimplifiedChinese(trimmed),
            !TranscriptPolisher.containsSimplifiedChinese(currentTitle),
            !TranscriptPolisher.containsSimplifiedChinese(transcript)
        {
            return false
        }
        return true
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
