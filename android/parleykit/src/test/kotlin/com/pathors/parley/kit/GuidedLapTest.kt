package com.pathors.parley.kit

import com.pathors.parley.kit.GuidedLap.Display
import com.pathors.parley.kit.GuidedLap.Step
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The guide bar's step and its ✓ hold — iOS `GuidedLapTests`, case for case. */
class GuidedLapTest {

    /** A clock the test moves by hand. */
    private var now = START_MS

    private fun state(
        recorded: Boolean = true,
        filed: Boolean = false,
        replayed: Boolean = false,
        shared: Boolean = false,
        dismissed: Boolean = false,
    ) = GettingStartedState(
        recorded = recorded,
        filed = filed,
        replayed = replayed,
        sharedToAI = shared,
        dismissedAtMs = if (dismissed) 0L else null,
    )

    @Test
    fun `the step is the first undone of file, replay, share`() {
        assertEquals(Step.FILE, GuidedLap.stepFor(state()))
        assertEquals(Step.REPLAY, GuidedLap.stepFor(state(filed = true)))
        assertEquals(Step.SHARE, GuidedLap.stepFor(state(filed = true, replayed = true)))
        // Order is fixed: a replay done early does not skip the filing step.
        assertEquals(Step.FILE, GuidedLap.stepFor(state(replayed = true)))
        assertEquals(Step.DONE, GuidedLap.stepFor(state(filed = true, replayed = true, shared = true)))
    }

    @Test
    fun `a done step is held for one and a half seconds, then the next shows`() {
        var lap = GuidedLap.start(state())
        assertEquals(Display.Current(Step.FILE), lap.display(now))
        assertNull(lap.holdEndsAtMs(now))

        lap = lap.observed(state(filed = true), now)
        assertEquals(Display.Confirmed(Step.FILE), lap.display(now))
        assertEquals(now + HOLD, lap.holdEndsAtMs(now))

        now += 1_400
        assertEquals(Display.Confirmed(Step.FILE), lap.display(now))
        now += 200
        assertEquals(Display.Current(Step.REPLAY), lap.display(now))
        assertNull(lap.holdEndsAtMs(now))
    }

    @Test
    fun `the same state twice does not restart the hold`() {
        var lap = GuidedLap.start(state()).observed(state(filed = true), now)
        now += 1_000
        lap = lap.observed(state(filed = true), now)
        now += 600
        assertEquals(Display.Current(Step.REPLAY), lap.display(now))
    }

    @Test
    fun `two steps at once confirm the one that was up`() {
        val lap = GuidedLap.start(state(filed = true))
            .observed(state(filed = true, replayed = true, shared = true), now)
        assertEquals(Display.Confirmed(Step.REPLAY), lap.display(now))
        now += 2_000
        assertEquals(Display.Current(Step.DONE), lap.display(now))
    }

    @Test
    fun `a step done out of order gets no tick`() {
        // Replayed while the bar still says "file": the bar stays on filing,
        // and nothing is confirmed for a step it was not teaching.
        val lap = GuidedLap.start(state()).observed(state(replayed = true), now)
        assertEquals(Display.Current(Step.FILE), lap.display(now))
        assertNull(lap.holdEndsAtMs(now))
    }

    @Test
    fun `a reset goes back without a confirmation`() {
        val lap = GuidedLap.start(state(filed = true, replayed = true)).observed(state(recorded = false), now)
        assertEquals(Display.Current(Step.FILE), lap.display(now))
        assertNull(lap.holdEndsAtMs(now))
    }

    @Test
    fun `a reset during a hold drops the tick`() {
        val lap = GuidedLap.start(state())
            .observed(state(filed = true), now)
            .observed(state(recorded = false), now + 100)
        assertEquals(Display.Current(Step.FILE), lap.display(now + 100))
    }

    @Test
    fun visibility() {
        val lap = GuidedLap.start(state())
        assertTrue(lap.isVisible(state(), isLapRecording = true))
        assertFalse("not on the fortieth recording", lap.isVisible(state(), isLapRecording = false))
        assertFalse("Not now", lap.isVisible(state(dismissed = true), isLapRecording = true))
    }

    @Test
    fun `the finish shows only when this bar saw the lap unfinished`() {
        val done = state(filed = true, replayed = true, shared = true)
        val watched = GuidedLap.start(state(filed = true, replayed = true)).observed(done, now)
        assertTrue(watched.isVisible(done, isLapRecording = true))
        assertFalse("Close hides it", watched.closing().isVisible(done, isLapRecording = true))

        val later = GuidedLap.start(done)
        assertFalse("a finished lap stays finished", later.isVisible(done, isLapRecording = true))
    }

    private companion object {
        const val START_MS = 1_000_000_000L
        const val HOLD = 1_500L
    }
}
