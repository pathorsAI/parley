package com.pathors.parley.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The scrub's arithmetic — the tiers, the accumulation, the pill, and the
 * TalkBack step — pinned to iOS `ScrubbableWaveform`'s numbers.
 */
class ScrubRulesTest {

    @Test
    fun `the tier comes from the absolute vertical distance`() {
        assertEquals(0, ScrubRules.tierFor(0f))
        assertEquals(0, ScrubRules.tierFor(39.9f))
        assertEquals(1, ScrubRules.tierFor(40f))
        assertEquals(1, ScrubRules.tierFor(-60f))
        assertEquals(2, ScrubRules.tierFor(90f))
        assertEquals(2, ScrubRules.tierFor(-400f))
    }

    @Test
    fun `the tiers are 1x, a quarter and a sixteenth`() {
        assertEquals(listOf(1.0, 0.25, 1.0 / 16), ScrubRules.TIERS.map { it.scale })
        assertEquals(listOf(0f, 40f, 90f), ScrubRules.TIERS.map { it.distanceDp })
    }

    @Test
    fun `full width at 1x is the full duration`() {
        val end = ScrubRules.advance(0.0, 400f, 400f, 60_000L, tier = 0)
        assertEquals(60_000.0, end, 0.001)
    }

    @Test
    fun `the finer tiers scale the movement, not the position`() {
        // 100 px of 400 at 1x is 15 s; the same 100 px in Fine is 3.75 s from
        // wherever the scrub already was — not a quarter of the position.
        val start = 30_000.0
        assertEquals(45_000.0, ScrubRules.advance(start, 100f, 400f, 60_000L, 0), 0.001)
        assertEquals(33_750.0, ScrubRules.advance(start, 100f, 400f, 60_000L, 1), 0.001)
        assertEquals(30_937.5, ScrubRules.advance(start, 100f, 400f, 60_000L, 2), 0.001)
    }

    @Test
    fun `crossing into a finer tier mid-drag does not jump the time`() {
        var time = 20_000.0
        time = ScrubRules.advance(time, 50f, 400f, 60_000L, 0)
        val atCrossing = time
        // The first move in the new tier with no horizontal movement stays put.
        time = ScrubRules.advance(time, 0f, 400f, 60_000L, 1)
        assertEquals(atCrossing, time, 0.0)
    }

    @Test
    fun `the time is clamped to the file`() {
        assertEquals(0.0, ScrubRules.advance(1_000.0, -400f, 400f, 60_000L, 0), 0.0)
        assertEquals(60_000.0, ScrubRules.advance(59_000.0, 400f, 400f, 60_000L, 0), 0.0)
    }

    @Test
    fun `no width or no duration moves nothing`() {
        assertEquals(5_000.0, ScrubRules.advance(5_000.0, 100f, 0f, 60_000L, 0), 0.0)
        assertEquals(5_000.0, ScrubRules.advance(5_000.0, 100f, 400f, 0L, 0), 0.0)
    }

    @Test
    fun `the pill centres over the finger and stays inside the strip`() {
        // Centred, and pushed down to the strip's top because the strip is
        // shorter than the pill plus its gap.
        assertEquals(150f to 0f, ScrubRules.pillOffset(200f, 10f, 100f, 28f, 400f, 36f, 12f))
        // Clamped at both ends.
        assertEquals(0f to 0f, ScrubRules.pillOffset(5f, 10f, 100f, 28f, 400f, 36f, 12f))
        assertEquals(300f to 0f, ScrubRules.pillOffset(399f, 10f, 100f, 28f, 400f, 36f, 12f))
        // A pill taller than the strip sits at its top rather than above it.
        assertEquals(150f to 0f, ScrubRules.pillOffset(200f, -80f, 100f, 44f, 400f, 36f, 12f))
        // Room below the pill: it sits the gap above the finger.
        assertEquals(150f to 50f, ScrubRules.pillOffset(200f, 90f, 100f, 28f, 400f, 200f, 12f))
    }

    @Test
    fun `a session starts where the playhead was and a touch alone moves nothing`() {
        val session = ScrubSession(startMs = 12_000L, downX = 100f, downY = 10f)
        assertEquals(12_000L, session.currentMs)
        val changed = session.move(x = 100f, y = 10f, pxPerDp = 2f, widthPx = 400f, durationMs = 60_000L)
        assertEquals(false, changed)
        assertEquals(12_000L, session.currentMs)
    }

    @Test
    fun `a session accumulates per tier and reports each tier change once`() {
        val session = ScrubSession(startMs = 30_000L, downX = 200f, downY = 0f)
        // 2 px per dp: 80 px down is 40 dp — Fine.
        assertEquals(true, session.move(x = 200f, y = 80f, pxPerDp = 2f, widthPx = 400f, durationMs = 60_000L))
        assertEquals(1, session.tier)
        assertEquals(false, session.move(x = 300f, y = 80f, pxPerDp = 2f, widthPx = 400f, durationMs = 60_000L))
        assertEquals(33_750L, session.currentMs)
        // Back up to the strip: 1x again, and a tick.
        assertEquals(true, session.move(x = 300f, y = 0f, pxPerDp = 2f, widthPx = 400f, durationMs = 60_000L))
        assertEquals(0, session.tier)
        assertEquals(33_750L, session.currentMs)
    }

    @Test
    fun `a TalkBack step is exactly 15 seconds`() {
        for (duration in listOf(1_000L, 15_000L, 16_000L, 61_500L, 2_400_000L)) {
            val range = ScrubRules.accessibilityRange(duration)
            val increment = range.endSeconds / (range.steps + 1)
            assertEquals("duration $duration", 15f, increment, 0.0001f)
            assertTrue("range covers $duration", range.endSeconds * 1000 >= duration)
        }
    }
}
