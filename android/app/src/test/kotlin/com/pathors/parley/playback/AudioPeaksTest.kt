package com.pathors.parley.playback

import com.pathors.parley.audio.Pcm
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlin.random.Random
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The waveform is the one part of playback with real arithmetic in it and no
 * Android dependency, so it is exercised properly here.
 *
 * Three things have to hold, and each is a bug that would be invisible on
 * screen until somebody scrubbed with it: the energy of the source has to
 * survive the reduction, **chunking must not change the result** (a 20 ms
 * window that restarted at every decoder boundary would measure the file the
 * decoder happened to produce rather than the file), and a cache round trip
 * has to be exact.
 */
class AudioPeaksTest {

    // ------------------------------------------------------------------ helpers

    /** s16le bytes for [samples] floats in [-1, 1]. */
    private fun pcm(samples: FloatArray): ByteArray = Pcm.floatToS16le(samples)

    /** [seconds] of a constant-amplitude square-ish signal at 16 kHz. */
    private fun tone(seconds: Double, amplitude: Float): FloatArray =
        FloatArray((Pcm.SAMPLE_RATE * seconds).toInt()) { index ->
            if (index % 2 == 0) amplitude else -amplitude
        }

    private fun overviewOf(samples: FloatArray, buckets: Int = 16): AudioPeaks.Overview? {
        val accumulator = AudioPeaks.Accumulator()
        accumulator.add(pcm(samples))
        return accumulator.finish(buckets)
    }

    // ------------------------------------------------------------------ energy

    @Test
    fun `a constant tone measures its own amplitude in every bucket`() {
        val overview = overviewOf(tone(seconds = 2.0, amplitude = 0.5f), buckets = 20)
        assertNotNull(overview)
        overview!!
        assertEquals(20, overview.peaks.size)
        overview.peaks.forEach { value ->
            assertEquals(0.5f, value, 0.01f)
        }
    }

    @Test
    fun `silence measures as silence rather than as nothing`() {
        val overview = overviewOf(FloatArray(Pcm.SAMPLE_RATE), buckets = 8)
        assertNotNull(overview)
        overview!!.peaks.forEach { value -> assertEquals(0f, value, 1e-6f) }
    }

    @Test
    fun `a loud half and a quiet half land in the right halves`() {
        val loud = tone(seconds = 1.0, amplitude = 0.8f)
        val quiet = tone(seconds = 1.0, amplitude = 0.1f)
        val overview = overviewOf(loud + quiet, buckets = 10)!!

        overview.peaks.take(5).forEach { assertEquals(0.8f, it, 0.02f) }
        overview.peaks.drop(5).forEach { assertEquals(0.1f, it, 0.02f) }
    }

    @Test
    fun `duration comes from the samples fed in, not from the container`() {
        val overview = overviewOf(tone(seconds = 3.5, amplitude = 0.3f))!!
        assertEquals(3.5, overview.seconds, 1e-6)
    }

    @Test
    fun `an empty accumulator has no overview to give`() {
        assertNull(AudioPeaks.Accumulator().finish())
    }

    @Test
    fun `the tail window is measured rather than dropped`() {
        // Half a window: 10 ms, which the 20 ms pass would otherwise discard.
        val samples = FloatArray(AudioPeaks.WINDOW_SAMPLES / 2) { 0.6f }
        val overview = overviewOf(samples, buckets = 4)!!
        overview.peaks.forEach { assertEquals(0.6f, it, 0.01f) }
    }

    // ------------------------------------------------------- chunk independence

    @Test
    fun `chunking the same audio produces the same peaks`() {
        val random = Random(20_260_915)
        val samples = FloatArray(Pcm.SAMPLE_RATE * 5) { random.nextFloat() * 2f - 1f }
        val bytes = pcm(samples)

        val whole = AudioPeaks.Accumulator().apply { add(bytes) }.finish(64)!!

        // Deliberately awkward sizes: odd multiples that never line up with the
        // 640-byte window, which is exactly the case a naive implementation
        // gets wrong.
        listOf(3_200, 641, 7, 100_000).forEach { chunk ->
            val accumulator = AudioPeaks.Accumulator()
            var offset = 0
            while (offset < bytes.size) {
                // Sample-aligned, because that is all a PCM decoder promises.
                val length = minOf(chunk / 2 * 2, bytes.size - offset)
                accumulator.add(bytes, offset, length)
                offset += length
            }
            val chunked = accumulator.finish(64)!!
            assertEquals("chunk size $chunk changed the duration", whole.seconds, chunked.seconds, 1e-9)
            assertArrayEquals("chunk size $chunk changed the peaks", whole.peaks, chunked.peaks, 1e-6f)
        }
    }

    // --------------------------------------------------------------- resampling

    @Test
    fun `resampling to the same count is the identity`() {
        val values = floatArrayOf(0.1f, 0.2f, 0.3f)
        assertArrayEquals(values, AudioPeaks.resample(values, 3), 0f)
    }

    @Test
    fun `stretching repeats rather than interpolating`() {
        // A three-second clip should read as the handful of marks it is.
        val stretched = AudioPeaks.resample(floatArrayOf(0f, 1f), 6)
        assertArrayEquals(floatArrayOf(0f, 0f, 0f, 1f, 1f, 1f), stretched, 0f)
    }

    @Test
    fun `reducing combines as RMS, so one spike does not flatten the bar`() {
        // 99 silent windows and one clipped one. Taking the maximum would draw
        // a full-height bar; averaging energy draws a tenth of one.
        val values = FloatArray(100).also { it[50] = 1f }
        val reduced = AudioPeaks.resample(values, 1)
        assertEquals(1, reduced.size)
        assertEquals(0.1f, reduced[0], 1e-5f)
    }

    @Test
    fun `reducing preserves total energy across buckets`() {
        val random = Random(7)
        val values = FloatArray(4_000) { random.nextFloat() }
        val reduced = AudioPeaks.resample(values, 400)

        fun energy(array: FloatArray) = array.sumOf { it.toDouble() * it } / array.size
        assertEquals(energy(values), energy(reduced), 1e-6)
    }

    @Test
    fun `resampling to a non-positive count is empty rather than a crash`() {
        assertEquals(0, AudioPeaks.resample(floatArrayOf(1f), 0).size)
        assertEquals(0, AudioPeaks.resample(floatArrayOf(1f), -4).size)
    }

    @Test
    fun `resampling nothing gives the requested number of zeroes`() {
        val zeroes = AudioPeaks.resample(FloatArray(0), 5)
        assertEquals(5, zeroes.size)
        zeroes.forEach { assertEquals(0f, it, 0f) }
    }

    // -------------------------------------------------------------- the cache

    @Test
    fun `a cache round trip is exact`() {
        val original = AudioPeaks.Overview(
            peaks = FloatArray(AudioPeaks.BUCKET_COUNT) { it / 400f },
            seconds = 4_437.5,
        )
        val decoded = AudioPeaks.decode(AudioPeaks.encode(original))
        assertNotNull(decoded)
        assertArrayEquals(original.peaks, decoded!!.peaks, 0f)
        // `seconds` is stored as a Float32, so it round-trips to float precision.
        assertEquals(original.seconds, decoded.seconds, 1e-3)
    }

    @Test
    fun `the cache file is the header plus one float per bucket`() {
        val encoded = AudioPeaks.encode(AudioPeaks.Overview(FloatArray(400), 1.0))
        assertEquals(16 + 400 * 4, encoded.size)
    }

    @Test
    fun `the magic is PKW1, readable in a hex dump`() {
        val encoded = AudioPeaks.encode(AudioPeaks.Overview(FloatArray(1), 1.0))
        assertEquals("PKW1", String(encoded.copyOfRange(0, 4), Charsets.US_ASCII))
    }

    @Test
    fun `a foreign or truncated cache decodes to null rather than throwing`() {
        assertNull(AudioPeaks.decode(ByteArray(0)))
        assertNull(AudioPeaks.decode(ByteArray(8)))
        assertNull(AudioPeaks.decode("not a peaks file at all".toByteArray()))

        val valid = AudioPeaks.encode(AudioPeaks.Overview(FloatArray(400) { 0.5f }, 10.0))
        // A write that was cut off mid-payload: the header still claims 400.
        assertNull(AudioPeaks.decode(valid.copyOfRange(0, valid.size - 40)))
    }

    @Test
    fun `a cache claiming a negative bucket count is refused`() {
        val valid = AudioPeaks.encode(AudioPeaks.Overview(FloatArray(4) { 0.5f }, 10.0))
        // Overwrite the little-endian count with -1.
        valid[4] = -1; valid[5] = -1; valid[6] = -1; valid[7] = -1
        assertNull(AudioPeaks.decode(valid))
    }

    // ------------------------------------------------------------- end to end

    @Test
    fun `a synthetic conversation keeps its shape through the whole pipeline`() {
        // Two seconds loud, one silent, two quiet — what a turn and a pause
        // look like. Fed in 100 ms chunks, the way the decoder emits them.
        val script = tone(2.0, 0.7f) + FloatArray(Pcm.SAMPLE_RATE) + tone(2.0, 0.2f)
        val bytes = pcm(script)
        val accumulator = AudioPeaks.Accumulator()
        var offset = 0
        while (offset < bytes.size) {
            val length = minOf(Pcm.CHUNK_BYTES, bytes.size - offset)
            accumulator.add(bytes, offset, length)
            offset += length
        }
        val overview = accumulator.finish(50)!!
        assertEquals(5.0, overview.seconds, 1e-6)

        // 50 buckets over 5 seconds: 10 per second.
        val loud = overview.peaks.copyOfRange(0, 20)
        val quiet = overview.peaks.copyOfRange(20, 30)
        val soft = overview.peaks.copyOfRange(30, 50)

        assertTrue(loud.all { abs(it - 0.7f) < 0.02f })
        assertTrue(quiet.all { it < 0.01f })
        assertTrue(soft.all { abs(it - 0.2f) < 0.02f })
    }

    @Test
    fun `a real-length recording reduces to the cached bucket count`() {
        // 74 minutes — the length iOS's seek bug was found on. Built as coarse
        // values rather than as samples, because the point here is the
        // reduction, not the decode.
        val coarse = FloatArray(74 * 60 * 1000 / 20) { index ->
            (index % 97) / 97f
        }
        val reduced = AudioPeaks.resample(coarse, AudioPeaks.BUCKET_COUNT)
        assertEquals(AudioPeaks.BUCKET_COUNT, reduced.size)
        assertTrue(reduced.all { it in 0f..1f })
        // Nothing collapsed to zero: every bucket saw part of the ramp.
        assertTrue(reduced.all { it > 0.1f })
    }

    // ----------------------------------------------------- amplitude sanity

    @Test
    fun `peaks track amplitude monotonically`() {
        val measured = listOf(0.1f, 0.25f, 0.5f, 0.9f).map { amplitude ->
            overviewOf(tone(0.5, amplitude), buckets = 4)!!.peaks.average().toFloat()
        }
        measured.zipWithNext { lower, higher ->
            assertTrue("$lower should be below $higher", lower < higher)
        }
        // And they are the amplitudes themselves, not some scaled version.
        assertEquals(0.9f, measured.last(), 0.02f)
    }

    @Test
    fun `the bucket count is what a phone-width strip can use`() {
        // ~130 bars at 3dp on a 430dp screen; 400 leaves room to spare and
        // costs 1.6 KB. Pinned so a change to it is a deliberate one.
        assertEquals(400, AudioPeaks.BUCKET_COUNT)
        assertEquals(20, (AudioPeaks.WINDOW_SAMPLES * 1000.0 / Pcm.SAMPLE_RATE).roundToInt())
    }
}
