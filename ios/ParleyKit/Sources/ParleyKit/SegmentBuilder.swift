import Foundation

/// Accumulates finalized STT tokens into speaker-runs and emits committed
/// segments plus a tentative tail.
///
/// Faithful port of `SegmentBuilder` in the desktop's
/// `src-tauri/src/transcription/common.rs` — the semantics there are the
/// contract the whole transcript UI depends on:
/// 1. `pushFinal(text:speaker:startMs:endMs:)` for each settled token,
/// 2. `emitCommitted()` to surface the open run as solid text,
/// 3. `emitTail(text:speaker:startMs:)` for the tentative tail,
/// 4. `endpoint()` when the provider signals end-of-utterance.
///
/// A speaker change closes the open run (emitting it solid) and starts a new
/// one; speaker 0 never splits because non-diarizing input always reports 0.
///
/// One deliberate improvement over the Rust original: segments go to an
/// injected sink instead of a global event emitter, so the builder is pure and
/// unit-testable.
public final class SegmentBuilder {
    private let source: String
    private let sink: (TranscriptSegment) -> Void

    private var segIndex: UInt64 = 0
    /// Speaker of the open run, or nil when no run is open.
    private var curSpeaker: Int?
    private var curFinal = ""
    private var curStart: UInt64 = 0
    private var curEnd: UInt64 = 0

    public init(source: String, sink: @escaping (TranscriptSegment) -> Void) {
        self.source = source
        self.sink = sink
    }

    /// The current open run's speaker (0 if none open) — useful for tail labels.
    public var currentSpeaker: Int { curSpeaker ?? 0 }

    /// The end timestamp of the current open run — useful as a tail start.
    public var currentEnd: UInt64 { curEnd }

    /// Add a finalized token to the run. A speaker change closes the open run
    /// (emitting it solid) and starts a new one. Whitespace is preserved as the
    /// adapter supplies it.
    public func pushFinal(_ text: String, speaker: Int, startMs: UInt64, endMs: UInt64) {
        switch curSpeaker {
        case nil:
            curSpeaker = speaker
            curStart = startMs
        case let cur? where speaker != cur:
            if !curFinal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                commit()
            }
            curSpeaker = speaker
            curFinal = ""
            curStart = startMs
        default:
            break
        }
        curFinal += text
        curEnd = endMs
    }

    /// Emit the open run under a fresh segment id and advance the index.
    private func commit() {
        sink(
            TranscriptSegment(
                id: "\(source)-\(segIndex)", source: source, speaker: currentSpeaker,
                text: curFinal, isFinal: true, startMs: curStart, endMs: curEnd))
        segIndex += 1
    }

    /// Surface the current open run as solid (settled) text without advancing —
    /// it keeps growing under the same id until an endpoint or speaker change.
    public func emitCommitted() {
        guard !curFinal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        sink(
            TranscriptSegment(
                id: "\(source)-\(segIndex)", source: source, speaker: currentSpeaker,
                text: curFinal, isFinal: true, startMs: curStart, endMs: curEnd))
    }

    /// Emit the tentative tail under a stable `{source}-tail` id (empty text
    /// clears the previous tail in the UI).
    public func emitTail(_ text: String, speaker: Int, startMs: UInt64) {
        sink(
            TranscriptSegment(
                id: "\(source)-tail", source: source, speaker: speaker,
                text: text, isFinal: false, startMs: startMs, endMs: startMs))
    }

    /// End-of-utterance: commit the open run (if any) and reset for the next one.
    public func endpoint() {
        if !curFinal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            commit()
        }
        curSpeaker = nil
        curFinal = ""
    }
}
