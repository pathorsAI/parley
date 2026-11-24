package com.pathors.parley.audio

import org.junit.Assert.assertEquals
import org.junit.Test

/** Where one part of a split import falls in the decoder's 16 kHz s16le output. */
class RangeWindowTest {

    @Test
    fun `no range is the whole file`() {
        val w = RangeWindow.of(null, 10_000_000L, 0L)
        assertEquals(0L, w.skipBytes)
        assertEquals(Long.MAX_VALUE, w.limitBytes)
        assertEquals(10_000_000L, w.durationUs)
    }

    @Test
    fun `a middle part skips back to its start and stops at its end`() {
        // Asked for 10 s..20 s; the seek landed on the sync sample at 9.5 s.
        val w = RangeWindow.of(DecodeRange(10_000_000L, 20_000_000L), 60_000_000L, 9_500_000L)
        assertEquals("0.5 s of 16 kHz s16le", 16_000L, w.skipBytes)
        assertEquals("10 s", 320_000L, w.limitBytes)
        assertEquals(10_000_000L, w.durationUs)
    }

    @Test
    fun `the last part runs to the end of the stream`() {
        val w = RangeWindow.of(DecodeRange(40_000_000L, null), 60_000_000L, 40_000_000L)
        assertEquals(0L, w.skipBytes)
        assertEquals(Long.MAX_VALUE, w.limitBytes)
        assertEquals(20_000_000L, w.durationUs)
    }

    @Test
    fun `a container that could not seek skips from the top`() {
        val w = RangeWindow.of(DecodeRange(3_000_000L, 4_000_000L), -1L, 0L)
        assertEquals(96_000L, w.skipBytes)
        assertEquals(32_000L, w.limitBytes)
    }

    @Test
    fun `byte counts are whole samples`() {
        assertEquals(0L, RangeWindow.bytesFor(62L) % 2)
        assertEquals(2L, RangeWindow.bytesFor(63L))
    }
}
