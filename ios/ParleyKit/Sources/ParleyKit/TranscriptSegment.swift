import Foundation

/// One transcript segment, mirroring the desktop wire shape
/// (`TranscriptEvent` in `src-tauri/src/transcription/common.rs` and
/// `TranscriptSegment` in `src/lib/types.ts`).
///
/// Identity rules (the UI upserts by `id`):
/// - A committed run keeps re-emitting under the same `"{source}-{index}"` id
///   while it grows; the index advances only on endpoint/speaker change.
/// - The tentative tail always uses the stable `"{source}-tail"` id; an empty
///   `text` clears it.
public struct TranscriptSegment: Equatable, Sendable, Codable {
    public let id: String
    /// Capture source. On iOS this is always `"mix"` — a phone has one mic and
    /// speaker identity comes from provider diarization, exactly like the
    /// desktop's single-session diarizing topology.
    public let source: String
    /// Diarized speaker index within the source; 0 = unknown/single.
    public let speaker: Int
    public let text: String
    public let isFinal: Bool
    public let startMs: UInt64
    public let endMs: UInt64

    public init(
        id: String, source: String, speaker: Int, text: String,
        isFinal: Bool, startMs: UInt64, endMs: UInt64
    ) {
        self.id = id
        self.source = source
        self.speaker = speaker
        self.text = text
        self.isFinal = isFinal
        self.startMs = startMs
        self.endMs = endMs
    }
}
