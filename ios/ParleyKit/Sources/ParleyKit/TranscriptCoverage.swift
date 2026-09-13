import Foundation

/// How much of a recording the transcript actually accounts for, and whether
/// that is little enough to be worth transcribing the audio again.
///
/// ## Why this measures what came back, not what was sent
///
/// The obvious place to count coverage is the send side: `RelayAudioBridge`
/// already knows every sample it ever handed to a leg, so it could record the
/// spans it delivered and the spans it held. That measurement is wrong for the
/// failure it most needs to catch.
///
/// A relay socket can go half-open — the peer is gone, but nothing errors and
/// nothing closes, so `SttRelayClient` keeps accepting chunks and the bridge
/// keeps believing it has a live sink. Send-side accounting would mark that
/// entire stretch **covered** while not one word of it was ever transcribed.
/// The silent death is precisely the case a send-side measure cannot see.
///
/// So coverage is derived from the committed segments: the union of the spans
/// they occupy, against the duration of the audio on disk. A leg that died
/// without saying so leaves a hole here no matter how convincingly the socket
/// pretended.
///
/// ## Silence reads as a gap, on purpose
///
/// Nothing here distinguishes "the relay was dead" from "nobody was talking".
/// A five-minute pause looks exactly like a five-minute outage, and both
/// trigger a re-transcription that, for the pause, changes nothing.
///
/// That asymmetry is deliberate. A false positive costs one async job — which
/// is *cheaper* than the realtime leg that already ran, and whose result is no
/// worse. A false negative costs someone their meeting. The thresholds below
/// are therefore set to catch real outages rather than to avoid re-running.
public enum TranscriptCoverage {

    /// A half-open span `[start, end)` of a recording, in milliseconds from its
    /// start.
    public struct Span: Sendable, Equatable, Codable {
        public var startMs: UInt64
        public var endMs: UInt64

        /// An end before its start is collapsed to an empty span rather than
        /// kept as a negative one — `durationMs` is unsigned, and a span that
        /// runs backwards would underflow every sum it took part in.
        public init(startMs: UInt64, endMs: UInt64) {
            self.startMs = startMs
            self.endMs = max(startMs, endMs)
        }

        public var durationMs: UInt64 { endMs - startMs }
    }

    /// When a transcript is short enough of its audio to be worth re-running.
    ///
    /// Two independent triggers, because the two failures they describe do not
    /// shrink into one number. A single 90-second hole in a three-hour
    /// recording is a lost conversation but only 0.8% of the total; a transcript
    /// that is missing a fifth of a short meeting in a dozen small pieces never
    /// has one big hole. Either alone is enough.
    public struct BackfillPolicy: Sendable, Equatable {
        /// One uninterrupted hole at least this long triggers a re-run.
        ///
        /// Well above a normal reconnect: `RelayAudioBridge` holds audio across
        /// the backoff ladder and flushes it into the next leg, so a reconnect
        /// that works leaves no hole at all. A hole this size means the audio
        /// went somewhere that never transcribed it.
        public var longestGap: Duration
        /// Holes totalling at least this share of the recording trigger a re-run.
        public var totalGapFraction: Double
        /// How many times a person may ask for a re-run by hand, per recording.
        ///
        /// Spending this budget requires a transcription to have actually
        /// completed. A run that dies on a flat network costs nothing — the
        /// cap exists to bound cost and to stop someone re-rolling the same
        /// audio hoping for a different answer, not to punish bad reception.
        /// Which recording has spent what is `ManualRetryBudget`; this is only
        /// the number it compares against.
        public var maxManualRetries: Int

        public init(
            longestGap: Duration = .seconds(30),
            totalGapFraction: Double = 0.10,
            maxManualRetries: Int = 3
        ) {
            self.longestGap = longestGap
            self.totalGapFraction = totalGapFraction
            self.maxManualRetries = maxManualRetries
        }

        public static let standard = BackfillPolicy()
    }

    /// What a recording's transcript does and does not account for.
    public struct Report: Sendable, Equatable {
        public var totalMs: UInt64
        /// Merged spans the transcript speaks for.
        public var covered: [Span]
        /// Merged spans it does not, in order.
        public var gaps: [Span]

        public var coveredMs: UInt64 { covered.reduce(0) { $0 + $1.durationMs } }
        public var gapMs: UInt64 { gaps.reduce(0) { $0 + $1.durationMs } }
        public var longestGapMs: UInt64 { gaps.map(\.durationMs).max() ?? 0 }

        /// 0…1. A recording with no duration is treated as fully covered:
        /// there is nothing there to be missing.
        public var coveredFraction: Double {
            totalMs == 0 ? 1 : Double(coveredMs) / Double(totalMs)
        }

        public func needsBackfill(policy: BackfillPolicy = .standard) -> Bool {
            guard totalMs > 0 else { return false }
            let longestAllowed = UInt64(max(0, policy.longestGap.components.seconds)) * 1000
            if longestGapMs >= longestAllowed { return true }
            return Double(gapMs) >= Double(totalMs) * policy.totalGapFraction
        }
    }

    /// Measure `segments` against `totalMs` of audio.
    ///
    /// Only committed segments count. The tentative `-tail` row a live session
    /// leaves behind is a guess that is still being revised — it is excluded
    /// from the upload for the same reason, and treating it as coverage here
    /// would let a single unfinished utterance vouch for audio nobody
    /// transcribed. Spans are clamped to the audio: a provider timestamp may
    /// run a few milliseconds past the end of the file, and an "over 100%
    /// covered" recording would make the arithmetic below meaningless.
    public static func report(segments: [TranscriptSegment], totalMs: UInt64) -> Report {
        let spans =
            segments
            .filter { $0.isFinal && !$0.id.hasSuffix("-tail") }
            .compactMap { segment -> Span? in
                let start = min(segment.startMs, totalMs)
                let end = min(segment.endMs, totalMs)
                guard end > start else { return nil }
                return Span(startMs: start, endMs: end)
            }

        let covered = merge(spans)
        return Report(totalMs: totalMs, covered: covered, gaps: complement(of: covered, in: totalMs))
    }

    /// Sort and coalesce overlapping or touching spans.
    ///
    /// Overlap is the normal case, not an edge case: a reconnected leg is
    /// offset to the front of the bridge's hold buffer, so the first segment it
    /// commits can start before the last segment of the leg that died.
    static func merge(_ spans: [Span]) -> [Span] {
        let sorted = spans.filter { $0.durationMs > 0 }.sorted {
            $0.startMs == $1.startMs ? $0.endMs < $1.endMs : $0.startMs < $1.startMs
        }
        var merged: [Span] = []
        for span in sorted {
            if let last = merged.last, span.startMs <= last.endMs {
                merged[merged.count - 1].endMs = max(last.endMs, span.endMs)
            } else {
                merged.append(span)
            }
        }
        return merged
    }

    /// The spans of `[0, totalMs)` that `covered` leaves out. `covered` must
    /// already be merged and sorted.
    static func complement(of covered: [Span], in totalMs: UInt64) -> [Span] {
        guard totalMs > 0 else { return [] }
        var gaps: [Span] = []
        var cursor: UInt64 = 0
        for span in covered {
            if span.startMs > cursor {
                gaps.append(Span(startMs: cursor, endMs: span.startMs))
            }
            cursor = max(cursor, span.endMs)
        }
        if cursor < totalMs {
            gaps.append(Span(startMs: cursor, endMs: totalMs))
        }
        return gaps
    }
}
