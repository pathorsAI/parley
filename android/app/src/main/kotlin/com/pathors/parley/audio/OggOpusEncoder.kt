package com.pathors.parley.audio

import android.media.MediaCodec
import android.media.MediaCodecList
import android.media.MediaFormat
import android.media.MediaMuxer
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.withContext
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.min

/** Typed failures from [OggOpusEncoder]. */
sealed class OpusEncodeException(message: String, cause: Throwable? = null) :
    Exception(message, cause) {

    /** This device has no Opus encoder, or it refused our format. */
    class EncoderUnavailable(cause: Throwable? = null) :
        OpusEncodeException("no usable Opus encoder on this device", cause)

    /** The OGG muxer could not be created, started or finalised. */
    class MuxerFailed(message: String, cause: Throwable? = null) :
        OpusEncodeException(message, cause)

    /** The encode itself failed or stalled. */
    class EncodeFailed(message: String, cause: Throwable? = null) :
        OpusEncodeException(message, cause)
}

/**
 * Streaming encoder: **16 kHz mono s16le PCM in, Ogg/Opus file out**.
 *
 * Matches the desktop encoder (`src-tauri/src/replay_audio.rs`) as closely as
 * `MediaCodec` lets us — same 16 kHz mono input, same ~24 kbps target, same
 * 20 ms framing, so a phone recording and a desktop recording are the same kind
 * of artefact on the server.
 *
 * ```kotlin
 * // live, while recording
 * val encoder = OggOpusEncoder.create(File(dir, "recording.ogg"))
 * mic.start().collect { encoder.append(it) }   // on a background dispatcher
 * val file = encoder.finish()
 *
 * // bulk, after an import
 * val file = OggOpusEncoder.encode(AudioFileDecoder.decode(context, uri), outFile)
 * ```
 *
 * ## Settings
 *
 * | | Desktop (libopus) | Android (MediaCodec) |
 * |---|---|---|
 * | Sample rate | 16 kHz | 16 kHz |
 * | Channels | mono | mono |
 * | Bitrate | 24 000 | 24 000 (`KEY_BIT_RATE`) |
 * | Frame | 20 ms | 20 ms (what we queue) |
 * | Application | `VOIP` | not exposed by `MediaCodec` |
 *
 * `Application::VOIP` is the one setting Android does not surface; the AOSP
 * Opus encoder uses the general audio mode. At 24 kbps mono speech the
 * difference is not audible and does not affect transcription.
 *
 * ## Ogg framing and CSD
 *
 * `MediaMuxer(MUXER_OUTPUT_OGG)` writes the `OpusHead`/`OpusTags` pages itself,
 * but only if the track format carries the codec-specific data: `csd-0` (the
 * 19-byte `OpusHead` identification header), `csd-1` (codec delay in
 * nanoseconds) and `csd-2` (seek pre-roll in nanoseconds). Those only exist
 * **after** `INFO_OUTPUT_FORMAT_CHANGED`, so `addTrack`/`start` happen there —
 * never with the format we configured. Should an encoder emit the headers as
 * `BUFFER_FLAG_CODEC_CONFIG` output buffers instead of putting them in the
 * format (or omit them entirely), we capture those buffers and, failing that,
 * synthesize the same `OpusHead` the desktop writes (pre-skip 312, input rate
 * 16 000, mapping family 0) plus the conventional 6.5 ms delay / 80 ms pre-roll.
 * Getting this wrong yields a file players reject, so it is handled defensively.
 *
 * ## Threading
 *
 * Every method is `synchronized`, so live capture and a later `finish()` may
 * come from different threads. All of them **block** (they drive `MediaCodec`
 * synchronously): call them off the main thread. [append] returns as soon as
 * the frame is queued; encoded packets are drained opportunistically with a
 * zero timeout, so a live recording never stalls the audio thread.
 *
 * @see create
 * @see encode
 */
class OggOpusEncoder private constructor(
    private val outputFile: File,
    private val codec: MediaCodec,
    private val muxer: MediaMuxer,
) {
    private val lock = Any()
    private val bufferInfo = MediaCodec.BufferInfo()
    private val carry = ByteArray(FRAME_BYTES)
    private val capturedCsd = ArrayList<ByteArray>(3)

    private var carryLen = 0
    private var framesQueued = 0L
    private var packetsWritten = 0L
    private var trackIndex = -1
    private var muxerStarted = false
    private var inputEos = false
    private var finished = false
    private var released = false

    /** Audio appended so far, in milliseconds (20 ms granularity). */
    val durationMs: Long get() = synchronized(lock) { framesQueued * FRAME_MILLIS }

    /** The file being written. Only complete after [finish]. */
    val file: File get() = outputFile

    /**
     * Append 16 kHz mono s16le PCM. Any length is fine — samples are buffered
     * into exact 20 ms frames across calls, so chunk boundaries do not have to
     * line up with frame boundaries.
     */
    @JvmOverloads
    fun append(pcm: ByteArray, offset: Int = 0, length: Int = pcm.size - offset) {
        synchronized(lock) {
            check(!finished) { "append() after finish()" }
            require(offset >= 0 && length >= 0 && offset + length <= pcm.size) {
                "range $offset..${offset + length} outside a ${pcm.size}-byte array"
            }
            var pos = offset
            var remaining = length
            while (remaining > 0) {
                val n = min(FRAME_BYTES - carryLen, remaining)
                System.arraycopy(pcm, pos, carry, carryLen, n)
                carryLen += n
                pos += n
                remaining -= n
                if (carryLen == FRAME_BYTES) {
                    queueFrame()
                    carryLen = 0
                }
            }
        }
    }

    /**
     * Zero-pad the last partial frame, flush the encoder, finalise the container
     * and release everything. Returns the finished file. Call exactly once.
     *
     * A stream with no audio at all would produce a container the muxer refuses
     * to close, so one frame of silence is written instead — the file is always
     * valid, just 20 ms long.
     */
    fun finish(): File {
        synchronized(lock) {
            check(!finished) { "finish() called twice" }
            finished = true
            try {
                if (carryLen > 0) {
                    carry.fill(0, carryLen, FRAME_BYTES)
                    carryLen = 0
                    queueFrame()
                }
                if (framesQueued == 0L) {
                    carry.fill(0)
                    queueFrame()
                }
                signalEndOfStream()
                drainOutput(endOfStream = true)
                if (!muxerStarted || packetsWritten == 0L) {
                    throw OpusEncodeException.MuxerFailed("encoder produced no Opus packets")
                }
                try {
                    muxer.stop()
                } catch (e: Exception) {
                    throw OpusEncodeException.MuxerFailed("could not finalise the Ogg file", e)
                }
                Log.i(
                    TAG,
                    "encoded ${outputFile.name}: $packetsWritten packets, " +
                        "${durationMs}ms, ${outputFile.length()} bytes",
                )
                return outputFile
            } catch (e: Throwable) {
                release()
                runCatching { outputFile.delete() }
                throw e
            } finally {
                release()
            }
        }
    }

    /** Abandon the encode and delete the partial file. Idempotent. */
    fun cancel() {
        synchronized(lock) {
            finished = true
            release()
            runCatching { outputFile.delete() }
        }
    }

    // ---------------------------------------------------------------- internals

    /** Queue [carry] as one 20 ms frame, draining any output that is ready. */
    private fun queueFrame() {
        var attempts = 0
        while (true) {
            val index = try {
                codec.dequeueInputBuffer(DEQUEUE_TIMEOUT_US)
            } catch (e: IllegalStateException) {
                throw OpusEncodeException.EncodeFailed("encoder is not running", e)
            }
            if (index >= 0) {
                val buffer = codec.getInputBuffer(index)
                    ?: throw OpusEncodeException.EncodeFailed("null input buffer $index")
                if (buffer.capacity() < FRAME_BYTES) {
                    throw OpusEncodeException.EncodeFailed(
                        "input buffer is ${buffer.capacity()} bytes, need $FRAME_BYTES",
                    )
                }
                buffer.clear()
                buffer.put(carry, 0, FRAME_BYTES)
                codec.queueInputBuffer(
                    index, 0, FRAME_BYTES, framesQueued * FRAME_DURATION_US, 0,
                )
                framesQueued++
                drainOutput(endOfStream = false)
                return
            }
            drainOutput(endOfStream = false)
            if (++attempts > MAX_ATTEMPTS) {
                throw OpusEncodeException.EncodeFailed("encoder stopped accepting input")
            }
        }
    }

    private fun signalEndOfStream() {
        var attempts = 0
        while (!inputEos) {
            val index = codec.dequeueInputBuffer(DEQUEUE_TIMEOUT_US)
            if (index >= 0) {
                codec.queueInputBuffer(
                    index, 0, 0, framesQueued * FRAME_DURATION_US,
                    MediaCodec.BUFFER_FLAG_END_OF_STREAM,
                )
                inputEos = true
                return
            }
            drainOutput(endOfStream = false)
            if (++attempts > MAX_ATTEMPTS) {
                throw OpusEncodeException.EncodeFailed("could not signal end of stream")
            }
        }
    }

    /**
     * Move whatever the encoder has ready into the muxer. With
     * `endOfStream = false` this returns as soon as nothing is pending (zero
     * timeout — safe to call from a live capture path); with `true` it blocks
     * until the encoder reports end of stream.
     */
    private fun drainOutput(endOfStream: Boolean) {
        var idle = 0
        while (true) {
            val timeout = if (endOfStream) DEQUEUE_TIMEOUT_US else 0L
            val index = codec.dequeueOutputBuffer(bufferInfo, timeout)
            when {
                index >= 0 -> {
                    idle = 0
                    val isConfig =
                        (bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0
                    val buffer = codec.getOutputBuffer(index)
                    if (buffer != null && bufferInfo.size > 0) {
                        // clear() first: setting position before limit can throw
                        // if the codec left a limit below our offset.
                        buffer.clear()
                        buffer.position(bufferInfo.offset)
                        buffer.limit(bufferInfo.offset + bufferInfo.size)
                        if (isConfig) {
                            // Header blob, not audio: keep it in case the output
                            // format turns out not to carry the CSD itself.
                            if (capturedCsd.size < 3) {
                                val copy = ByteArray(bufferInfo.size)
                                buffer.get(copy)
                                capturedCsd.add(copy)
                            }
                        } else {
                            if (!muxerStarted) startMuxer(codec.outputFormat)
                            muxer.writeSampleData(trackIndex, buffer, bufferInfo)
                            packetsWritten++
                        }
                    }
                    val eos = (bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
                    codec.releaseOutputBuffer(index, false)
                    if (eos) return
                }

                index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    idle = 0
                    startMuxer(codec.outputFormat)
                }

                index == MediaCodec.INFO_OUTPUT_BUFFERS_CHANGED -> idle = 0

                else -> {
                    // INFO_TRY_AGAIN_LATER
                    if (!endOfStream) return
                    if (++idle > MAX_ATTEMPTS) {
                        throw OpusEncodeException.EncodeFailed(
                            "timed out waiting for the encoder to finish",
                        )
                    }
                }
            }
        }
    }

    private fun startMuxer(format: MediaFormat) {
        if (muxerStarted) return
        ensureOpusCsd(format)
        try {
            trackIndex = muxer.addTrack(format)
            muxer.start()
        } catch (e: Exception) {
            throw OpusEncodeException.MuxerFailed("could not start the Ogg muxer", e)
        }
        muxerStarted = true
    }

    /**
     * Guarantee the three Opus CSD blobs the OGG muxer requires, filling gaps
     * from the codec-config buffers we captured and then from spec defaults.
     */
    private fun ensureOpusCsd(format: MediaFormat) {
        if (!format.containsKey(KEY_CSD_0)) {
            val head = capturedCsd.getOrNull(0)?.takeIf { it.size >= OPUS_HEAD_BYTES }
                ?: buildOpusHead()
            format.setByteBuffer(KEY_CSD_0, ByteBuffer.wrap(head))
            Log.w(TAG, "encoder did not report csd-0; supplied an OpusHead")
        }
        if (!format.containsKey(KEY_CSD_1)) {
            val delay = capturedCsd.getOrNull(1)?.takeIf { it.size == 8 }
                ?: longLe(DEFAULT_CODEC_DELAY_NS)
            format.setByteBuffer(KEY_CSD_1, ByteBuffer.wrap(delay))
        }
        if (!format.containsKey(KEY_CSD_2)) {
            val preRoll = capturedCsd.getOrNull(2)?.takeIf { it.size == 8 }
                ?: longLe(DEFAULT_SEEK_PRE_ROLL_NS)
            format.setByteBuffer(KEY_CSD_2, ByteBuffer.wrap(preRoll))
        }
    }

    private fun release() {
        if (released) return
        released = true
        runCatching { codec.stop() }
        runCatching { codec.release() }
        runCatching { muxer.release() }
    }

    companion object {
        private const val TAG = "OggOpusEncoder"

        /** Internal format; the encoder only accepts 16 kHz mono. */
        const val SAMPLE_RATE = Pcm.SAMPLE_RATE
        const val CHANNELS = 1

        /** ~24 kbps is ample for 16 kHz mono speech — same as the desktop app. */
        const val DEFAULT_BITRATE = 24_000

        /** 20 ms at 16 kHz: 320 samples / 640 bytes. Opus frames are fixed-size. */
        const val FRAME_SAMPLES = SAMPLE_RATE / 1000 * 20
        const val FRAME_BYTES = FRAME_SAMPLES * Pcm.BYTES_PER_SAMPLE
        private const val FRAME_MILLIS = 20L
        private const val FRAME_DURATION_US = 20_000L

        private const val DEQUEUE_TIMEOUT_US = 10_000L
        private const val MAX_ATTEMPTS = 1_000

        private const val KEY_CSD_0 = "csd-0"
        private const val KEY_CSD_1 = "csd-1"
        private const val KEY_CSD_2 = "csd-2"
        private const val OPUS_HEAD_BYTES = 19

        /**
         * Opus look-ahead: 312 samples at the 48 kHz Opus clock = 6.5 ms. Same
         * value the desktop writes into its own `OpusHead`.
         */
        private const val OPUS_PRE_SKIP = 312
        private const val DEFAULT_CODEC_DELAY_NS = 6_500_000L

        /** Conventional Opus seek pre-roll: 80 ms. */
        private const val DEFAULT_SEEK_PRE_ROLL_NS = 80_000_000L

        /**
         * Open an encoder writing Ogg/Opus to [outputFile] (overwritten if it
         * exists). Call [append] then [finish]; on any error call [cancel].
         *
         * @throws OpusEncodeException.EncoderUnavailable when the device has no
         *   Opus encoder (all API 29+ devices are expected to, but a handful of
         *   heavily customised builds do not — callers should be ready to fall
         *   back to uploading raw PCM)
         * @throws OpusEncodeException.MuxerFailed when the file cannot be created
         */
        @JvmStatic
        @JvmOverloads
        fun create(outputFile: File, bitrate: Int = DEFAULT_BITRATE): OggOpusEncoder {
            // Keep the lookup format minimal: extra keys make findEncoderForFormat
            // miss codecs that would actually work.
            val lookup = MediaFormat.createAudioFormat(
                MediaFormat.MIMETYPE_AUDIO_OPUS, SAMPLE_RATE, CHANNELS,
            )
            val format = MediaFormat.createAudioFormat(
                MediaFormat.MIMETYPE_AUDIO_OPUS, SAMPLE_RATE, CHANNELS,
            ).apply {
                setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
                setInteger(MediaFormat.KEY_PCM_ENCODING, Pcm.ENCODING_PCM_16BIT)
            }

            val codec = try {
                val name = MediaCodecList(MediaCodecList.REGULAR_CODECS)
                    .findEncoderForFormat(lookup)
                if (name != null) {
                    MediaCodec.createByCodecName(name)
                } else {
                    MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS)
                }
            } catch (e: Exception) {
                throw OpusEncodeException.EncoderUnavailable(e)
            }

            try {
                codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                codec.start()
            } catch (e: Exception) {
                runCatching { codec.release() }
                throw OpusEncodeException.EncoderUnavailable(e)
            }

            val muxer = try {
                outputFile.parentFile?.mkdirs()
                if (outputFile.exists()) outputFile.delete()
                MediaMuxer(outputFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_OGG)
            } catch (e: Exception) {
                runCatching { codec.stop() }
                runCatching { codec.release() }
                throw OpusEncodeException.MuxerFailed("cannot write ${outputFile.absolutePath}", e)
            }

            return OggOpusEncoder(outputFile, codec, muxer)
        }

        /**
         * Bulk convenience: drain [source] (16 kHz mono s16le chunks, e.g. from
         * [AudioFileDecoder.decode]) into a finished Ogg/Opus file. Runs on
         * [Dispatchers.IO]; deletes the partial file if anything goes wrong.
         */
        suspend fun encode(
            source: Flow<ByteArray>,
            outputFile: File,
            bitrate: Int = DEFAULT_BITRATE,
        ): File = withContext(Dispatchers.IO) {
            val encoder = create(outputFile, bitrate)
            try {
                source.collect { encoder.append(it) }
            } catch (t: Throwable) {
                encoder.cancel()
                throw t
            }
            encoder.finish()
        }

        /**
         * The 19-byte `OpusHead` identification header, byte-for-byte what
         * `replay_audio.rs` builds: version 1, mono, pre-skip 312, input rate
         * 16 000, 0 dB gain, channel mapping family 0.
         */
        internal fun buildOpusHead(): ByteArray =
            ByteBuffer.allocate(OPUS_HEAD_BYTES).order(ByteOrder.LITTLE_ENDIAN).apply {
                put('O'.code.toByte())
                put('p'.code.toByte())
                put('u'.code.toByte())
                put('s'.code.toByte())
                put('H'.code.toByte())
                put('e'.code.toByte())
                put('a'.code.toByte())
                put('d'.code.toByte())
                put(1)                                  // version
                put(CHANNELS.toByte())                  // channel count
                putShort(OPUS_PRE_SKIP.toShort())       // pre-skip
                putInt(SAMPLE_RATE)                     // original input rate
                putShort(0)                             // output gain, Q7.8
                put(0)                                  // channel mapping family
            }.array()

        /** A little-endian int64, the encoding csd-1 / csd-2 use. */
        private fun longLe(value: Long): ByteArray =
            ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN).putLong(value).array()
    }
}
