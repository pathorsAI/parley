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

/// A diarized speaker index as a letter: 1 → A, 26 → Z, 27 → AA, 28 → AB …
///
/// Speakers are named 「講者 A」/ "Speaker A" rather than "Speaker 1", because a
/// number reads as a count and invites arithmetic — people asked what happened
/// to speakers 1 and 2 when a two-person meeting came back diarized as 3 and 4.
/// A letter is plainly a label.
///
/// Bijective base-26, the spreadsheet-column scheme, so it never runs out and
/// never produces an empty string for a real speaker. `n <= 0` is not a speaker
/// at all — the provider has not decided yet — and returns "", which callers
/// render as an ellipsis rather than naming someone who may not exist.
public func speakerLetter(_ n: Int) -> String {
    guard n > 0 else { return "" }
    var remaining = n
    var letters = ""
    while remaining > 0 {
        let digit = (remaining - 1) % 26
        letters = String(UnicodeScalar(UInt8(65 + digit))) + letters
        remaining = (remaining - 1) / 26
    }
    return letters
}
