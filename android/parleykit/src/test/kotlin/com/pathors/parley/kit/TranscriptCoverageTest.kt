package com.pathors.parley.kit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Ported from iOS `TranscriptCoverageTests.swift`. The thresholds and the
 * arithmetic have to agree across the two phones: a recording the iPhone decides
 * is broken must be the same recording an Android decides is broken, or a
 * meeting synced between them would be re-transcribed on one and left thin on
 * the other.
 */
class TranscriptCoverageTest {

    /** Committed segment covering `[start, end)` seconds. */
    private fun seg(start: Long, end: Long, id: String = "mix-${index++}"): TranscriptSegment =
        TranscriptSegment(
            id = id,
            source = "mix",
            speaker = 0,
            text = "x",
            isFinal = true,
            startMs = start * 1000,
            endMs = end * 1000,
        )

    private var index = 0

    // ── the shape of the bug this exists for ─────────────────────────────────

    @Test
    fun `a relay that dies part way leaves the rest as one gap`() {
        // The reported failure: 49 minutes of audio, a handful of sentences.
        val report = TranscriptCoverage.report(
            listOf(seg(0, 60), seg(60, 180), seg(180, 300)),
            totalMs = 2953 * 1000,
        )

        assertEquals(1, report.gaps.size)
        assertEquals(300L * 1000, report.gaps.first().startMs)
        assertEquals(2953L * 1000, report.gaps.first().endMs)
        assertTrue(report.needsBackfill())
        assertTrue(report.coveredFraction < 0.11)
    }

    @Test
    fun `a fully transcribed meeting is left alone`() {
        val report = TranscriptCoverage.report(
            (0L until 60L).map { seg(it * 60, (it + 1) * 60) },
            totalMs = 3600 * 1000,
        )

        assertEquals(emptyList<TranscriptCoverage.Span>(), report.gaps)
        assertEquals(1.0, report.coveredFraction, 0.0)
        assertFalse(report.needsBackfill())
    }

    // ── the two triggers are independent ─────────────────────────────────────

    @Test
    fun `one long hole triggers even when it is a tiny share of the whole`() {
        // 90 seconds lost out of three hours: 0.8% of the recording, and a whole
        // lost conversation. The fraction trigger cannot see this.
        val report = TranscriptCoverage.report(
            listOf(seg(0, 3600), seg(3690, 10800)),
            totalMs = 10800 * 1000,
        )

        assertEquals(90L * 1000, report.longestGapMs)
        assertTrue(report.gapMs.toDouble() < report.totalMs.toDouble() * 0.10)
        assertTrue(report.needsBackfill())
    }

    @Test
    fun `many small holes trigger on their total when none is long enough alone`() {
        // Twelve 10-second holes in a 10-minute meeting: 20% missing, and the
        // longest-gap trigger never fires.
        val segments = (0L until 12L).map { seg(it * 50, it * 50 + 40) }
        val report = TranscriptCoverage.report(segments, totalMs = 600 * 1000)

        assertTrue(report.longestGapMs < 30L * 1000)
        assertTrue(report.needsBackfill())
    }

    @Test
    fun `a short reconnect is not worth re-transcribing an hour over`() {
        // The session reopens the relay while the microphone keeps running, so a
        // reconnect that works leaves almost no hole at all. Even when a few
        // seconds do slip, they must not trigger a re-run.
        val report = TranscriptCoverage.report(
            listOf(seg(0, 1800), seg(1806, 3600)),
            totalMs = 3600 * 1000,
        )

        assertEquals(6L * 1000, report.longestGapMs)
        assertFalse(report.needsBackfill())
    }

    // ── segment bookkeeping ──────────────────────────────────────────────────

    @Test
    fun `the tentative tail does not vouch for audio nobody transcribed`() {
        // An unfinished utterance must not cover the 40 minutes it is guessing
        // at — it is excluded from the upload for the same reason.
        val tail = TranscriptSegment(
            id = "mix-tail",
            source = "mix",
            speaker = 0,
            text = "guess",
            isFinal = true,
            startMs = 300 * 1000,
            endMs = 2953 * 1000,
        )
        val report = TranscriptCoverage.report(
            listOf(seg(0, 300), tail),
            totalMs = 2953 * 1000,
        )

        assertTrue(report.needsBackfill())
        assertEquals((2953L - 300) * 1000, report.longestGapMs)
    }

    @Test
    fun `non-final segments are not coverage`() {
        val partial = TranscriptSegment(
            id = "p",
            source = "mix",
            speaker = 0,
            text = "…",
            isFinal = false,
            startMs = 0,
            endMs = 600 * 1000,
        )
        val report = TranscriptCoverage.report(listOf(partial), totalMs = 600 * 1000)

        assertEquals(0L, report.coveredMs)
        assertTrue(report.needsBackfill())
    }

    @Test
    fun `overlapping legs merge rather than double count`() {
        // A reconnected leg carries a time offset onto a stream the previous leg
        // had already partly committed, so its first segment can start before
        // the last segment of the leg that died.
        val report = TranscriptCoverage.report(
            listOf(seg(0, 100), seg(80, 200), seg(150, 300)),
            totalMs = 300 * 1000,
        )

        assertEquals(1, report.covered.size)
        assertEquals(300L * 1000, report.coveredMs)
        assertEquals(emptyList<TranscriptCoverage.Span>(), report.gaps)
    }

    @Test
    fun `segments arriving out of order still merge`() {
        val report = TranscriptCoverage.report(
            listOf(seg(150, 300), seg(0, 100), seg(80, 200)),
            totalMs = 300 * 1000,
        )

        assertEquals(1, report.covered.size)
        assertEquals(emptyList<TranscriptCoverage.Span>(), report.gaps)
    }

    @Test
    fun `touching spans coalesce, so a clean handover is not a gap`() {
        // One segment ending exactly where the next begins leaves nothing
        // missing between them, and must not be reported as two runs.
        val report = TranscriptCoverage.report(
            listOf(seg(0, 100), seg(100, 200)),
            totalMs = 200 * 1000,
        )

        assertEquals(1, report.covered.size)
        assertEquals(emptyList<TranscriptCoverage.Span>(), report.gaps)
    }

    @Test
    fun `a timestamp past the end of the file cannot push coverage over 100 percent`() {
        val report = TranscriptCoverage.report(listOf(seg(0, 700)), totalMs = 600 * 1000)

        assertEquals(600L * 1000, report.coveredMs)
        assertEquals(1.0, report.coveredFraction, 0.0)
        assertFalse(report.needsBackfill())
    }

    @Test
    fun `a zero-length segment covers nothing`() {
        val report = TranscriptCoverage.report(listOf(seg(60, 60)), totalMs = 600 * 1000)

        assertEquals(0L, report.coveredMs)
    }

    // ── the two ways in agree ────────────────────────────────────────────────

    @Test
    fun `measuring spans directly is the same measurement as measuring segments`() {
        // The upload path holds its transcript as a cloud DTO and reaches
        // `reportOfSpans` through `coverageSpan`. The two entry points must not
        // be able to disagree about the same recording.
        val segments = listOf(seg(0, 100), seg(150, 300))
        val totalMs = 300L * 1000
        val spans = segments.mapNotNull {
            TranscriptCoverage.coverageSpan(it.id, it.isFinal, it.startMs, it.endMs, totalMs)
        }

        assertEquals(
            TranscriptCoverage.report(segments, totalMs),
            TranscriptCoverage.reportOfSpans(spans, totalMs),
        )
    }

    @Test
    fun `coverageSpan is the one definition of what counts`() {
        // Not final, the tentative tail, and an empty span: three ways to vouch
        // for nothing, rejected in one place so the DTO path cannot grow its own
        // opinion.
        assertNull(TranscriptCoverage.coverageSpan("mix-0", false, 0, 1_000, 10_000))
        assertNull(TranscriptCoverage.coverageSpan("mix-tail", true, 0, 1_000, 10_000))
        assertNull(TranscriptCoverage.coverageSpan("mix-0", true, 500, 500, 10_000))
        // And one that does count, clamped to the audio.
        assertEquals(
            TranscriptCoverage.Span(0, 10_000),
            TranscriptCoverage.coverageSpan("mix-0", true, 0, 12_000, 10_000),
        )
    }

    // ── degenerate inputs ────────────────────────────────────────────────────

    @Test
    fun `a recording with no transcript at all is one gap`() {
        val report = TranscriptCoverage.report(emptyList(), totalMs = 600 * 1000)

        assertEquals(listOf(TranscriptCoverage.Span(0, 600 * 1000)), report.gaps)
        assertEquals(0.0, report.coveredFraction, 0.0)
        assertTrue(report.needsBackfill())
    }

    @Test
    fun `a recording with no duration is never worth re-running`() {
        // Nothing is there to be missing, and dividing by it would not end well.
        val report = TranscriptCoverage.report(emptyList(), totalMs = 0)

        assertEquals(1.0, report.coveredFraction, 0.0)
        assertFalse(report.needsBackfill())
    }

    @Test
    fun `a span that runs backwards collapses rather than underflowing`() {
        val span = TranscriptCoverage.Span(500, 100)

        assertEquals(0L, span.durationMs)
        assertEquals(500L, span.endMs)
    }

    // ── policy ───────────────────────────────────────────────────────────────

    @Test
    fun `a gap exactly at the threshold triggers`() {
        // The comparison is `>=` on both triggers. Thirty seconds missing is
        // thirty seconds of somebody's meeting either way.
        val report = TranscriptCoverage.report(
            listOf(seg(0, 1800), seg(1830, 3600)),
            totalMs = 3600 * 1000,
        )

        assertEquals(30L * 1000, report.longestGapMs)
        assertTrue(report.needsBackfill())
    }

    @Test
    fun `holes totalling exactly a tenth trigger`() {
        // Six 10-second holes in a 10-minute meeting: exactly 10%, none of them
        // anywhere near the longest-gap trigger.
        val segments = (0L until 6L).map { seg(it * 100, it * 100 + 90) }
        val report = TranscriptCoverage.report(segments, totalMs = 600 * 1000)

        assertEquals(60L * 1000, report.gapMs)
        assertTrue(report.longestGapMs < 30L * 1000)
        assertTrue(report.needsBackfill())
    }

    @Test
    fun `thresholds are tunable without touching the measurement`() {
        val report = TranscriptCoverage.report(
            listOf(seg(0, 1800), seg(1806, 3600)),
            totalMs = 3600 * 1000,
        )
        val strict = TranscriptCoverage.BackfillPolicy(
            longestGapMs = 5_000,
            totalGapFraction = 0.10,
        )

        assertFalse(report.needsBackfill())
        assertTrue(report.needsBackfill(strict))
    }

    @Test
    fun `the manual retry budget is three`() {
        assertEquals(3, TranscriptCoverage.BackfillPolicy.STANDARD.maxManualRetries)
    }
}
