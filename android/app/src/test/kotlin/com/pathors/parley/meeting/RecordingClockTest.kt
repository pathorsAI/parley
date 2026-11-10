package com.pathors.parley.meeting

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class RecordingClockTest {

    @Test
    fun `a running clock reports the time since it started`() {
        assertEquals(2_500L, RecordingClock.Running(sinceMs = 1_000).elapsedAt(3_500))
    }

    @Test
    fun `a pause freezes the clock`() {
        val paused = RecordingClock.Running(sinceMs = 1_000).paused(4_000)
        assertEquals(3_000L, paused.elapsedAt(4_000))
        assertEquals(3_000L, paused.elapsedAt(60_000))
    }

    @Test
    fun `resuming continues from the time banked at the pause`() {
        val clock = RecordingClock.Running(sinceMs = 1_000).paused(4_000).resumed(10_000)
        assertEquals(5_500L, clock.elapsedAt(12_500))
    }

    @Test
    fun `two pauses accumulate`() {
        val clock = RecordingClock.Running(sinceMs = 0)
            .paused(1_000)
            .resumed(5_000)
            .paused(7_000)
            .resumed(20_000)
        assertEquals(4_000L, clock.elapsedAt(21_000))
    }

    @Test
    fun `pausing a paused clock is a no-op`() {
        val paused = RecordingClock.Paused(bankedMs = 3_000)
        assertSame(paused, paused.paused(9_000))
    }

    @Test
    fun `resuming a running clock is a no-op`() {
        val running = RecordingClock.Running(sinceMs = 1_000, bankedMs = 500)
        assertSame(running, running.resumed(9_000))
    }

    @Test
    fun `a reading before the start does not go negative`() {
        assertEquals(500L, RecordingClock.Running(sinceMs = 10_000, bankedMs = 500).elapsedAt(9_000))
    }
}
