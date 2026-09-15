package com.pathors.parley.playback

import com.pathors.parley.audio.Pcm
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.min
import kotlin.math.sqrt

/**
 * The whole of a recording reduced to a few hundred numbers — the overview
 * waveform drawn behind the player's scrubber.
 *
 * ## Why this is not the live meeting's waveform
 *
 * The live screen's level meter is a *history*: one RMS value per captured
 * chunk, showing the last few seconds, answering "did it hear me". A finished
 * recording needs the opposite shape — the entire file at once, so a person can
 * see where the quiet stretch was and drag to it. That cannot come from the
 * capture tap, because half the time the capture happened on another device.
 * So it is computed from the decoded audio, once, and cached.
 *
 * ## Two resolutions, on purpose
 *
 * The streaming pass measures RMS over a 20 ms window — the same 20 ms the Opus
 * encoder frames at — into a coarse array, and only then reduces that to
 * [BUCKET_COUNT]. One pass cannot bucket straight into 400 slots without knowing
 * the total length first, and the coarse array is cheap: an hour of audio is
 * 180,000 floats, 720 KB, alive for the length of one computation.
 *
 * Everything here is pure Kotlin over `ByteArray`s of 16 kHz mono s16le — the
 * exact shape `AudioFileDecoder.decode` already emits — so the arithmetic is
 * unit-testable on the JVM and no second decoder had to be written. The Android
 * side of it is [AudioPeaksLoader].
 *
 * The on-disk cache format is byte-identical to iOS `AudioPeaks` (`PKW1`), which
 * costs nothing here and means the two platforms can be compared directly when
 * one of them draws a waveform that looks wrong.
 */
object AudioPeaks {

    /**
     * What gets cached. A 430dp-wide phone draws ~130 bars at 3dp each, so 400
     * leaves room for a wider screen and for a future zoom without a recompute,
     * and costs 1.6 KB on disk.
     */
    const val BUCKET_COUNT = 400

    /** The coarse pass's window, in samples at 16 kHz — 20 ms. */
    const val WINDOW_SAMPLES = 320

    private const val WINDOW_BYTES = WINDOW_SAMPLES * Pcm.BYTES_PER_SAMPLE

    /** `PKW1`, big-endian so a hex dump reads as the letters. */
    private const val MAGIC = 0x504B_5731

    private const val HEADER_BYTES = 16

    /**
     * A finished overview.
     *
     * [peaks] are **raw RMS in 0…1, not normalised**. Normalising here would bake
     * a decision the drawing has to make anyway (a whispered meeting has to fill
     * the field or it reads as an empty file), and it would make the cache a
     * function of the loudest moment — so re-deriving it later, for a zoom or a
     * different height, would need the audio back.
     *
     * [seconds] is how long the audio actually decoded to, kept so a cache
     * written for a different file under a reused recording id can be spotted
     * and thrown away rather than drawn over the wrong duration.
     *
     * A hand-written [equals]: the array is the content, and the generated
     * identity comparison would make every test of this type a false negative.
     */
    class Overview(val peaks: FloatArray, val seconds: Double) {

        val isEmpty: Boolean get() = peaks.isEmpty()

        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is Overview) return false
            return seconds == other.seconds && peaks.contentEquals(other.peaks)
        }

        override fun hashCode(): Int = 31 * peaks.contentHashCode() + seconds.hashCode()

        override fun toString(): String = "Overview(${peaks.size} peaks, ${seconds}s)"
    }

    /**
     * Feed it 16 kHz mono s16le chunks in order, ask it for an [Overview].
     *
     * Stateful because a chunk boundary is not a window boundary: the tail of a
     * chunk that does not fill a 20 ms window is carried into the next one, so
     * the result does not depend on how the decoder happened to split the file.
     *
     * Not thread-safe; one accumulator belongs to one decode.
     */
    class Accumulator(private val sampleRate: Int = Pcm.SAMPLE_RATE) {

        /** RMS per 20 ms, in order. Reduced to the bucket count once at the end. */
        private val coarse = ArrayList<Float>(3_000)

        private val carry = ByteArray(WINDOW_BYTES)
        private var carried = 0
        private var totalSamples = 0L

        /** How much audio has been fed in so far. */
        val seconds: Double get() = totalSamples.toDouble() / sampleRate

        fun add(pcm: ByteArray, offset: Int = 0, length: Int = pcm.size - offset) {
            if (length <= 0) return
            totalSamples += length / Pcm.BYTES_PER_SAMPLE
            var position = offset
            val end = offset + length

            // Top up a partial window left over from the previous chunk first,
            // so windows stay aligned to the start of the file.
            if (carried > 0) {
                val take = min(WINDOW_BYTES - carried, end - position)
                System.arraycopy(pcm, position, carry, carried, take)
                carried += take
                position += take
                if (carried < WINDOW_BYTES) return
                coarse.add(Pcm.rmsFromS16le(carry, 0, WINDOW_BYTES))
                carried = 0
            }

            while (end - position >= WINDOW_BYTES) {
                coarse.add(Pcm.rmsFromS16le(pcm, position, WINDOW_BYTES))
                position += WINDOW_BYTES
            }

            val rest = end - position
            if (rest > 0) {
                System.arraycopy(pcm, position, carry, 0, rest)
                carried = rest
            }
        }

        /**
         * Reduce everything fed in to exactly [buckets] values.
         *
         * Returns null when nothing was fed in: an empty recording has no
         * waveform, and a row of 400 zeroes would draw as a full-width dotted
         * line claiming otherwise.
         */
        fun finish(buckets: Int = BUCKET_COUNT): Overview? {
            // The tail window, so the last fraction of a second is not dropped.
            if (carried >= Pcm.BYTES_PER_SAMPLE) {
                coarse.add(Pcm.rmsFromS16le(carry, 0, carried))
                carried = 0
            }
            if (coarse.isEmpty() || totalSamples <= 0L) return null
            return Overview(
                peaks = resample(coarse.toFloatArray(), buckets),
                seconds = totalSamples.toDouble() / sampleRate,
            )
        }
    }

    /**
     * Reduce or stretch a peak array to exactly [count] values.
     *
     * Combined as RMS rather than by taking the maximum: the maximum of a
     * hundred windows is whichever one clipped, so a downsampled waveform drawn
     * that way is a flat bar at full height for any recording with a cough in
     * it. Averaging energy keeps the shape of the conversation.
     *
     * Stretching (fewer values than asked for, which is every recording under
     * eight seconds) repeats the nearest value rather than interpolating: a
     * three-second clip should read as the handful of marks it is.
     */
    fun resample(values: FloatArray, count: Int): FloatArray {
        if (count <= 0) return FloatArray(0)
        if (values.isEmpty()) return FloatArray(count)
        if (values.size == count) return values.copyOf()
        if (values.size < count) {
            return FloatArray(count) { index ->
                values[min(values.size - 1, index * values.size / count)]
            }
        }
        return FloatArray(count) { index ->
            val start = index * values.size / count
            val end = min(maxOf(start + 1, (index + 1) * values.size / count), values.size)
            var sum = 0.0
            for (position in start until end) {
                val value = values[position].toDouble()
                sum += value * value
            }
            sqrt(sum / (end - start)).toFloat()
        }
    }

    // ── the cache file ───────────────────────────────────────────────────────

    /**
     * The on-disk form: 16 bytes of header, then one little-endian `Float32` per
     * bucket.
     *
     * Binary rather than JSON because the numbers are the entire content: 400
     * floats are 1,600 bytes here and about 4,800 as JSON text, and nothing ever
     * needs to read this file by eye.
     */
    fun encode(overview: Overview): ByteArray {
        val buffer = ByteBuffer
            .allocate(HEADER_BYTES + overview.peaks.size * 4)
            .order(ByteOrder.LITTLE_ENDIAN)
        buffer.putInt(Integer.reverseBytes(MAGIC)) // written big-endian
        buffer.putInt(overview.peaks.size)
        buffer.putFloat(overview.seconds.toFloat())
        buffer.putInt(0) // reserved, keeps the payload 8-byte aligned
        overview.peaks.forEach { buffer.putFloat(it) }
        return buffer.array()
    }

    /**
     * Read a cache file back, or null when it is not one of ours or is
     * truncated.
     *
     * A corrupt cache is a *null*, not an exception: the only thing a caller
     * could do with the error is recompute, which is what null already asks for.
     */
    fun decode(bytes: ByteArray): Overview? {
        if (bytes.size < HEADER_BYTES) return null
        val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        if (Integer.reverseBytes(buffer.int) != MAGIC) return null
        val count = buffer.int
        if (count < 0 || bytes.size < HEADER_BYTES + count * 4) return null
        val seconds = buffer.float.toDouble()
        buffer.int // reserved
        val peaks = FloatArray(count) { buffer.float }
        return Overview(peaks, seconds)
    }
}
