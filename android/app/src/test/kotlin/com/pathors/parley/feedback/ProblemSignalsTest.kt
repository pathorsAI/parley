package com.pathors.parley.feedback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The thresholds of spec §4. The boundaries are the point: the admin view and
 * iOS count with the same numbers, and a phone that disagreed by one second
 * would raise prompts for recordings the dashboard calls fine.
 */
class ProblemSignalsTest {

    private val minute = 60_000L

    @Test
    fun `empty transcript starts at twenty seconds with no segments`() {
        assertFalse(ProblemSignals.isEmptyTranscript(19_999, 0))
        assertTrue(ProblemSignals.isEmptyTranscript(20_000, 0))
        assertTrue(ProblemSignals.isEmptyTranscript(111 * minute, 0))
        assertFalse("one segment is not empty", ProblemSignals.isEmptyTranscript(5 * minute, 1))
    }

    @Test
    fun `truncated needs three minutes and a last segment before half-way`() {
        assertFalse("too short", ProblemSignals.isTruncatedTranscript(3 * minute - 1, 4, 10_000))
        assertTrue(ProblemSignals.isTruncatedTranscript(3 * minute, 4, 10_000))
        // The 1.13 case: 111 minutes recorded, about 12 transcribed.
        assertTrue(ProblemSignals.isTruncatedTranscript(111 * minute, 300, 12 * minute))
    }

    @Test
    fun `exactly half-way is not truncated`() {
        assertFalse(ProblemSignals.isTruncatedTranscript(10 * minute, 20, 5 * minute))
        assertTrue(ProblemSignals.isTruncatedTranscript(10 * minute, 20, 5 * minute - 1))
    }

    @Test
    fun `a transcript with no segments is empty, not truncated`() {
        assertFalse(ProblemSignals.isTruncatedTranscript(10 * minute, 0, 0))
        assertTrue(ProblemSignals.isEmptyTranscript(10 * minute, 0))
    }

    @Test
    fun `microphone recoveries are worth asking about from five`() {
        assertFalse(ProblemSignals.isMicRecoveryWorthAsking(4))
        assertTrue(ProblemSignals.isMicRecoveryWorthAsking(5))
    }

    @Test
    fun `sync is stuck after three failures or a day of waiting`() {
        val now = 1_759_000_000_000L
        val day = 24 * 60 * minute
        assertFalse(ProblemSignals.isSyncStuck(2, now - day + 1, now))
        assertTrue(ProblemSignals.isSyncStuck(3, now, now))
        assertTrue(ProblemSignals.isSyncStuck(0, now - day, now))
    }

    @Test
    fun `the minutes an empty recording is described with are rounded but never zero`() {
        assertEquals(1, ProblemSignals.wholeMinutes(20_000))
        assertEquals(1, ProblemSignals.wholeMinutes(89_999))
        assertEquals(2, ProblemSignals.wholeMinutes(90_000))
        assertEquals(24, ProblemSignals.wholeMinutes(24 * minute))
    }

    @Test
    fun `trigger wire strings are the shared contract`() {
        assertEquals(
            listOf(
                "empty_transcript", "truncated_transcript", "sync_failed", "mic_recovery",
                "retranscribe", "delete_failed", "crash", "screenshot", "manual",
            ),
            FeedbackTrigger.entries.map { it.wire },
        )
        assertEquals(listOf("misheard", "missing", "speakers", "other"), RetranscribeTag.entries.map { it.id })
        assertEquals(
            setOf(FeedbackTrigger.CRASH, FeedbackTrigger.MANUAL),
            FeedbackTrigger.entries.filterNot { it.isRateLimited }.toSet(),
        )
    }
}
