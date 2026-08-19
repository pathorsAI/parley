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
    private let idPrefix: String
    private let timeOffsetMs: UInt64
    private let sink: (TranscriptSegment) -> Void

    private var segIndex: UInt64 = 0
    /// Speaker of the open run, or nil when no run is open.
    private var curSpeaker: Int?
    private var curFinal = ""
    private var curStart: UInt64 = 0
    private var curEnd: UInt64 = 0

    /// - Parameters:
    ///   - source: the audio source recorded on every segment (`"mix"` on a
    ///     phone) and the stem of the tail id. Speaker labels are built from
    ///     it, so it stays the same for a whole recording.
    ///   - idPrefix: the stem of *committed* segment ids, defaulting to
    ///     `source`. A recording that has to reopen its relay mid-meeting gives
    ///     each leg its own prefix, because the provider restarts its own
    ///     numbering at 0 and the second leg's `mix-0` would otherwise
    ///     overwrite the first minute of the transcript.
    ///   - timeOffsetMs: added to every timestamp, for the same reason: a
    ///     reconnected leg starts its clock at 0 and would sort itself back
    ///     into the beginning of the meeting.
    public init(
        source: String, idPrefix: String? = nil, timeOffsetMs: UInt64 = 0,
        sink: @escaping (TranscriptSegment) -> Void
    ) {
        self.source = source
        self.idPrefix = idPrefix ?? source
        self.timeOffsetMs = timeOffsetMs
        self.sink = sink
    }

    /// The current open run's speaker (0 if none open) — useful for tail labels.
    public var currentSpeaker: Int { curSpeaker ?? 0 }

    /// The end timestamp of the current open run — useful as a tail start.
    /// Reported in the builder's own (un-offset) clock, which is the clock
    /// `emitTail` expects back.
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
        emitOpenRun()
        segIndex += 1
    }

    /// Surface the current open run as solid (settled) text without advancing —
    /// it keeps growing under the same id until an endpoint or speaker change.
    public func emitCommitted() {
        guard !curFinal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        emitOpenRun()
    }

    private func emitOpenRun() {
        sink(
            TranscriptSegment(
                id: "\(idPrefix)-\(segIndex)", source: source, speaker: currentSpeaker,
                text: curFinal, isFinal: true,
                startMs: curStart + timeOffsetMs, endMs: curEnd + timeOffsetMs))
    }

    /// Emit the tentative tail under a stable `{source}-tail` id (empty text
    /// clears the previous tail in the UI). The id deliberately ignores
    /// `idPrefix`: there is only ever one tail on screen, and every `-tail`
    /// suffix check in the app and the cloud depends on this exact shape.
    public func emitTail(_ text: String, speaker: Int, startMs: UInt64) {
        sink(
            TranscriptSegment(
                id: "\(source)-tail", source: source, speaker: speaker,
                text: text, isFinal: false,
                startMs: startMs + timeOffsetMs, endMs: startMs + timeOffsetMs))
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
