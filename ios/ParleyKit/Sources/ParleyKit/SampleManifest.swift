import Foundation

/// The bundled sample recording's manifest — `public/sample/sample.<lang>.json`,
/// produced by `scripts/sample/render.ts` alongside the Ogg/Opus it describes.
///
/// The desktop reads the same files. Only the fields the phone uses are
/// decoded; anything else in the file (the render script's voices and rates,
/// the MCP questions the desktop shows) is ignored rather than required.
///
/// The analysis half — `suggestion`, `brief`, `findings`, `actionItems` — is
/// optional on the way in. A manifest rendered before those fields existed
/// still decodes, and the sample then simply opens on its transcript with no
/// suggestion card, exactly like an unanalysed recording would.
public struct SampleManifest: Codable, Equatable, Sendable {
    public struct Speakers: Codable, Equatable, Sendable {
        public let me: String
        public let them: String
    }

    public struct Segment: Codable, Equatable, Sendable {
        /// `"me"` or `"them"`.
        public let speaker: String
        public let startMs: Double
        public let endMs: Double
        public let text: String
    }

    /// The filing suggestion the script ships with: the title a filing pass
    /// would have proposed and the folder it would have proposed it for. The
    /// folder never exists yet — accepting it is what creates it.
    public struct Suggestion: Codable, Equatable, Sendable {
        public struct Folder: Codable, Equatable, Sendable {
            public let name: String
            public let reason: String
        }

        public let title: String
        public let folders: [Folder]
    }

    /// One finding of the pre-written analysis, the desktop's `TimelineEvent`
    /// minus the fields the phone does not draw.
    public struct Finding: Codable, Equatable, Sendable {
        public let atMs: Double
        /// `"me"` or `"them"`.
        public let side: String?
        /// `info`, `warn` or `critical`.
        public let severity: String?
        public let title: String
        public let detail: String?
        public let quotes: [String]?
    }

    public struct ActionItem: Codable, Equatable, Sendable {
        public let text: String
        public let atMs: Double?
    }

    /// Always starts with `sample-`, which is how the app tells a sample
    /// entry from a real recording.
    public let id: String
    /// `zh-TW` or `en`.
    public let lang: String
    public let title: String
    /// The Ogg/Opus file's name, next to the manifest.
    public let audio: String
    public let durationMs: Double
    public let meetingKind: String?
    public let context: String?
    public let speakers: Speakers
    public let segments: [Segment]
    /// The analysis questions the hand-off prompt asks about this meeting,
    /// written for this script rather than the generic three.
    public let questions: [String]
    public let suggestion: Suggestion?
    /// Markdown-lite: `**bold**` and `[m:ss]` timestamps. See `BriefMarkup`.
    public let brief: String?
    public let findings: [Finding]
    public let actionItems: [ActionItem]

    private enum CodingKeys: String, CodingKey {
        case id, lang, title, audio, durationMs, meetingKind, context, speakers, segments
        case questions, suggestion, brief, findings, actionItems
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        lang = try c.decode(String.self, forKey: .lang)
        title = try c.decode(String.self, forKey: .title)
        audio = try c.decode(String.self, forKey: .audio)
        durationMs = try c.decode(Double.self, forKey: .durationMs)
        meetingKind = try c.decodeIfPresent(String.self, forKey: .meetingKind)
        context = try c.decodeIfPresent(String.self, forKey: .context)
        speakers = try c.decode(Speakers.self, forKey: .speakers)
        segments = try c.decode([Segment].self, forKey: .segments)
        questions = try c.decodeIfPresent([String].self, forKey: .questions) ?? []
        suggestion = try c.decodeIfPresent(Suggestion.self, forKey: .suggestion)
        brief = try c.decodeIfPresent(String.self, forKey: .brief)
        findings = try c.decodeIfPresent([Finding].self, forKey: .findings) ?? []
        actionItems = try c.decodeIfPresent([ActionItem].self, forKey: .actionItems) ?? []
    }

    public static let idPrefix = "sample-"

    public static func isSample(id: String) -> Bool { id.hasPrefix(idPrefix) }

    public static func decode(_ data: Data) throws -> SampleManifest {
        try JSONDecoder().decode(SampleManifest.self, from: data)
    }

    /// The segments as the transcript screens read them: `me` is speaker 1 and
    /// `them` speaker 2 — distinct indices, because the detail screen counts
    /// speakers by index — and `RecordingMeta.speakerLabel` finds the names
    /// under `me-1` / `them-2` (see `speakerNames`).
    public var transcriptSegments: [TranscriptSegment] {
        segments.enumerated().map { index, seg in
            let isMe = seg.speaker == "me"
            let source = isMe ? "me" : "them"
            return TranscriptSegment(
                id: "\(source)-\(index)", source: source, speaker: isMe ? 1 : 2, text: seg.text,
                isFinal: true, startMs: UInt64(max(0, seg.startMs)),
                endMs: UInt64(max(0, seg.endMs)))
        }
    }

    /// The names keyed the way a synced `HistoryEntry` keys them.
    public var speakerNames: [String: String] {
        ["me-1": speakers.me, "them-2": speakers.them]
    }

    /// The id an action item gets in the sample's meta, so its done state can
    /// be kept by id on the phone. Positional, which is safe because the list
    /// is read from the bundle and never edited.
    public static func actionItemID(_ index: Int) -> String { "sample-action-\(index)" }

    /// A `RecordingMeta` shaped like a synced recording's, so the detail screen
    /// reads the sample through exactly the code a real recording goes through
    /// — the analysis included, in the desktop's field names.
    ///
    /// - Parameters:
    ///   - title: the user's rename, if any. The manifest's own title otherwise.
    ///   - doneActionItems: ids (`actionItemID`) the user has ticked.
    ///   - suggestionPending: whether the filing suggestion is still waiting on
    ///     the user. Answered, it is `null`, the way the desktop clears it.
    public func meta(
        createdAt: Double, folderId: String?, title: String? = nil,
        doneActionItems: Set<String> = [], suggestionPending: Bool = false
    ) -> RecordingMeta {
        var raw: [String: Any] = [
            "id": id,
            "title": title ?? self.title,
            "source": "upload",
            "createdAt": createdAt,
            "durationMs": durationMs,
            "segments": RecordingMeta.encode(transcriptSegments),
            "speakerNames": speakerNames,
            "meetingContext": context ?? "",
            "findings": findings.enumerated().map { index, finding -> [String: Any] in
                [
                    "id": "sample-finding-\(index)",
                    "atMs": finding.atMs,
                    "side": finding.side ?? "them",
                    "severity": finding.severity ?? "info",
                    "title": finding.title,
                    "detail": finding.detail ?? "",
                    "quotes": finding.quotes ?? [],
                ]
            },
            "actionItems": actionItems.enumerated().map { index, item -> [String: Any] in
                let itemID = Self.actionItemID(index)
                return [
                    "id": itemID,
                    "text": item.text,
                    "done": doneActionItems.contains(itemID),
                    "linkedEventId": NSNull(),
                    "atMs": item.atMs.map { $0 as Any } ?? NSNull(),
                ]
            },
            "filingSuggested": true,
        ]
        if let brief, !brief.isEmpty { raw["brief"] = brief }
        if let meetingKind { raw["meetingKind"] = meetingKind }
        raw["folderId"] = folderId as Any? ?? NSNull()
        var meta = RecordingMeta(raw: raw)
        meta.filingSuggestion = suggestionPending ? filingSuggestion(existingFolders: []) : nil
        return meta
    }

    /// The filing suggestion as the card offers it: the script's proposed title,
    /// its new folder, and — so the card is not a single take-it-or-leave-it
    /// chip — up to two of the folders the user already works in, most recently
    /// used first. Never more than three.
    ///
    /// A proposed folder whose name the user already has (their own customer
    /// called 泓昇科技, say) points at that folder instead of proposing a second
    /// one under the same name.
    public func filingSuggestion(existingFolders: [CloudFolder]) -> FilingSuggestion? {
        guard let suggestion else { return nil }
        let personal = existingFolders.filter { $0.orgId == nil }
        var chips: [FilingFolderSuggestion] = suggestion.folders.prefix(1).map { folder in
            FilingFolderSuggestion(
                folderId: FolderSearch.exactMatch(personal, query: folder.name)?.id,
                name: folder.name, reason: folder.reason)
        }
        let taken = Set(chips.compactMap(\.folderId))
        let recent = personal
            .filter { !taken.contains($0.id) }
            .sorted { ($0.updatedAt ?? $0.createdAt ?? 0) > ($1.updatedAt ?? $1.createdAt ?? 0) }
        let room = min(2, max(0, 3 - chips.count))
        for folder in recent.prefix(room) {
            chips.append(FilingFolderSuggestion(folderId: folder.id, name: folder.name, reason: ""))
        }
        return FilingSuggestion(title: suggestion.title, folders: chips)
    }

    /// The Library row for the sample.
    public func summary(
        createdAt: Double, folderId: String?, title: String? = nil
    ) -> CloudRecordingSummary {
        CloudRecordingSummary(
            id: id, title: title ?? self.title, source: "upload", createdAt: createdAt,
            durationMs: durationMs, speakerCount: 2, findingsCount: findings.count,
            actionItemsCount: actionItems.count, hasAudio: true, snippet: segments.first?.text,
            folderId: folderId, updatedAt: nil)
    }
}

extension RecordingMeta {
    /// The meeting's free-text context (`HistoryEntry.meetingContext`), if any.
    public var meetingContext: String {
        (raw["meetingContext"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
