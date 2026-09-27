package com.pathors.parley.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The geometry of the live meeting's resizable controls panel: what is on
 * screen at a given height, where a released drag comes to rest, and how far a
 * drag past either end may stretch it.
 */
class LivePanelTest {

    private val prototypeFull = 350f
    private val compact = LivePanel.COMPACT_DP

    private fun heights(full: Float): List<Float> {
        val steps = 400
        return (0..steps).map { compact - 20f + (full - compact + 40f) * it / steps }
    }

    @Test
    fun `fully open shows everything at full size`() {
        val shape = LivePanel.shape(prototypeFull, prototypeFull)
        assertTrue(shape.showsDiscard)
        assertTrue(shape.showsStatusRow)
        assertTrue(shape.showsStatusLine)
        assertTrue(shape.showsLevelMeter)
        assertEquals(1f, shape.progress, 0f)
        assertEquals(LivePanel.TIMER_FULL_SP, shape.timerSp, 0.001f)
        assertEquals(LivePanel.STOP_FULL_DP, shape.stopDp, 0.001f)
        assertEquals(1f, shape.columnAlpha, 0f)
        assertEquals(0f, shape.rowAlpha, 0f)
    }

    @Test
    fun `compact is only the row`() {
        val shape = LivePanel.shape(compact, prototypeFull)
        assertFalse(shape.showsDiscard)
        assertFalse(shape.showsStatusRow)
        assertFalse(shape.showsStatusLine)
        assertFalse(shape.showsLevelMeter)
        assertEquals(0f, shape.columnAlpha, 0f)
        assertEquals(1f, shape.rowAlpha, 0f)
        assertEquals(LivePanel.TIMER_SMALLEST_SP, shape.timerSp, 0.001f)
        assertEquals(LivePanel.STOP_SMALLEST_DP, shape.stopDp, 0.001f)
    }

    @Test
    fun `the prototype thresholds hold at the prototype height`() {
        fun at(h: Float) = LivePanel.shape(h, prototypeFull)
        assertTrue(at(330f).showsDiscard)
        assertFalse(at(329f).showsDiscard)
        assertTrue(at(285f).showsStatusRow)
        assertFalse(at(284f).showsStatusRow)
        assertTrue(at(250f).showsStatusLine)
        assertFalse(at(249f).showsStatusLine)
        assertTrue(at(215f).showsLevelMeter)
        assertFalse(at(214f).showsLevelMeter)
        // Timer 34 + 22t, stop 56 + 16t.
        val t = (219f - compact) / (prototypeFull - compact)
        assertEquals(34f + 22f * t, at(219f).timerSp, 0.001f)
        assertEquals(56f + 16f * t, at(219f).stopDp, 0.001f)
    }

    @Test
    fun `discard is gone as soon as the panel is noticeably below full`() {
        // The one destructive control only exists fully open.
        for (full in listOf(300f, 350f, 420f)) {
            assertTrue(LivePanel.shape(full, full).showsDiscard)
            assertFalse("full=$full", LivePanel.shape(full - 0.08f * (full - compact), full).showsDiscard)
        }
    }

    @Test
    fun `secondary pieces leave in order, discard first and the level meter last`() {
        for (full in listOf(260f, 350f, 480f)) {
            var seenDiscard = false
            for (h in heights(full)) {
                val s = LivePanel.shape(h, full)
                if (s.showsDiscard) assertTrue("status row outlived by discard at $h/$full", s.showsStatusRow)
                if (s.showsStatusRow) assertTrue("status line at $h/$full", s.showsStatusLine)
                if (s.showsStatusLine) assertTrue("level meter at $h/$full", s.showsLevelMeter)
                seenDiscard = seenDiscard || s.showsDiscard
            }
            assertTrue(seenDiscard)
        }
    }

    @Test
    fun `timer and stop shrink continuously with the height`() {
        var lastTimer = 0f
        var lastStop = 0f
        for (h in heights(prototypeFull)) {
            val s = LivePanel.shape(h, prototypeFull)
            assertTrue(s.timerSp >= lastTimer)
            assertTrue(s.stopDp >= lastStop)
            assertTrue(s.timerSp in LivePanel.TIMER_SMALLEST_SP..LivePanel.TIMER_FULL_SP)
            assertTrue(s.stopDp in LivePanel.STOP_SMALLEST_DP..LivePanel.STOP_FULL_DP)
            lastTimer = s.timerSp
            lastStop = s.stopDp
        }
    }

    @Test
    fun `the column and the row crossfade, and something is always on screen`() {
        fun at(h: Float) = LivePanel.shape(h, prototypeFull)
        assertEquals(1f, at(190f).columnAlpha, 0.001f)
        assertEquals(0f, at(190f).rowAlpha, 0.001f)
        assertEquals(0f, at(145f).columnAlpha, 0.001f)
        assertEquals(1f, at(145f).rowAlpha, 0.001f)
        for (h in heights(prototypeFull)) {
            val s = at(h)
            assertTrue("nothing drawn at $h", s.columnAlpha + s.rowAlpha >= 0.45f)
        }
    }

    @Test
    fun `thresholds scale with the measured height`() {
        val full = 420f
        val discardAt = compact + LivePanel.DISCARD_FROM * (full - compact)
        assertTrue(LivePanel.shape(discardAt + 0.01f, full).showsDiscard)
        assertFalse(LivePanel.shape(discardAt - 0.01f, full).showsDiscard)
        val meterAt = compact + LivePanel.LEVEL_METER_FROM * (full - compact)
        assertTrue(LivePanel.shape(meterAt + 0.01f, full).showsLevelMeter)
        assertFalse(LivePanel.shape(meterAt - 0.01f, full).showsLevelMeter)
    }

    @Test
    fun `height and fraction round-trip`() {
        for (f in listOf(0f, 0.25f, 0.5f, 1f)) {
            val h = LivePanel.heightDp(f, 340f)
            assertEquals(f, LivePanel.fraction(h, 340f), 0.0001f)
        }
        assertEquals(compact, LivePanel.heightDp(0f, 340f), 0f)
        assertEquals(340f, LivePanel.heightDp(1f, 340f), 0f)
    }

    @Test
    fun `release snaps only near the ends`() {
        val full = 340f
        assertEquals(1f, LivePanel.restingFraction(full, full), 0f)
        assertEquals(1f, LivePanel.restingFraction(full - 23f, full), 0f)
        assertEquals(0f, LivePanel.restingFraction(compact + 39f, full), 0f)
        assertEquals(0f, LivePanel.restingFraction(compact - 10f, full), 0f)
        assertEquals(1f, LivePanel.restingFraction(full + 10f, full), 0f)
        // In between it stays exactly where it was let go.
        val middle = 220f
        assertEquals(LivePanel.fraction(middle, full), LivePanel.restingFraction(middle, full), 0.0001f)
        assertEquals(LivePanel.fraction(full - 30f, full), LivePanel.restingFraction(full - 30f, full), 0.0001f)
        assertEquals(LivePanel.fraction(compact + 45f, full), LivePanel.restingFraction(compact + 45f, full), 0.0001f)
    }

    @Test
    fun `a panel too short to shrink stays open`() {
        assertEquals(1f, LivePanel.restingFraction(compact, compact), 0f)
        assertTrue(LivePanel.shape(compact, compact).showsDiscard)
    }

    @Test
    fun `rubber band follows the finger inside the range and resists outside it`() {
        val full = 340f
        assertEquals(200f, LivePanel.rubberBand(200f, full), 0f)
        assertEquals(full, LivePanel.rubberBand(full, full), 0f)
        assertEquals(compact, LivePanel.rubberBand(compact, full), 0f)

        var last = full
        for (over in listOf(5f, 20f, 80f, 400f, 5000f)) {
            val shown = LivePanel.rubberBand(full + over, full)
            assertTrue(shown > last)
            assertTrue(shown - full < over)
            assertTrue(shown - full < LivePanel.RUBBER_BAND_LIMIT_DP)
            last = shown
        }
        val below = LivePanel.rubberBand(compact - 1000f, full)
        assertTrue(below < compact)
        assertTrue(compact - below < LivePanel.RUBBER_BAND_LIMIT_DP)
    }

    @Test
    fun `a tap on the grabber toggles open and collapsed`() {
        assertEquals(0f, LivePanel.toggledFraction(1f), 0f)
        assertEquals(1f, LivePanel.toggledFraction(0f), 0f)
        assertEquals(1f, LivePanel.toggledFraction(0.6f), 0f)
    }
}
