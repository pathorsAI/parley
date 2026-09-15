package com.pathors.parley.kit

/**
 * How much of a recording the transcript actually accounts for, and whether that
 * is little enough to be worth transcribing the audio again.
 *
 * ## Why this measures what came back, not what was sent
 *
 * The obvious place to count coverage is the send side: `MeetingSession` already
 * knows every chunk it ever handed to a relay, so it could record the spans it
 * delivered and the spans it held. That measurement is wrong for the failure it
 * most needs to catch.
 *
 * A relay socket can go half-open — the peer is gone, but nothing errors and
 * nothing closes, so `SttRelayClient` keeps accepting chunks and the session
 * keeps believing it has a live sink. Send-side accounting would mark that
 * entire stretch **covered** while not one word of it was ever transcribed. The
 * silent death is precisely the case a send-side measure cannot see.
 *
 * So coverage is derived from the committed segments: the union of the spans
 * they occupy, against the duration of the audio on disk. A leg that died
 * without saying so leaves a hole here no matter how convincingly the socket
 * pretended.
 *
 * ## Silence reads as a gap, on purpose
 *
 * Nothing here distinguishes "the relay was dead" from "nobody was talking". A
 * five-minute pause looks exactly like a five-minute outage, and both trigger a
 * re-transcription that, for the pause, changes nothing.
 *
 * That asymmetry is deliberate. A false positive costs one async job — which is
 * *cheaper* than the realtime leg that already ran, and whose result is no
 * worse. A false negative costs someone their meeting. The thresholds below are
 * therefore set to catch real outages rather than to avoid re-running.
 *
 * Ported from iOS `ParleyKit/TranscriptCoverage.swift`; the thresholds, the
 * merge and the complement must stay identical or the two phones would disagree
 * about which recordings are broken.
 */
object TranscriptCoverage {

    /** The id suffix the live transcriber uses for its tentative segment. */
    const val TAIL_SUFFIX = "-tail"

    /**
     * A half-open span `[startMs, endMs)` of a recording, in milliseconds from
     * its start.
     *
     * A plain class rather than a `data class` because the constructor has work
     * to do: an end before its start is collapsed to an empty span rather than
     * kept as a negative one, so a span that ran backwards cannot poison every
     * sum it takes part in.
     */
    class Span(val startMs: Long, endMs: Long) {

        val endMs: Long = maxOf(startMs, endMs)

        val durationMs: Long get() = endMs - startMs

        override fun equals(other: Any?): Boolean =
            other is Span && other.startMs == startMs && other.endMs == endMs

        override fun hashCode(): Int = 31 * startMs.hashCode() + endMs.hashCode()

        override fun toString(): String = "Span($startMs..$endMs)"
    }

    /**
     * When a transcript is short enough of its audio to be worth re-running.
     *
     * Two independent triggers, because the two failures they describe do not
     * shrink into one number. A single 90-second hole in a three-hour recording
     * is a lost conversation but only 0.8% of the total; a transcript that is
     * missing a fifth of a short meeting in a dozen small pieces never has one
     * big hole. Either alone is enough.
     */
    data class BackfillPolicy(
        /**
         * One uninterrupted hole at least this long triggers a re-run.
         *
         * Well above a normal reconnect: `MeetingSession` reopens the relay
         * while the microphone keeps running, so a reconnect that works leaves
         * at most a second or two. A hole this size means the audio went
         * somewhere that never transcribed it.
         */
        val longestGapMs: Long = 30_000,
        /** Holes totalling at least this share of the recording trigger a re-run. */
        val totalGapFraction: Double = 0.10,
        /**
         * How many times a person may ask for a re-run by hand, per recording.
         *
         * Spending this budget requires a transcription to have actually
         * completed. A run that dies on a flat network costs nothing — the cap
         * exists to bound cost and to stop someone re-rolling the same audio
         * hoping for a different answer, not to punish bad reception. Which
         * recording has spent what is [ManualRetryBudget]; this is only the
         * number it compares against.
         */
        val maxManualRetries: Int = 3,
    ) {
        companion object {
            val STANDARD = BackfillPolicy()
        }
    }

    /** What a recording's transcript does and does not account for. */
    data class Report(
        val totalMs: Long,
        /** Merged spans the transcript speaks for. */
        val covered: List<Span>,
        /** Merged spans it does not, in order. */
        val gaps: List<Span>,
    ) {
        val coveredMs: Long get() = covered.sumOf { it.durationMs }
        val gapMs: Long get() = gaps.sumOf { it.durationMs }
        val longestGapMs: Long get() = gaps.maxOfOrNull { it.durationMs } ?: 0L

        /**
         * 0…1. A recording with no duration is treated as fully covered: there
         * is nothing there to be missing.
         */
        val coveredFraction: Double
            get() = if (totalMs == 0L) 1.0 else coveredMs.toDouble() / totalMs.toDouble()

        fun needsBackfill(policy: BackfillPolicy = BackfillPolicy.STANDARD): Boolean {
            if (totalMs <= 0L) return false
            if (longestGapMs >= policy.longestGapMs) return true
            return gapMs.toDouble() >= totalMs.toDouble() * policy.totalGapFraction
        }
    }

    /**
     * Measure [segments] against [totalMs] of audio.
     *
     * See [coverageSpan] for which segments count and why.
     */
    fun report(segments: List<TranscriptSegment>, totalMs: Long): Report =
        reportOfSpans(
            segments.mapNotNull { coverageSpan(it.id, it.isFinal, it.startMs, it.endMs, totalMs) },
            totalMs,
        )

    /**
     * The same measurement from spans somebody else extracted — the upload path
     * holds its transcript as the cloud DTO, not as a [TranscriptSegment], and
     * must not have to convert a whole meeting to ask one question about it.
     *
     * [spans] need not be sorted or disjoint; that is what [merge] is for.
     */
    fun reportOfSpans(spans: List<Span>, totalMs: Long): Report {
        val covered = merge(spans)
        return Report(totalMs = totalMs, covered = covered, gaps = complement(covered, totalMs))
    }

    /**
     * The span one segment vouches for, or null when it vouches for nothing.
     *
     * Only committed segments count. The tentative `-tail` row a live session
     * leaves behind is a guess that is still being revised — it is excluded from
     * the upload for the same reason, and treating it as coverage here would let
     * a single unfinished utterance vouch for audio nobody transcribed.
     *
     * Spans are clamped to the audio: a provider timestamp may run a few
     * milliseconds past the end of the file, and an "over 100% covered"
     * recording would make the arithmetic in [Report] meaningless.
     *
     * A free function taking the four fields rather than a segment, so the
     * upload layer's DTO and the relay's [TranscriptSegment] share one
     * definition of "committed" instead of growing two that drift.
     */
    fun coverageSpan(
        id: String,
        isFinal: Boolean,
        startMs: Long,
        endMs: Long,
        totalMs: Long,
    ): Span? {
        if (!isFinal || id.endsWith(TAIL_SUFFIX)) return null
        val start = startMs.coerceIn(0L, maxOf(totalMs, 0L))
        val end = endMs.coerceIn(0L, maxOf(totalMs, 0L))
        if (end <= start) return null
        return Span(start, end)
    }

    /**
     * Sort and coalesce overlapping or touching spans.
     *
     * Overlap is the normal case, not an edge case: a reconnected relay leg
     * carries a time offset onto a stream the previous leg had already partly
     * committed, so the first segment it commits can start before the last
     * segment of the leg that died.
     */
    internal fun merge(spans: List<Span>): List<Span> {
        val sorted = spans
            .filter { it.durationMs > 0 }
            .sortedWith(compareBy({ it.startMs }, { it.endMs }))
        val merged = mutableListOf<Span>()
        for (span in sorted) {
            val last = merged.lastOrNull()
            if (last != null && span.startMs <= last.endMs) {
                merged[merged.size - 1] = Span(last.startMs, maxOf(last.endMs, span.endMs))
            } else {
                merged += span
            }
        }
        return merged
    }

    /**
     * The spans of `[0, totalMs)` that [covered] leaves out. [covered] must
     * already be merged and sorted.
     */
    internal fun complement(covered: List<Span>, totalMs: Long): List<Span> {
        if (totalMs <= 0L) return emptyList()
        val gaps = mutableListOf<Span>()
        var cursor = 0L
        for (span in covered) {
            if (span.startMs > cursor) gaps += Span(cursor, span.startMs)
            cursor = maxOf(cursor, span.endMs)
        }
        if (cursor < totalMs) gaps += Span(cursor, totalMs)
        return gaps
    }
}
