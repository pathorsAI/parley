import Foundation

/// DTOs for the Parley cloud (`api.parley.tw`). Field names mirror the
/// desktop's `src/lib/cloud/types.ts` — camelCase JSON, epoch-ms numbers.

public struct CloudUser: Codable, Equatable, Sendable {
    public let id: String
    public let name: String?
    public let email: String
    public let image: String?
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
}

public struct CloudOrg: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let slug: String?
    /// Present only from `/orgs/mine` (better-auth's own list drops it).
    public let role: String?
}

public struct HostedQuota: Codable, Equatable, Sendable {
    public let plan: String?
    public let sttSecondsUsed: Double?
    public let sttSecondsLimit: Double?
    public let llmCreditsUsed: Double?
    public let llmCreditsLimit: Double?
    public let periodResetTs: Double?
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
    public var title: String { raw["title"] as? String ?? "" }
    public var createdAt: Double { raw["createdAt"] as? Double ?? 0 }
    public var durationMs: Double { raw["durationMs"] as? Double ?? 0 }
    public var speakerNames: [String: String] { raw["speakerNames"] as? [String: String] ?? [:] }
    public var folderId: String? {
        get { raw["folderId"] as? String }
        set { raw["folderId"] = newValue as Any? ?? NSNull() }
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
    /// user names override; `mix` falls back to "Speaker N".
    public func speakerLabel(for seg: TranscriptSegment) -> String {
        let key = "\(seg.source)-\(seg.speaker)"
        if let name = speakerNames[key], !name.isEmpty { return name }
        switch seg.source {
        case "me": return seg.speaker <= 1 ? "You" : "You \(seg.speaker)"
        case "them": return seg.speaker <= 1 ? "Them" : "Remote \(seg.speaker)"
        default: return "Speaker \(seg.speaker)"
        }
    }
}
