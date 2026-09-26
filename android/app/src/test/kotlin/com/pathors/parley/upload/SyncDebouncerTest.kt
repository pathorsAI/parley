package com.pathors.parley.upload

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The timing rules that keep "the network came back" from turning into a burst
 * of sync passes, driven with virtual time.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SyncDebouncerTest {

    private val settle = SyncDebouncer.DEFAULT_SETTLE_MS
    private val interval = SyncDebouncer.DEFAULT_MIN_INTERVAL_MS

    private class Harness(scope: TestScope) {
        val passes = mutableListOf<Pair<Long, String>>()
        val debouncer = SyncDebouncer(
            scope = scope.backgroundScope,
            now = { scope.testScheduler.currentTime },
        ) { reason -> passes += scope.testScheduler.currentTime to reason }
    }

    /**
     * Run everything that could still be scheduled. `advanceUntilIdle` does not
     * wait for `backgroundScope`, which is where the debouncer's jobs live.
     */
    private fun TestScope.drainAll() {
        advanceTimeBy(interval * 4)
        runCurrent()
    }

    private val wifi = "wifi"
    private val cell = "cell"

    @Test
    fun `nothing fires at launch just for the network being there`() = runTest {
        val h = Harness(this)
        // The callback's first onAvailable arrives right after registration;
        // the launch drain has already covered it.
        h.debouncer.networkAvailable(wifi)
        advanceTimeBy(interval - 1)
        runCurrent()
        assertEquals(emptyList<Pair<Long, String>>(), h.passes)
        // It is deferred to the end of the spacing window, not dropped.
        advanceTimeBy(1)
        runCurrent()
        assertEquals(listOf(interval to SyncDebouncer.REASON_NETWORK), h.passes)
    }

    @Test
    fun `a reconnection triggers one pass after the network settles`() = runTest {
        val h = Harness(this)
        advanceTimeBy(interval * 2) // long after launch
        h.debouncer.networkAvailable(wifi)
        advanceTimeBy(settle - 1)
        runCurrent()
        assertEquals(0, h.passes.size)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(listOf(interval * 2 + settle to SyncDebouncer.REASON_NETWORK), h.passes)
    }

    @Test
    fun `a network that flaps inside the settle window never triggers`() = runTest {
        val h = Harness(this)
        advanceTimeBy(interval * 2)
        repeat(10) {
            h.debouncer.networkAvailable(wifi)
            advanceTimeBy(settle / 2)
            h.debouncer.networkLost(wifi)
            advanceTimeBy(settle / 2)
        }
        drainAll()
        assertEquals(0, h.passes.size)

        // Once it holds, exactly one pass.
        h.debouncer.networkAvailable(wifi)
        drainAll()
        assertEquals(1, h.passes.size)
    }

    @Test
    fun `reconnections closer than the interval are spaced, not stacked`() = runTest {
        val h = Harness(this)
        advanceTimeBy(interval * 2)
        val start = testScheduler.currentTime

        // Up, settles, pass #1.
        h.debouncer.networkAvailable(wifi)
        advanceTimeBy(settle)
        runCurrent()
        assertEquals(1, h.passes.size)

        // Down and up again a few times within the next half interval.
        repeat(3) {
            h.debouncer.networkLost(wifi)
            advanceTimeBy(1_000)
            h.debouncer.networkAvailable(wifi)
            advanceTimeBy(settle + 1_000)
        }
        runCurrent()
        assertEquals(1, h.passes.size)

        // The last reconnection still gets its pass, at the end of the window.
        drainAll()
        assertEquals(2, h.passes.size)
        assertEquals(start + settle + interval, h.passes[1].first)
    }

    @Test
    fun `a second network is not a reconnection, and losing one of two is not offline`() = runTest {
        val h = Harness(this)
        advanceTimeBy(interval * 2)
        h.debouncer.networkAvailable(wifi)
        advanceTimeBy(settle)
        runCurrent()
        assertEquals(1, h.passes.size)

        h.debouncer.networkAvailable(cell) // wifi still up
        drainAll()
        assertEquals(1, h.passes.size)

        // Wifi goes, cellular stays: a pending foreground pass must survive.
        h.debouncer.foregrounded()
        h.debouncer.networkLost(wifi)
        drainAll()
        assertEquals(2, h.passes.size)
        assertEquals(SyncDebouncer.REASON_FOREGROUND, h.passes[1].second)
    }

    @Test
    fun `going offline cancels a pass that has not started`() = runTest {
        val h = Harness(this)
        advanceTimeBy(interval * 2)
        h.debouncer.networkAvailable(wifi)
        h.debouncer.networkAvailable(cell)
        advanceTimeBy(settle / 2)
        h.debouncer.networkLost(wifi)
        h.debouncer.networkLost(cell)
        drainAll()
        assertEquals(0, h.passes.size)
    }

    @Test
    fun `coming back to the app runs a pass straight away`() = runTest {
        val h = Harness(this)
        advanceTimeBy(interval * 2)
        val start = testScheduler.currentTime
        h.debouncer.foregrounded()
        runCurrent()
        assertEquals(listOf(start to SyncDebouncer.REASON_FOREGROUND), h.passes)
    }

    @Test
    fun `foreground and reconnection at the same moment share one pass`() = runTest {
        val h = Harness(this)
        advanceTimeBy(interval * 2)
        h.debouncer.foregrounded()
        h.debouncer.networkAvailable(wifi)
        advanceTimeBy(settle * 2)
        runCurrent()
        assertEquals(1, h.passes.size)
        assertEquals(SyncDebouncer.REASON_FOREGROUND, h.passes.single().second)
    }

    @Test
    fun `a foreground right after a pass waits out the interval`() = runTest {
        val h = Harness(this)
        advanceTimeBy(interval * 2)
        h.debouncer.foregrounded()
        runCurrent()
        val first = h.passes.single().first

        advanceTimeBy(5_000)
        h.debouncer.foregrounded() // switched away and back
        h.debouncer.foregrounded() // and again
        drainAll()
        assertEquals(2, h.passes.size)
        assertEquals(first + interval, h.passes[1].first)
    }
}
