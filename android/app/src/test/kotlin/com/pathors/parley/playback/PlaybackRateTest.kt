package com.pathors.parley.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The speed menu and its labels.
 *
 * Small, and worth pinning anyway: the label is a formatted decimal with its
 * zeroes trimmed off, which is exactly the kind of code that quietly starts
 * saying "1.00x" the day somebody adjusts the format string.
 */
class PlaybackRateTest {

    @Test
    fun `speed labels drop the zeroes a measurement would keep`() {
        assertEquals("0.75×", rateLabel(0.75f))
        assertEquals("1×", rateLabel(1f))
        assertEquals("1.25×", rateLabel(1.25f))
        assertEquals("1.5×", rateLabel(1.5f))
        assertEquals("2×", rateLabel(2f))
    }

    @Test
    fun `every speed in the menu has a label and they are all distinct`() {
        val labels = PlaybackController.RATES.map(::rateLabel)
        assertEquals(PlaybackController.RATES.size, labels.toSet().size)
        assertEquals(listOf("0.75×", "1×", "1.25×", "1.5×", "1.75×", "2×"), labels)
    }

    @Test
    fun `a tap steps through the iOS cycle and wraps at 2x`() {
        assertEquals(1.25f, PlaybackRates.next(1f))
        assertEquals(1.5f, PlaybackRates.next(1.25f))
        assertEquals(2f, PlaybackRates.next(1.5f))
        assertEquals(1f, PlaybackRates.next(2f))
    }

    @Test
    fun `a tap after an off-cycle menu speed nudges forwards, not back to 1x`() {
        assertEquals(1f, PlaybackRates.next(0.75f))
        assertEquals(2f, PlaybackRates.next(1.75f))
    }

    @Test
    fun `a stored speed comes back only if it is on the menu`() {
        assertEquals(1f, PlaybackRates.restore(null))
        assertEquals(1f, PlaybackRates.restore(0f))
        assertEquals(1f, PlaybackRates.restore(3f))
        assertEquals(1.5f, PlaybackRates.restore(1.5f))
        assertEquals(0.75f, PlaybackRates.restore(0.75f))
    }

    @Test
    fun `a saved speed is what the next load returns, snapped to the menu`() {
        val store = PlaybackRateStore.inMemory()
        assertEquals(1f, store.load())
        store.save(1.75f)
        assertEquals(1.75f, store.load())
        store.save(1.3f)
        assertEquals(1.25f, store.load())
    }

    @Test
    fun `the controller's menu is the shared one, and the cycle is inside it`() {
        assertEquals(PlaybackRates.MENU, PlaybackController.RATES)
        assertTrue(PlaybackRates.MENU.containsAll(PlaybackRates.CYCLE))
        assertEquals(listOf(1f, 1.25f, 1.5f, 2f), PlaybackRates.CYCLE)
    }
}
