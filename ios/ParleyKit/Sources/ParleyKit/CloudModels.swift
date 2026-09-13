import Foundation

/// DTOs for the Parley cloud (`api.parley.tw`). Field names mirror the
/// desktop's `src/lib/cloud/types.ts` — camelCase JSON, epoch-ms numbers.

public struct CloudUser: Codable, Equatable, Sendable {
    public let id: String
    public let name: String?
    public let email: String
    public let image: String?

    public init(id: String, name: String?, email: String, image: String?) {
        self.id = id
        self.name = name
        self.email = email
        self.image = image
    }
}

public struct CloudRecordingSummary: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public var title: String
    public let source: String  // "live" | "upload"
    public let createdAt: Double
    public let durationMs: Double
    public let speakerCount: Int?
    public let findingsCount: Int?
    public let actionItemsCount: Int?
    public let hasAudio: Bool
    public let snippet: String?
    public var folderId: String?
    /// Server push time (epoch ms) — last-writer-wins ordering across devices.
    public let updatedAt: Double?

    public init(
        id: String, title: String, source: String, createdAt: Double, durationMs: Double,
        speakerCount: Int?, findingsCount: Int?, actionItemsCount: Int?, hasAudio: Bool,
        snippet: String?, folderId: String?, updatedAt: Double?
    ) {
        self.id = id
        self.title = title
        self.source = source
        self.createdAt = createdAt
        self.durationMs = durationMs
        self.speakerCount = speakerCount
        self.findingsCount = findingsCount
        self.actionItemsCount = actionItemsCount
        self.hasAudio = hasAudio
        self.snippet = snippet
        self.folderId = folderId
        self.updatedAt = updatedAt
    }
}

public struct CloudFolder: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public var name: String
    public let orgId: String?
    public let createdAt: Double?
    public let updatedAt: Double?

    public init(
        id: String, name: String, orgId: String?, createdAt: Double?, updatedAt: Double?
    ) {
        self.id = id
        self.name = name
        self.orgId = orgId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct CloudOrg: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let slug: String?
    /// Present only from `/orgs/mine` (better-auth's own list drops it).
    public let role: String?

    public init(id: String, name: String, slug: String?, role: String?) {
        self.id = id
        self.name = name
        self.slug = slug
        self.role = role
    }
}

public struct HostedQuota: Codable, Equatable, Sendable {
    public let plan: String?
    public let sttSecondsUsed: Double?
    public let sttSecondsLimit: Double?
    public let llmCreditsUsed: Double?
    public let llmCreditsLimit: Double?
    public let periodResetTs: Double?

    public init(
        plan: String?, sttSecondsUsed: Double?, sttSecondsLimit: Double?,
        llmCreditsUsed: Double?, llmCreditsLimit: Double?, periodResetTs: Double?
    ) {
        self.plan = plan
        self.sttSecondsUsed = sttSecondsUsed
        self.sttSecondsLimit = sttSecondsLimit
        self.llmCreditsUsed = llmCreditsUsed
        self.llmCreditsLimit = llmCreditsLimit
        self.periodResetTs = periodResetTs
    }
}

/// Transcript-bearing recording meta — the subset of the desktop's
/// `HistoryEntry` the phone renders. Unknown fields are preserved on
/// round-trip via `raw` so a phone-side folder move can re-push the meta
/// without dropping desktop-only analysis (brief, intel, delivery …).
public struct RecordingMeta: @unchecked Sendable {
    /// The full HistoryEntry JSON. Kept as a dictionary (not typed Codable) so
    /// desktop-only fields survive a phone-side round-trip untouched; treated
    /// as immutable-after-decode, hence the @unchecked Sendable.
    public var raw: [String: Any]

    public init(raw: [String: Any]) { self.raw = raw }

    public var id: String { raw["id"] as? String ?? "" }
    public var title: String {
        get { raw["title"] as? String ?? "" }
        set { raw["title"] = newValue }
    }
    public var createdAt: Double { raw["createdAt"] as? Double ?? 0 }
    public var durationMs: Double { raw["durationMs"] as? Double ?? 0 }
    public var speakerNames: [String: String] { raw["speakerNames"] as? [String: String] ?? [:] }
    public var folderId: String? {
        get { raw["folderId"] as? String }
        set { raw["folderId"] = newValue as Any? ?? NSNull() }
    }

    /// True once the filing pass has COMPLETED for this recording, whichever
    /// device ran it.
    ///
    /// This is not bookkeeping for the phone's own benefit: the desktop reads
    /// the same flag off the same synced meta to decide whether to spend its
    /// filing pass on a recording (`HistoryEntry.filingSuggested`,
    /// `src/lib/history/types.ts`). A `null` suggestion cannot tell "never ran"
    /// apart from "ran, and the user has already dealt with it", so without this
    /// the Mac would ask again about a recording the user renamed and filed on
    /// their phone — and would spend a second pass to do it.
    public var filingSuggested: Bool {
        get { raw["filingSuggested"] as? Bool ?? false }
        set { raw["filingSuggested"] = newValue }
    }

    public var segments: [TranscriptSegment] {
        guard let arr = raw["segments"] as? [[String: Any]] else { return [] }
        return arr.compactMap { s in
            guard let id = s["id"] as? String, let text = s["text"] as? String else { return nil }
            return TranscriptSegment(
                id: id,
                source: s["source"] as? String ?? "mix",
                speaker: s["speaker"] as? Int ?? 0,
                text: text,
                isFinal: s["isFinal"] as? Bool ?? true,
                startMs: UInt64(s["startMs"] as? Double ?? 0),
                endMs: UInt64(s["endMs"] as? Double ?? 0))
        }
    }

    /// The desktop's speaker label rules (`defaultSpeakerLabel`, store.ts):
    /// user names override; `mix` falls back to 「講者 A」/ "Speaker A".
    ///
    /// The fallbacks are display text, so they come out of this package's own
    /// catalog (`Resources/Localizable.xcstrings`) rather than as literals —
    /// a Chinese phone was reading "Speaker 1" over Chinese transcript lines.
    /// The filled-in forms are `%@` / `%lld` format strings applied afterwards,
    /// not interpolated into the lookup key: `"Speaker \(n)"` as a key would be
    /// a different, untranslatable key for every speaker index.
    public func speakerLabel(for seg: TranscriptSegment) -> String {
        Self.speakerLabel(for: seg, names: speakerNames)
    }

    /// The same rules for a caller that holds the name map without the rest of
    /// the meta — the filing pass renders a transcript for the model out of
    /// segments alone. Kept as the one implementation so a label the user reads
    /// on screen and a label the model reads in the prompt can never disagree
    /// about who was speaking.
    static func speakerLabel(for seg: TranscriptSegment, names: [String: String]) -> String {
        let key = "\(seg.source)-\(seg.speaker)"
        if let name = names[key], !name.isEmpty { return name }
        switch seg.source {
        case "me":
            return seg.speaker <= 1
                ? String(localized: "You", bundle: .module)
                : numbered("You %lld", seg.speaker)
        case "them":
            return seg.speaker <= 1
                ? String(localized: "Them", bundle: .module)
                : numbered("Remote %lld", seg.speaker)
        default:
            // Letters, not indices — see `speakerLetter`. An index of 0 means
            // the provider has not decided who is talking, and an ellipsis
            // admits that where 「講者 A」 would quietly invent a person. The
            // live screen has always shown exactly this.
            let letter = speakerLetter(seg.speaker)
            guard !letter.isEmpty else { return "…" }
            return String(
                format: String(localized: "Speaker %@", bundle: .module), letter)
        }
    }

    private static func numbered(_ key: String.LocalizationValue, _ n: Int) -> String {
        String(format: String(localized: key, bundle: .module), n)
    }

    /// One line of the whole-recording analysis (`TimelineEvent`, types.ts). The
    /// phone reads a recording rather than analysing one, so only the three
    /// fields it can show are lifted out of `raw`.
    public struct Finding: Identifiable, Sendable {
        public let id: String
        /// Moment on the recording timeline.
        public let atMs: UInt64
        public let title: String
        public let detail: String
    }

    /// The findings the desktop's analysis left on this recording, in timeline
    /// order. Empty when the recording has not been analysed.
    public var findings: [Finding] {
        guard let arr = raw["findings"] as? [[String: Any]] else { return [] }
        return arr.enumerated().compactMap { index, f in
            guard let title = f["title"] as? String, !title.isEmpty else { return nil }
            return Finding(
                id: f["id"] as? String ?? "finding-\(index)",
                atMs: UInt64(max(0, f["atMs"] as? Double ?? 0)),
                title: title,
                detail: f["detail"] as? String ?? "")
        }
        .sorted { $0.atMs < $1.atMs }
    }
}

// MARK: replacing a transcript in place

extension RecordingMeta {
    /// The wire shape `segments` takes inside a `HistoryEntry` — the inverse of
    /// the `segments` getter above, and the only place either queue writes it.
    /// `isFinal` is always true: nothing tentative is ever persisted.
    public static func encode(_ segments: [TranscriptSegment]) -> [[String: Any]] {
        segments.map { segment in
            [
                "id": segment.id, "source": segment.source, "speaker": segment.speaker,
                "text": segment.text, "isFinal": true,
                "startMs": Double(segment.startMs), "endMs": Double(segment.endMs),
            ] as [String: Any]
        }
    }

    /// Swap in a transcript produced by a later, better pass over the same
    /// audio, and change nothing else.
    ///
    /// Surgical on purpose. A re-transcription of a recording that has been
    /// around for a while is not a fresh upload: the entry may carry speaker
    /// names somebody typed, findings and action items from a desktop analysis,
    /// a brief, meeting context, a filing decision. Rebuilding the meta from
    /// the new transcript would be correct about the words and would silently
    /// throw all of that away — a far worse outcome than the thin transcript
    /// the person was trying to fix.
    ///
    /// `speakerNames` is the one field this arguably *should* clear, since a
    /// second diarization pass can number the speakers differently. It is kept
    /// anyway: a name attached to the wrong turn is visible and fixable in
    /// seconds, and a name the user typed and then lost is neither.
    ///
    /// The duration is taken as whichever is longer, matching the queue's own
    /// reconciliation — a batch job's reported length can undershoot what the
    /// recording already knew about itself.
    public mutating func replaceTranscript(segments: [TranscriptSegment], durationMs: Double) {
        raw["segments"] = Self.encode(segments)
        raw["durationMs"] = max(durationMs, self.durationMs)
    }
}

extension CloudRecordingSummary {
    /// How many people the transcript accounts for. A transcript with turns in
    /// it always has at least one speaker, even when every turn came back
    /// unattributed.
    public static func speakerCount(of segments: [TranscriptSegment]) -> Int {
        let distinct = Set(segments.map { "\($0.source)-\($0.speaker)" }).count
        return max(distinct, segments.isEmpty ? 0 : 1)
    }

    /// The library row's preview line: the opening of the conversation, capped
    /// so a list request does not carry whole meetings.
    public static func snippet(of segments: [TranscriptSegment]) -> String {
        String(segments.prefix(3).map(\.text).joined(separator: " ").prefix(120))
    }

    /// The same summary, re-derived for a transcript that replaced the one it
    /// was built from.
    ///
    /// Only the three facts the transcript actually speaks for move: the
    /// speaker count, the preview line, and the duration. The title, the
    /// folder, and the analysis counts are somebody else's facts about this
    /// recording and survive a re-transcription untouched; `hasAudio` stays as
    /// it was because the audio in the cloud is the very file that was
    /// re-transcribed.
    public func replacingTranscript(segments: [TranscriptSegment], durationMs: Double)
        -> CloudRecordingSummary
    {
        CloudRecordingSummary(
            id: id, title: title, source: source, createdAt: createdAt,
            durationMs: max(durationMs, self.durationMs),
            speakerCount: Self.speakerCount(of: segments),
            findingsCount: findingsCount, actionItemsCount: actionItemsCount,
            hasAudio: hasAudio, snippet: Self.snippet(of: segments),
            folderId: folderId, updatedAt: updatedAt)
    }
}
