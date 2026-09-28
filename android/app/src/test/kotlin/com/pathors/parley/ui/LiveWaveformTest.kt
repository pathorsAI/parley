package com.pathors.parley.ui

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The live waveform's arithmetic: bar heights, the fade, the glide, the history ring. */
class LiveWaveformTest {

    @Test
    fun `silence is still a dot and loud speech tops out`() {
        assertEquals(3f, LiveWaveformShape.barHeight(0f, height = 28f, minBar = 3f), 0.0001f)
        assertEquals(28f, LiveWaveformShape.barHeight(1f, height = 28f, minBar = 3f), 0.0001f)
        // Ordinary speech (RMS ~0.1) lands well up the field, not at the floor.
        assertTrue(LiveWaveformShape.barHeight(0.1f, height = 28f, minBar = 3f) > 14f)
    }

    @Test
    fun `the newest bar is brightest and the history is pale`() {
        assertEquals(LiveWaveformShape.FRESH_ALPHA, LiveWaveformShape.opacity(0), 0.0001f)
        assertEquals(
            LiveWaveformShape.HISTORY_ALPHA,
            LiveWaveformShape.opacity(LiveWaveformShape.FRESH_COUNT),
            0.0001f,
        )
        assertEquals(LiveWaveformShape.HISTORY_ALPHA, LiveWaveformShape.opacity(40), 0.0001f)
        for (i in 1 until LiveWaveformShape.FRESH_COUNT) {
            assertTrue(LiveWaveformShape.opacity(i) < LiveWaveformShape.opacity(i - 1))
        }
    }

    @Test
    fun `the glide runs from 0 to 1 across one sample and then holds`() {
        assertEquals(0f, LiveWaveformShape.glide(0L), 0.0001f)
        assertEquals(0.5f, LiveWaveformShape.glide(50_000_000L), 0.0001f)
        assertEquals(1f, LiveWaveformShape.glide(400_000_000L), 0.0001f)
        assertEquals(0f, LiveWaveformShape.glide(-5L), 0.0001f)
    }

    @Test
    fun `a short history is padded with silence in front`() {
        val history = LevelHistory(capacity = 8)
        history.append(0.1f)
        history.append(0.2f)
        assertArrayEquals(floatArrayOf(0f, 0f, 0.1f, 0.2f), history.lastPadded(4), 0f)
    }

    @Test
    fun `the ring keeps the newest values once it wraps`() {
        val history = LevelHistory(capacity = 3)
        listOf(0.1f, 0.2f, 0.3f, 0.4f, 0.5f).forEach(history::append)
        assertEquals(3, history.size)
        assertArrayEquals(floatArrayOf(0.3f, 0.4f, 0.5f), history.lastPadded(3), 0f)
        assertArrayEquals(floatArrayOf(0.4f, 0.5f), history.lastPadded(2), 0f)
        assertArrayEquals(floatArrayOf(0f, 0.3f, 0.4f, 0.5f), history.lastPadded(4), 0f)
    }

    @Test
    fun `clearing starts the next meeting from an empty field`() {
        val history = LevelHistory(capacity = 4)
        history.append(0.4f)
        history.clear()
        assertArrayEquals(floatArrayOf(0f, 0f), history.lastPadded(2), 0f)
    }
}
