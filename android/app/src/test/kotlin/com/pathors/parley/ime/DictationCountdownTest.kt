package com.pathors.parley.ime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DictationCountdownTest {

    private val limit = DictationSession.MAX_DURATION_MS

    @Test
    fun `the cap is ten minutes, like iOS and the desktop`() {
        assertEquals(600_000L, limit)
        assertEquals(10, DictationCountdown.limitMinutes())
    }

    @Test
    fun `nothing shows before the last thirty seconds`() {
        assertNull(DictationCountdown.secondsLeft(elapsedMs = 0L))
        assertNull(DictationCountdown.secondsLeft(elapsedMs = 45_000L))
        assertNull(DictationCountdown.secondsLeft(elapsedMs = limit - 30_001L))
    }

    @Test
    fun `the countdown starts at thirty`() {
        assertEquals(30, DictationCountdown.secondsLeft(elapsedMs = limit - 30_000L))
        assertEquals(30, DictationCountdown.secondsLeft(elapsedMs = limit - 29_200L))
    }

    @Test
    fun `it rounds up, so it counts down to one rather than zero`() {
        assertEquals(1, DictationCountdown.secondsLeft(elapsedMs = limit - 200L))
        assertEquals(2, DictationCountdown.secondsLeft(elapsedMs = limit - 1_001L))
    }

    @Test
    fun `nothing shows at or past the cap`() {
        assertNull(DictationCountdown.secondsLeft(elapsedMs = limit))
        assertNull(DictationCountdown.secondsLeft(elapsedMs = limit + 5_000L))
    }

    @Test
    fun `the minutes in the copy follow the limit`() {
        assertEquals(2, DictationCountdown.limitMinutes(120_000L))
        assertEquals(1, DictationCountdown.limitMinutes(10_000L))
    }
}
