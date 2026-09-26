import Foundation

/// The bundled sample recording's manifest — `public/sample/sample.<lang>.json`,
/// produced by `scripts/sample/render.ts` alongside the Ogg/Opus it describes.
///
/// The desktop reads the same files. Only the fields the phone uses are
/// decoded; anything else in the file (the render script's voices and rates,
/// the MCP questions the desktop shows) is ignored rather than required.
public struct SampleManifest: Decodable, Equatable, Sendable {
    public struct Speakers: Decodable, Equatable, Sendable {
        public let me: String
        public let them: String
    }

    public struct Segment: Decodable, Equatable, Sendable {
        /// `"me"` or `"them"`.
        public let speaker: String
        public let startMs: Double
        public let endMs: Double
        public let text: String
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

    /// A `RecordingMeta` shaped like a synced recording's, so the detail screen
    /// reads the sample through exactly the code a real recording goes through.
    public func meta(createdAt: Double, folderId: String?) -> RecordingMeta {
        var raw: [String: Any] = [
            "id": id,
            "title": title,
            "source": "upload",
            "createdAt": createdAt,
            "durationMs": durationMs,
            "segments": RecordingMeta.encode(transcriptSegments),
            "speakerNames": speakerNames,
            "meetingContext": context ?? "",
            "findings": [Any](),
            "actionItems": [Any](),
        ]
        if let meetingKind { raw["meetingKind"] = meetingKind }
        raw["folderId"] = folderId as Any? ?? NSNull()
        return RecordingMeta(raw: raw)
    }

    /// The Library row for the sample.
    public func summary(createdAt: Double, folderId: String?) -> CloudRecordingSummary {
        CloudRecordingSummary(
            id: id, title: title, source: "upload", createdAt: createdAt,
            durationMs: durationMs, speakerCount: 2, findingsCount: nil,
            actionItemsCount: nil, hasAudio: true, snippet: segments.first?.text,
            folderId: folderId, updatedAt: nil)
    }
}

extension RecordingMeta {
    /// The meeting's free-text context (`HistoryEntry.meetingContext`), if any.
    public var meetingContext: String {
        (raw["meetingContext"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
