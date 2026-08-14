package com.pathors.parley.audio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.sin

/**
 * Byte-level conversions and the decoder's PCM sink. Everything here is pure
 * JVM; the MediaCodec/MediaMuxer halves of the audio layer are covered by the
 * manual checklist in `android/docs/api-audio.md`.
 */
class PcmConversionTest {

    // -------------------------------------------------------------- Pcm helpers

    @Test
    fun `downmix averages channels`() {
        val stereo = floatArrayOf(1f, 0f, 0.5f, -0.5f, -1f, -1f)
        val mono = FloatArray(3)
        Pcm.downmixToMono(stereo, 3, 2, mono)
        assertEquals(0.5f, mono[0], 1e-6f)
        assertEquals(0.0f, mono[1], 1e-6f)
        assertEquals(-1.0f, mono[2], 1e-6f)
    }

    @Test
    fun `downmix of mono is a copy`() {
        val src = floatArrayOf(0.1f, -0.2f, 0.3f)
        val out = FloatArray(3)
        Pcm.downmixToMono(src, 3, 1, out)
        assertEquals(0.1f, out[0], 1e-6f)
        assertEquals(-0.2f, out[1], 1e-6f)
        assertEquals(0.3f, out[2], 1e-6f)
    }

    @Test
    fun `float to s16le is little endian and clamped`() {
        val bytes = Pcm.floatToS16le(floatArrayOf(1f, -1f, 0f, 2f, -2f))

        assertEquals(10, bytes.size)
        // +32767 = 0x7FFF -> FF 7F
        assertEquals(0xFF.toByte(), bytes[0])
        assertEquals(0x7F.toByte(), bytes[1])
        // -32767 = 0x8001 -> 01 80
        assertEquals(0x01.toByte(), bytes[2])
        assertEquals(0x80.toByte(), bytes[3])
        // silence
        assertEquals(0x00.toByte(), bytes[4])
        assertEquals(0x00.toByte(), bytes[5])
        // out-of-range input clamps rather than wrapping
        assertEquals(0x7F.toByte(), bytes[7])
        assertEquals(0x80.toByte(), bytes[9])
    }

    @Test
    fun `s16le round trips through float`() {
        val original = FloatArray(256) { sin(it / 8.0).toFloat() * 0.9f }
        val bytes = Pcm.floatToS16le(original)
        val decoded = FloatArray(original.size)
        assertEquals(original.size, Pcm.s16leToFloat(bytes, 0, bytes.size, decoded))
        for (i in original.indices) {
            assertEquals("sample $i", original[i], decoded[i], 1f / 32767f)
        }
    }

    @Test
    fun `rms of full scale square wave is one`() {
        val samples = FloatArray(1000) { if (it % 2 == 0) 1f else -1f }
        assertEquals(1f, Pcm.rmsFromS16le(Pcm.floatToS16le(samples)), 1e-3f)
        assertEquals(0f, Pcm.rmsFromS16le(Pcm.floatToS16le(FloatArray(1000))), 1e-6f)
    }

    // ---------------------------------------------------------------- Pcm16Sink

    private fun interleavedS16le(frames: Int, channels: Int, rate: Int, freq: Double): ByteBuffer {
        val buffer = ByteBuffer.allocate(frames * channels * 2).order(ByteOrder.LITTLE_ENDIAN)
        for (f in 0 until frames) {
            val v = (0.8 * sin(2.0 * PI * freq * f / rate) * 32767).toInt().toShort()
            for (c in 0 until channels) buffer.putShort(v)
        }
        buffer.clear()
        return buffer
    }

    @Test
    fun `sink turns stereo 32k into mono 16k chunks`() {
        val frames = 16_123
        val buffer = interleavedS16le(frames, channels = 2, rate = 32_000, freq = 1000.0)
        val sink = Pcm16Sink(32_000, 2, Resampler.Quality.BALANCED, Pcm.CHUNK_BYTES)
        val chunks = ArrayList<ByteArray>()

        // Two frame-aligned feeds, as a decoder would hand them over.
        val split = 8_000 * 2 * 2
        sink.feed(buffer, 0, split, Pcm.ENCODING_PCM_16BIT, chunks)
        sink.feed(buffer, split, frames * 2 * 2 - split, Pcm.ENCODING_PCM_16BIT, chunks)
        sink.finish(chunks)

        val expectedSamples = Resampler(32_000, Pcm.SAMPLE_RATE)
            .expectedOutputCount(frames.toLong())
        val expectedBytes = expectedSamples * Pcm.BYTES_PER_SAMPLE
        assertEquals(expectedBytes, sink.totalOutputBytes)
        assertEquals(expectedBytes, chunks.sumOf { it.size.toLong() })

        // Every chunk but the last is exactly one 100 ms chunk.
        for (i in 0 until chunks.size - 1) {
            assertEquals("chunk $i", Pcm.CHUNK_BYTES, chunks[i].size)
        }
        assertTrue(chunks.last().size in 1..Pcm.CHUNK_BYTES)

        // And it is still a 1 kHz tone.
        val joined = ByteArray(expectedBytes.toInt())
        var at = 0
        for (chunk in chunks) {
            System.arraycopy(chunk, 0, joined, at, chunk.size)
            at += chunk.size
        }
        val samples = FloatArray(expectedSamples.toInt())
        Pcm.s16leToFloat(joined, 0, joined.size, samples)
        var crossings = 0
        val from = 500
        val to = samples.size - 500
        for (i in from + 1 until to) {
            if ((samples[i - 1] < 0f) != (samples[i] < 0f)) crossings++
        }
        assertEquals(
            1000.0,
            crossings * Pcm.SAMPLE_RATE / (2.0 * (to - from)),
            5.0,
        )
    }

    @Test
    fun `sink reads float pcm and passes 16k through untouched`() {
        val samples = FloatArray(400) { (0.5 * sin(it / 5.0)).toFloat() }
        val buffer = ByteBuffer.allocate(samples.size * 4).order(ByteOrder.LITTLE_ENDIAN)
        for (s in samples) buffer.putFloat(s)
        buffer.clear()

        val sink = Pcm16Sink(Pcm.SAMPLE_RATE, 1, Resampler.Quality.BALANCED, Pcm.CHUNK_BYTES)
        val chunks = ArrayList<ByteArray>()
        sink.feed(buffer, 0, samples.size * 4, Pcm.ENCODING_PCM_FLOAT, chunks)
        sink.finish(chunks)

        assertEquals(1, chunks.size)
        assertEquals(samples.size * 2, chunks[0].size)
        val decoded = FloatArray(samples.size)
        Pcm.s16leToFloat(chunks[0], 0, chunks[0].size, decoded)
        for (i in samples.indices) {
            assertEquals("sample $i", samples[i], decoded[i], 1f / 32767f)
        }
    }

    @Test
    fun `sink rejects a pcm encoding it cannot read`() {
        val sink = Pcm16Sink(Pcm.SAMPLE_RATE, 1, Resampler.Quality.BALANCED, Pcm.CHUNK_BYTES)
        assertThrows(AudioDecodeException.DecodeFailed::class.java) {
            sink.feed(ByteBuffer.allocate(64), 0, 64, 999, ArrayList())
        }
    }

    // ------------------------------------------------------------- Opus headers

    @Test
    fun `synthesized OpusHead matches the desktop encoder`() {
        val head = OggOpusEncoder.buildOpusHead()
        assertEquals(19, head.size)
        assertEquals("OpusHead", String(head, 0, 8, Charsets.US_ASCII))

        val buffer = ByteBuffer.wrap(head).order(ByteOrder.LITTLE_ENDIAN)
        assertEquals(1, buffer.get(8).toInt())            // version
        assertEquals(1, buffer.get(9).toInt())            // mono
        assertEquals(312, buffer.getShort(10).toInt())    // pre-skip
        assertEquals(16_000, buffer.getInt(12))           // original input rate
        assertEquals(0, buffer.getShort(16).toInt())      // output gain
        assertEquals(0, buffer.get(18).toInt())           // mapping family
    }
}
