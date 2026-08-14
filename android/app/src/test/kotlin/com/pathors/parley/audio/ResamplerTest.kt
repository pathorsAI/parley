package com.pathors.parley.audio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.random.Random

/**
 * The resampler is the one piece of the audio layer with real signal-processing
 * risk *and* no Android dependency, so it gets properly exercised here: a tone
 * has to survive, an out-of-band tone has to disappear, and chunking must not
 * change the result by a single bit.
 */
class ResamplerTest {

    // ------------------------------------------------------------------ helpers

    private fun sine(freq: Double, rate: Int, seconds: Double, amplitude: Float = 0.8f) =
        FloatArray((rate * seconds).toInt()) { i ->
            (amplitude * sin(2.0 * PI * freq * i / rate)).toFloat()
        }

    /** Run a whole buffer through a fresh resampler, including the tail. */
    private fun convert(
        input: FloatArray,
        inRate: Int,
        outRate: Int = Pcm.SAMPLE_RATE,
        quality: Resampler.Quality = Resampler.Quality.BALANCED,
    ): FloatArray {
        val resampler = Resampler(inRate, outRate, quality)
        return resampler.process(input) + resampler.flush()
    }

    private fun rms(x: FloatArray, from: Int = 0, to: Int = x.size): Float {
        var sum = 0.0
        for (i in from until to) sum += x[i].toDouble() * x[i]
        return sqrt(sum / (to - from)).toFloat()
    }

    private fun peak(x: FloatArray, from: Int = 0, to: Int = x.size): Float {
        var m = 0f
        for (i in from until to) m = maxOf(m, abs(x[i]))
        return m
    }

    /** Frequency estimate from zero crossings — enough to catch pitch errors. */
    private fun zeroCrossingFrequency(x: FloatArray, from: Int, to: Int, rate: Int): Double {
        var crossings = 0
        for (i in from + 1 until to) {
            if ((x[i - 1] < 0f) != (x[i] < 0f)) crossings++
        }
        return crossings * rate / (2.0 * (to - from))
    }

    // -------------------------------------------------------------------- tests

    @Test
    fun `44k1 to 16k preserves a 1 kHz tone`() {
        val input = sine(1000.0, 44_100, 1.0)
        val out = convert(input, 44_100)

        assertEquals(16_000.0, out.size.toDouble(), 2.0)

        // Interior only: the first/last few dozen samples ride the edge taper.
        val from = 500
        val to = out.size - 500
        assertEquals("amplitude", 0.8f / sqrt(2f), rms(out, from, to), 0.01f)
        assertEquals(
            "pitch",
            1000.0,
            zeroCrossingFrequency(out, from, to, Pcm.SAMPLE_RATE),
            5.0,
        )
    }

    @Test
    fun `out of band content is filtered instead of aliased`() {
        // 15 kHz at 44.1 kHz is legal input but has no home below the 8 kHz output
        // Nyquist. A linear interpolator folds it onto 1 kHz at roughly -20 dB;
        // the windowed-sinc kernel has to bury it instead.
        val input = sine(15_000.0, 44_100, 0.5, amplitude = 1.0f)
        val out = convert(input, 44_100)

        val residual = rms(out, 500, out.size - 500)
        assertTrue("alias residual should be tiny, was $residual", residual < 0.01f)
    }

    @Test
    fun `48k to 16k preserves a 3 kHz tone and kills a 20 kHz one`() {
        val tone = convert(sine(3000.0, 48_000, 0.5), 48_000)
        assertEquals(0.8f / sqrt(2f), rms(tone, 500, tone.size - 500), 0.01f)

        val alias = convert(sine(20_000.0, 48_000, 0.5, amplitude = 1.0f), 48_000)
        assertTrue(rms(alias, 500, alias.size - 500) < 0.01f)
    }

    @Test
    fun `upsampling 8k to 16k keeps the tone and doubles the length`() {
        val input = sine(500.0, 8_000, 0.5)
        val out = convert(input, 8_000)

        assertEquals(8_000.0, out.size.toDouble(), 2.0)
        assertEquals(0.8f / sqrt(2f), rms(out, 200, out.size - 200), 0.02f)
        assertEquals(
            500.0,
            zeroCrossingFrequency(out, 200, out.size - 200, Pcm.SAMPLE_RATE),
            5.0,
        )
    }

    @Test
    fun `streaming in ragged chunks matches a single call`() {
        val input = sine(700.0, 44_100, 0.5) + sine(2300.0, 44_100, 0.5)
        val oneShot = convert(input, 44_100)

        val streaming = Resampler(44_100, Pcm.SAMPLE_RATE)
        val collected = ArrayList<Float>(oneShot.size)
        val random = Random(1234)
        var offset = 0
        while (offset < input.size) {
            val n = minOf(1 + random.nextInt(2000), input.size - offset)
            val slice = input.copyOfRange(offset, offset + n)
            for (v in streaming.process(slice)) collected.add(v)
            offset += n
        }
        for (v in streaming.flush()) collected.add(v)

        assertEquals("sample count", oneShot.size, collected.size)
        for (i in oneShot.indices) {
            // Both paths do the same arithmetic in the same order; the tolerance
            // is only there for the last bit of the history-buffer bookkeeping.
            // A phase or continuity bug shows up around 1e-1, not 1e-6.
            assertEquals("sample $i", oneShot[i], collected[i], 1e-6f)
        }
    }

    @Test
    fun `equal rates are an exact passthrough`() {
        val input = sine(1000.0, Pcm.SAMPLE_RATE, 0.1)
        val resampler = Resampler(Pcm.SAMPLE_RATE, Pcm.SAMPLE_RATE)
        assertTrue(resampler.isPassthrough)

        val out = resampler.process(input) + resampler.flush()
        assertEquals(input.size, out.size)
        for (i in input.indices) assertEquals(input[i], out[i], 0f)
    }

    @Test
    fun `dc gain is unity`() {
        val input = FloatArray(20_000) { 0.5f }
        val out = convert(input, 44_100)
        val from = 300
        val to = out.size - 300
        for (i in from until to) {
            assertEquals("sample $i", 0.5f, out[i], 1e-3f)
        }
    }

    @Test
    fun `output length matches the prediction`() {
        for (rate in intArrayOf(8_000, 11_025, 22_050, 32_000, 44_100, 48_000, 96_000)) {
            val input = sine(440.0, rate, 0.37)
            val resampler = Resampler(rate, Pcm.SAMPLE_RATE)
            val produced = resampler.process(input).size + resampler.flush().size
            assertEquals(
                "rate $rate",
                resampler.expectedOutputCount(input.size.toLong()).toInt(),
                produced,
            )
        }
    }

    @Test
    fun `reset starts a clean stream`() {
        val input = sine(1000.0, 44_100, 0.2)
        val resampler = Resampler(44_100, Pcm.SAMPLE_RATE)
        val first = resampler.process(input) + resampler.flush()
        resampler.reset()
        val second = resampler.process(input) + resampler.flush()

        assertEquals(first.size, second.size)
        for (i in first.indices) assertEquals(first[i], second[i], 0f)
    }

    @Test
    fun `an empty stream produces nothing`() {
        val resampler = Resampler(44_100, Pcm.SAMPLE_RATE)
        assertEquals(0, resampler.process(FloatArray(0)).size)
        assertEquals(0, resampler.flush().size)
    }

    @Test
    fun `fast quality is still aliasing free`() {
        val out = convert(
            sine(15_000.0, 44_100, 0.5, amplitude = 1.0f),
            44_100,
            quality = Resampler.Quality.FAST,
        )
        assertTrue(rms(out, 500, out.size - 500) < 0.02f)

        val tone = convert(sine(1000.0, 44_100, 0.5), 44_100, quality = Resampler.Quality.FAST)
        assertEquals(0.8f, peak(tone, 500, tone.size - 500), 0.03f)
    }
}
