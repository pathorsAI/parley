package com.pathors.parley.playback

import org.junit.Assert.assertEquals
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
}
