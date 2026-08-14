package com.pathors.parley.audio

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Constants shared by every stage of the Android audio pipeline.
 *
 * The universal internal format is **16 kHz mono s16le PCM** — the same format
 * the desktop (`TARGET_SAMPLE_RATE`) and iOS (`SonioxProtocol.sampleRate`) paths
 * produce, and what the relay meters at 32 000 bytes/s.
 */
object Pcm {
    /** Universal internal sample rate. */
    const val SAMPLE_RATE: Int = 16_000

    /** Bytes per sample in the internal format (s16le). */
    const val BYTES_PER_SAMPLE: Int = 2

    /** Bytes per second of internal-format audio: 32 000. */
    const val BYTES_PER_SECOND: Int = SAMPLE_RATE * BYTES_PER_SAMPLE

    /** Default streaming chunk duration. 100 ms = 1600 samples = 3200 bytes. */
    const val CHUNK_MILLIS: Int = 100

    /** Default streaming chunk size in bytes. */
    const val CHUNK_BYTES: Int = SAMPLE_RATE * CHUNK_MILLIS / 1000 * BYTES_PER_SAMPLE

    /**
     * PCM sample encodings we can consume from a decoder.
     *
     * These deliberately mirror the numeric values of `android.media.AudioFormat`
     * (`ENCODING_PCM_16BIT` = 2, …) *without referencing the Android class*, so
     * the conversion code stays pure JVM and therefore unit-testable.
     */
    const val ENCODING_PCM_16BIT: Int = 2
    const val ENCODING_PCM_8BIT: Int = 3
    const val ENCODING_PCM_FLOAT: Int = 4
    const val ENCODING_PCM_24BIT_PACKED: Int = 21
    const val ENCODING_PCM_32BIT: Int = 22

    /** Bytes occupied by one sample of [encoding], or 0 when we cannot decode it. */
    fun bytesPerSample(encoding: Int): Int = when (encoding) {
        ENCODING_PCM_8BIT -> 1
        ENCODING_PCM_16BIT -> 2
        ENCODING_PCM_24BIT_PACKED -> 3
        ENCODING_PCM_FLOAT, ENCODING_PCM_32BIT -> 4
        else -> 0
    }

    /**
     * Average `channels` interleaved channels of [interleaved] into mono, writing
     * `frames` floats into [out]. Matches the desktop downmix (plain mean).
     */
    fun downmixToMono(interleaved: FloatArray, frames: Int, channels: Int, out: FloatArray) {
        require(channels >= 1) { "channels must be >= 1" }
        if (channels == 1) {
            System.arraycopy(interleaved, 0, out, 0, frames)
            return
        }
        val inv = 1f / channels
        var src = 0
        for (f in 0 until frames) {
            var acc = 0f
            for (c in 0 until channels) {
                acc += interleaved[src++]
            }
            out[f] = acc * inv
        }
    }

    /**
     * Convert `count` floats in [-1, 1] to s16le bytes appended at [outOffset].
     * Values outside the range are clamped (never wrapped). Scale is 32767, the
     * same convention as the desktop encoder.
     *
     * Rounds to nearest rather than truncating: truncation biases every sample
     * toward zero by up to a full LSB, which is what makes a float → s16 → float
     * round trip drift outside one LSB (see `PcmConversionTest`).
     */
    fun floatToS16le(samples: FloatArray, count: Int, out: ByteArray, outOffset: Int): Int {
        var o = outOffset
        for (i in 0 until count) {
            val v = (samples[i].coerceIn(-1f, 1f) * 32767f).roundToInt()
            out[o++] = (v and 0xFF).toByte()
            out[o++] = ((v shr 8) and 0xFF).toByte()
        }
        return count * BYTES_PER_SAMPLE
    }

    /** Allocating variant of [floatToS16le]. */
    fun floatToS16le(samples: FloatArray, count: Int = samples.size): ByteArray {
        val out = ByteArray(count * BYTES_PER_SAMPLE)
        floatToS16le(samples, count, out, 0)
        return out
    }

    /**
     * Decode s16le bytes into floats in [-1, 1]. Returns the sample count written.
     *
     * Scale is 32767 — the exact inverse of [floatToS16le], so a round trip is
     * accurate to half an LSB. (-32768, which only a foreign encoder produces,
     * decodes to a hair below -1 and is clamped on the way back.)
     */
    fun s16leToFloat(bytes: ByteArray, offset: Int, length: Int, out: FloatArray): Int {
        val n = min(length / BYTES_PER_SAMPLE, out.size)
        val sb = ByteBuffer.wrap(bytes, offset, n * BYTES_PER_SAMPLE)
            .order(ByteOrder.LITTLE_ENDIAN)
            .asShortBuffer()
        for (i in 0 until n) {
            out[i] = (sb.get().toFloat() / 32767f).coerceIn(-1f, 1f)
        }
        return n
    }

    /** RMS level in [0, 1] of an s16le buffer — cheap enough for a UI level meter. */
    fun rmsFromS16le(bytes: ByteArray, offset: Int = 0, length: Int = bytes.size - offset): Float {
        val n = length / BYTES_PER_SAMPLE
        if (n <= 0) return 0f
        var sum = 0.0
        var i = offset
        val end = offset + n * BYTES_PER_SAMPLE
        while (i < end) {
            val lo = bytes[i].toInt() and 0xFF
            val hi = bytes[i + 1].toInt() // sign-extends: this is the high byte of a LE s16
            val v = ((hi shl 8) or lo).toShort().toDouble() / 32768.0
            sum += v * v
            i += 2
        }
        return sqrt(sum / n).toFloat()
    }
}

/**
 * Streaming, aliasing-free sample-rate converter (arbitrary input rate → any
 * output rate, in practice [Pcm.SAMPLE_RATE]). Pure Kotlin, no Android types, so
 * it is fully unit-testable on the JVM.
 *
 * ## Why not linear interpolation
 *
 * The desktop app resamples with a linear interpolator (`audio/resample.rs`).
 * That is a *terrible* anti-alias filter: for 44 100 → 16 000 everything above
 * 8 kHz in the source folds back into the audible band (a 15 kHz component lands
 * on 1 kHz at roughly −20 dB). It is tolerable there only because the desktop
 * captures at rates close to the target. For file import — where 44.1/48 kHz
 * music-grade sources are the norm — it is not good enough, so this class
 * implements proper band-limited interpolation instead.
 *
 * ## Design: windowed-sinc band-limited interpolation
 *
 * Output sample `n` sits at input position `p = n · inputRate / outputRate`
 * (fractional). Its value is the convolution of the input with a continuous
 * low-pass kernel evaluated at the distance from each nearby input sample:
 *
 * ```
 * h(x) = fc · sinc(fc · x) · kaiser(x / halfWidth)      |x| ≤ halfWidth
 * y[n] = Σ x[i] · h(i − p)   for i ∈ [⌈p − halfWidth⌉, ⌊p + halfWidth⌋]
 * ```
 *
 * `x` is measured in *input samples*; `fc` is the cutoff as a fraction of the
 * input Nyquist. One kernel therefore does both jobs at once: it interpolates
 * (it is a sinc, the ideal interpolator) and it band-limits to the output
 * Nyquist (the `fc` scaling), which is exactly what kills aliasing.
 *
 * * `fc = min(1, (outputRate / inputRate) · rolloff)`. When downsampling this
 *   puts the cutoff at `rolloff · outputRate / 2`; when upsampling it saturates
 *   at the input Nyquist, i.e. pure interpolation with no band loss.
 * * The kernel is truncated to `zeroCrossings` sinc lobes per side and tapered
 *   with a **Kaiser window** (β ≈ 8.6 → ≈ −80 dB stopband).
 * * With the [Quality.BALANCED] defaults and a 44.1 kHz source: 24 lobes at
 *   fc = 0.319 → half-width ≈ 75 input samples (≈ 150 taps). Kaiser's
 *   `N ≈ (A − 8) / (2.285 · Δω)` gives a transition band of ≈ 1.6 kHz, so the
 *   passband is flat to ≈ 6.3 kHz and the response is at the −80 dB floor by
 *   ≈ 7.8 kHz — comfortably below the 8 kHz output Nyquist. Nothing folds back.
 *
 * Rather than recomputing sinc/Bessel per tap, `h` is precomputed into a table
 * at [TABLE_DENSITY] points per input sample and read with linear interpolation
 * (the classic polyphase-with-interpolated-phase trick; at 128 points per input
 * sample the interpolation error sits far below the stopband floor). Each output
 * is normalised by the sum of the taps actually used, which pins the DC gain to
 * exactly 1.0 regardless of fractional phase or table error.
 *
 * ## Streaming
 *
 * State (`pending` history, output index) is kept across calls, so feeding the
 * same audio in arbitrary chunk sizes yields bit-identical output to feeding it
 * in one call — no clicks or pitch drift at chunk boundaries. The stream is
 * implicitly zero-padded by `halfWidth` samples at both ends, so output sample 0
 * lines up with input sample 0 (no added latency to compensate for) and
 * [flush] emits exactly the tail.
 *
 * Not thread-safe: use one instance per stream.
 *
 * Cost: taps/output ≈ `2 · zeroCrossings / fc`, so MACs per second of audio ≈
 * `2.3 · zeroCrossings · inputRate` — about 2.5 M/s for a 44.1 kHz source at the
 * default quality, i.e. a few seconds of CPU per hour of imported audio.
 */
class Resampler @JvmOverloads constructor(
    val inputRate: Int,
    val outputRate: Int = Pcm.SAMPLE_RATE,
    val quality: Quality = Quality.BALANCED,
) {
    /**
     * Filter length / cutoff trade-off.
     *
     * @property zeroCrossings sinc lobes kept per side (longer = sharper transition)
     * @property rolloff cutoff as a fraction of the output Nyquist
     * @property kaiserBeta window β (higher = deeper stopband, wider transition)
     */
    enum class Quality(
        internal val zeroCrossings: Int,
        internal val rolloff: Double,
        internal val kaiserBeta: Double,
    ) {
        /** ~½ the CPU, passband to ≈ 0.72 × Nyquist, ≈ −60 dB stopband. */
        FAST(12, 0.80, 7.0),

        /** Default. Passband to ≈ 0.79 × Nyquist, ≈ −80 dB stopband. */
        BALANCED(24, 0.88, 8.6),

        /** Archival quality; ~1.8× the CPU of [BALANCED]. */
        HIGH(40, 0.92, 10.0),
    }

    init {
        require(inputRate > 0) { "inputRate must be positive (got $inputRate)" }
        require(outputRate > 0) { "outputRate must be positive (got $outputRate)" }
    }

    /** True when no conversion is needed and [process] simply copies. */
    val isPassthrough: Boolean = inputRate == outputRate

    /** Input samples consumed per output sample. */
    private val step: Double = inputRate.toDouble() / outputRate.toDouble()

    /** Cutoff as a fraction of the input Nyquist. */
    private val cutoff: Double =
        min(1.0, (outputRate.toDouble() / inputRate.toDouble()) * quality.rolloff)

    /** Kernel half-width, in input samples. */
    private val halfWidth: Double = quality.zeroCrossings / cutoff
    private val halfWidthInt: Int = ceil(halfWidth).toInt()

    /** `h(k / TABLE_DENSITY)` for k in `[0, halfWidth · TABLE_DENSITY]`. */
    private val table: FloatArray = buildKernelTable()

    /** Input history. `pending[0]` is global input index [pendingStart]. */
    private var pending: FloatArray = FloatArray(max(1024, halfWidthInt * 4))
    private var pendingLen: Int = 0
    private var pendingStart: Long = 0
    private var nextOut: Long = 0
    private var inputCount: Long = 0
    private var flushed: Boolean = false

    init {
        primeHistory()
    }

    /**
     * Feed `count` mono samples in [-1, 1] and return every output sample that is
     * now fully determined (possibly none — the kernel needs `halfWidth` samples
     * of look-ahead). The returned array is freshly allocated and owned by the
     * caller, and is empty when there is nothing yet.
     */
    @JvmOverloads
    fun process(input: FloatArray, count: Int = input.size): FloatArray {
        require(count >= 0 && count <= input.size) { "count out of range: $count" }
        if (isPassthrough) return if (count == 0) EMPTY else input.copyOf(count)
        check(!flushed) { "process() called after flush(); call reset() first" }
        if (count == 0) return EMPTY
        append(input, count)
        inputCount += count.toLong()
        return emitUpTo(availabilityLimit())
    }

    /**
     * Emit the tail of the stream: the outputs whose kernel window ran past the
     * last input sample. Call exactly once, after the final [process]. Further
     * [process] calls throw until [reset].
     */
    fun flush(): FloatArray {
        if (isPassthrough || flushed) return EMPTY
        flushed = true
        if (inputCount <= 0) return EMPTY
        // Zero-pad the end so the kernel has data to sit on, then emit only the
        // outputs whose centre falls at or before the last real input sample.
        val pad = halfWidthInt + 2
        ensureCapacity(pendingLen + pad)
        pending.fill(0f, pendingLen, pendingLen + pad)
        pendingLen += pad
        val limit = floor((inputCount - 1).toDouble() / step).toLong()
        return emitUpTo(limit)
    }

    /** Drop all state and start a new stream with the same filter. */
    fun reset() {
        pendingLen = 0
        pendingStart = 0
        nextOut = 0
        inputCount = 0
        flushed = false
        primeHistory()
    }

    /** Output samples this converter will produce for [inputSamples] of input. */
    fun expectedOutputCount(inputSamples: Long): Long {
        if (inputSamples <= 0) return 0
        if (isPassthrough) return inputSamples
        return floor((inputSamples - 1).toDouble() / step).toLong() + 1
    }

    // ---------------------------------------------------------------- internals

    /** Pre-roll: `halfWidth` zeros before input index 0, so output 0 == input 0. */
    private fun primeHistory() {
        ensureCapacity(halfWidthInt)
        pending.fill(0f, 0, halfWidthInt)
        pendingLen = halfWidthInt
        pendingStart = -halfWidthInt.toLong()
    }

    /** Highest output index whose kernel window is fully covered by [pending]. */
    private fun availabilityLimit(): Long {
        val lastAvailable = pendingStart + pendingLen - 1
        val maxCentre = lastAvailable - halfWidth
        if (maxCentre < 0) return -1
        return floor(maxCentre / step).toLong()
    }

    private fun emitUpTo(limit: Long): FloatArray {
        if (limit < nextOut) {
            compact()
            return EMPTY
        }
        val n = (limit - nextOut + 1).toInt()
        val out = FloatArray(n)
        for (j in 0 until n) {
            out[j] = sampleAt(nextOut)
            nextOut++
        }
        compact()
        return out
    }

    /** Convolve the kernel centred on output index [n] with the input history. */
    private fun sampleAt(n: Long): Float {
        val centre = n * step - pendingStart // position inside `pending`
        var first = ceil(centre - halfWidth).toInt()
        var last = floor(centre + halfWidth).toInt()
        if (first < 0) first = 0
        if (last > pendingLen - 1) last = pendingLen - 1
        var acc = 0f
        var norm = 0f
        var i = first
        val limit = table.size - 1
        while (i <= last) {
            val pos = abs(i - centre) * TABLE_DENSITY
            val k = pos.toInt()
            if (k < limit) {
                val frac = (pos - k).toFloat()
                val w = table[k] + (table[k + 1] - table[k]) * frac
                acc += pending[i] * w
                norm += w
            }
            i++
        }
        // norm is ~1.0 by construction; dividing pins the DC gain to exactly 1.
        return if (norm > 1e-6f || norm < -1e-6f) acc / norm else 0f
    }

    private fun append(input: FloatArray, count: Int) {
        ensureCapacity(pendingLen + count)
        System.arraycopy(input, 0, pending, pendingLen, count)
        pendingLen += count
    }

    private fun ensureCapacity(needed: Int) {
        if (pending.size >= needed) return
        pending = pending.copyOf(max(needed, pending.size * 2))
    }

    /** Discard history the next output can no longer reach. */
    private fun compact() {
        val firstNeeded = floor(nextOut * step - halfWidth).toLong()
        val drop = min((firstNeeded - pendingStart), pendingLen.toLong()).toInt()
        if (drop <= 0) return
        val keep = pendingLen - drop
        if (keep > 0) System.arraycopy(pending, drop, pending, 0, keep)
        pendingLen = keep
        pendingStart += drop.toLong()
    }

    private fun buildKernelTable(): FloatArray {
        val size = ceil(halfWidth * TABLE_DENSITY).toInt() + 2
        val t = FloatArray(size)
        val i0beta = besselI0(quality.kaiserBeta)
        for (k in 0 until size) {
            val x = k.toDouble() / TABLE_DENSITY
            if (x > halfWidth) continue // leave 0f
            val r = x / halfWidth
            val window = besselI0(quality.kaiserBeta * sqrt(max(0.0, 1.0 - r * r))) / i0beta
            t[k] = (cutoff * sinc(cutoff * x) * window).toFloat()
        }
        return t
    }

    companion object {
        /** Kernel table resolution, in points per input sample. */
        private const val TABLE_DENSITY = 128

        private val EMPTY = FloatArray(0)

        private fun sinc(x: Double): Double {
            if (abs(x) < 1e-12) return 1.0
            val pix = PI * x
            return sin(pix) / pix
        }

        /** Modified Bessel function of the first kind, order 0 (Kaiser window). */
        private fun besselI0(x: Double): Double {
            val half = x / 2.0
            var term = 1.0
            var sum = 1.0
            var k = 1
            while (k < 64) {
                val f = half / k
                term *= f * f
                sum += term
                if (term < sum * 1e-17) break
                k++
            }
            return sum
        }
    }
}
