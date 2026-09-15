package com.pathors.parley.playback

import kotlin.math.abs
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The invented waveform behind demo mode.
 *
 * Two properties, both of them promises the store screenshots depend on: it is
 * deterministic, so a re-capture months later produces identical frames, and it
 * looks like a conversation rather than a flat strip — a screenshot of a flat
 * strip would be a worse advertisement than no waveform at all.
 */
class DemoWaveformTest {

    @Test
    fun `the demo waveform is deterministic and in range`() {
        val first = DemoWaveform.overview("demo-renewal", 1_122_000)
        val second = DemoWaveform.overview("demo-renewal", 1_122_000)
        assertArrayEquals(first.peaks, second.peaks, 0f)
        assertEquals(AudioPeaks.BUCKET_COUNT, first.peaks.size)
        assertTrue(first.peaks.all { it in 0f..1f })
        assertEquals(1_122.0, first.seconds, 1e-9)
    }

    @Test
    fun `the demo waveform has quiet stretches and loud ones`() {
        val peaks = DemoWaveform.overview("demo-renewal", 1_122_000).peaks
        val quiet = peaks.count { it < 0.1f }
        val loud = peaks.count { it > 0.4f }
        // Not a flat line either way: a screenshot of a flat strip would be a
        // worse advertisement than no waveform at all.
        assertTrue("expected some pauses, got $quiet", quiet > 5)
        assertTrue("expected some speech, got $loud", loud > 100)
    }

    @Test
    fun `two demo recordings do not get the same waveform`() {
        val renewal = DemoWaveform.overview("demo-renewal", 600_000).peaks
        val discovery = DemoWaveform.overview("demo-discovery", 600_000).peaks
        val differing = renewal.indices.count { abs(renewal[it] - discovery[it]) > 0.01f }
        assertTrue("waveforms were near-identical", differing > renewal.size / 4)
    }
}
