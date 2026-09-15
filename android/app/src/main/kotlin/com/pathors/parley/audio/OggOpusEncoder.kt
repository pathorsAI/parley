package com.pathors.parley.audio

import android.media.MediaCodec
import android.media.MediaCodecList
import android.media.MediaFormat
import android.util.Log
import com.pathors.parley.util.deleteQuietly
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.withContext
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.min

/** Typed failures from [OggOpusEncoder]. */
sealed class OpusEncodeException(message: String, cause: Throwable? = null) :
    Exception(message, cause) {

    /** This device has no Opus encoder, or it refused our format. */
    class EncoderUnavailable(cause: Throwable? = null) :
        OpusEncodeException("no usable Opus encoder on this device", cause)

    /**
     * The Ogg output could not be opened, written or finalised.
     *
     * Named for the `MediaMuxer` that used to do this job; kept under that name
     * because it is what every call site catches and the failure it reports —
     * "the file did not happen" — has not changed.
     */
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
 * ## Ogg framing: we write the container ourselves
 *
 * `MediaCodec` produces Opus packets; [OggStreamWriter] wraps them in Ogg pages
 * and this class writes those pages straight to a [FileOutputStream]. There is
 * no `MediaMuxer` in the path any more, and that is the whole point of the
 * design.
 *
 * A `MediaMuxer` file only becomes a file when `stop()` runs — the container is
 * finalised at the end. Kill the app mid-meeting (low memory, battery pull, a
 * swipe from Recents) and the `.ogg` on disk is unreadable no matter how many
 * megabytes of audio physically made it there. Crash recovery has nothing to
 * adopt. Ogg itself has no such property: every page is self-describing and
 * independently CRC'd, so a file that stops mid-stream is a recording that ends
 * early. Hand-writing the pages is what converts "the process died" from
 * "lost the meeting" into "lost the last second of it".
 *
 * That also puts Android in line with the other two recorders, which both
 * already write their own pages: iOS
 * (`ios/ParleyKit/Sources/ParleyKit/OggOpusEncoder.swift:164-243`) and desktop
 * (`src-tauri/src/replay_audio.rs:259`).
 *
 * The one thing the codec still has to tell us is its pre-skip, and it only
 * does so once it has run — see [ensureOggWriter] for why the header pages are
 * written lazily rather than in [create].
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
    private val rawOutput: FileOutputStream,
    private val output: BufferedOutputStream,
) {
    private val lock = Any()
    private val bufferInfo = MediaCodec.BufferInfo()
    private val carry = ByteArray(FRAME_BYTES)

    private var carryLen = 0
    private var framesQueued = 0L
    private var packetsWritten = 0L
    private var pagesSinceSync = 0

    /**
     * The pre-skip the codec reported, in 48 kHz samples, or null if it has not
     * said (yet, or at all). Read once, when the first page is about to go out.
     */
    private var reportedPreSkip: Int? = null
    private var oggWriter: OggStreamWriter? = null
    private var oversizedPacketLogged = false

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
     * Zero-pad the last partial frame, flush the encoder, close the stream with
     * its end-of-stream page and release everything. Returns the finished file.
     * Call exactly once.
     *
     * A stream with no audio at all would be a file with headers and nothing
     * else, so one frame of silence is written instead — the file is always
     * valid, just 20 ms long.
     *
     * On failure this throws and leaves the partial file **in place** as long as
     * any Opus packets reached it; only a file that never received one is
     * deleted. See the comment on the catch for why. [cancel] is the way to ask
     * for the file to go away.
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
                val writer = oggWriter
                if (writer == null || packetsWritten == 0L) {
                    throw OpusEncodeException.MuxerFailed("encoder produced no Opus packets")
                }
                try {
                    writer.finish()
                    output.flush()
                    // The one sync that is never skipped: after this returns the
                    // recording survives anything short of the disk itself.
                    runCatching { rawOutput.fd.sync() }
                } catch (e: IOException) {
                    throw OpusEncodeException.MuxerFailed("could not finalise the Ogg file", e)
                }
                Log.i(
                    TAG,
                    "encoded ${outputFile.name}: $packetsWritten packets, " +
                        "${writer.pagesWritten} pages, ${durationMs}ms, " +
                        "${outputFile.length()} bytes",
                )
                return outputFile
            } catch (e: Throwable) {
                release()
                // Delete only a file with nothing in it. Ogg is a streaming
                // container and we now write the pages ourselves, so every page
                // that reached the sink is complete, CRC'd and independently
                // decodable: a stream we could not close cleanly really is a
                // recording that ends a fraction early. (The old comment here
                // claimed exactly that while `MediaMuxer`, which finalises the
                // container in `stop()`, quietly made it false — an unclosed
                // muxer file was a write-off.) The likeliest reason to be here is
                // the disk filling up mid-meeting, which is exactly when throwing
                // the meeting away is the worst possible answer. Callers that
                // want the partial file gone say so with [cancel].
                if (packetsWritten == 0L) runCatching { outputFile.delete() }
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
     * Move whatever the encoder has ready into the Ogg stream. With
     * `endOfStream = false` this returns as soon as nothing is pending (zero
     * timeout — safe to call from a live capture path); with `true` it blocks
     * until the encoder reports end of stream.
     */
    private fun drainOutput(endOfStream: Boolean) {
        val timeout = if (endOfStream) DEQUEUE_TIMEOUT_US else 0L
        var idle = 0
        while (true) {
            val index = codec.dequeueOutputBuffer(bufferInfo, timeout)
            when {
                index >= 0 -> {
                    idle = 0
                    if (consumeOutputBuffer(index)) return
                }

                index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    idle = 0
                    // The first moment the codec can tell us its pre-skip. It
                    // always precedes the first audio buffer, so the value is in
                    // hand before the headers are written.
                    captureFormatPreSkip(codec.outputFormat)
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

    /**
     * Route one ready output buffer — CSD blob or Opus packet — and release it.
     *
     * A codec-config buffer is the `OpusHead` the codec wants us to put in the
     * container, **not** audio: writing it as an audio page would put a header
     * packet in the middle of the stream and make the first second of every
     * recording garbage.
     *
     * @return true when that buffer carried the end-of-stream flag, i.e. the
     *   drain loop is done.
     */
    private fun consumeOutputBuffer(index: Int): Boolean {
        val isConfig = (bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0
        val buffer = codec.getOutputBuffer(index)
        if (buffer != null && bufferInfo.size > 0) {
            // clear() first: setting position before limit can throw
            // if the codec left a limit below our offset.
            buffer.clear()
            buffer.position(bufferInfo.offset)
            buffer.limit(bufferInfo.offset + bufferInfo.size)
            if (isConfig) {
                captureCsdPreSkip(buffer)
            } else {
                writePacket(buffer)
            }
        }
        val eos = (bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
        codec.releaseOutputBuffer(index, false)
        return eos
    }

    /**
     * Some encoders put `csd-0` in the output format; others emit it as a
     * `BUFFER_FLAG_CODEC_CONFIG` buffer and leave the format bare. Both paths
     * land here, and both are only interesting for one field.
     */
    private fun captureFormatPreSkip(format: MediaFormat) {
        if (reportedPreSkip != null) return
        val csd = runCatching {
            if (format.containsKey(KEY_CSD_0)) format.getByteBuffer(KEY_CSD_0) else null
        }.getOrNull() ?: return
        val copy = ByteArray(csd.remaining())
        csd.duplicate()[copy]
        reportedPreSkip = parsePreSkip(copy)
    }

    private fun captureCsdPreSkip(buffer: ByteBuffer) {
        if (reportedPreSkip != null) return
        val copy = ByteArray(bufferInfo.size)
        // Bulk read: `ByteBuffer.get(ByteArray)` reads as an indexed accessor in Kotlin.
        buffer.duplicate()[copy]
        reportedPreSkip = parsePreSkip(copy)
    }

    /**
     * One output buffer becomes one Ogg packet.
     *
     * That equivalence is an assumption about the codec, and it is the one thing
     * here that would fail quietly if it were wrong: granule positions count 960
     * samples per packet, so an encoder that bundled several 20 ms frames into a
     * single output buffer would produce a file whose clock runs slow — playback
     * ending early, timestamps drifting against the transcript. AOSP's Opus
     * encoder emits one packet per buffer (it is fed one frame at a time and has
     * nowhere to bundle), and no vendor encoder has been seen to differ, but the
     * failure is silent enough to be worth a tripwire: at 24 kbps a 20 ms packet
     * is ~60 bytes, so anything an order of magnitude larger gets a log line.
     */
    private fun writePacket(buffer: ByteBuffer) {
        val packet = ByteArray(bufferInfo.size)
        buffer[packet]
        if (!oversizedPacketLogged && packet.size > SUSPICIOUS_PACKET_BYTES) {
            oversizedPacketLogged = true
            Log.w(
                TAG,
                "Opus packet of ${packet.size} bytes for a 20 ms frame; if this codec " +
                    "bundles frames per buffer the granule positions will run slow",
            )
        }
        ensureOggWriter().append(packet)
        packetsWritten++
    }

    /**
     * The [OggStreamWriter], created — and its two header pages written — on the
     * way to the first audio page rather than in [create].
     *
     * The ordering is the subtle part of this class. `OpusHead` carries the
     * pre-skip, `OpusHead` must be the very first page in the file, and the
     * pre-skip is the encoder's own priming delay, which `MediaCodec` only
     * reveals once it has processed audio — as `csd-0` in the output format, or
     * as a codec-config output buffer, whichever this device's encoder does.
     * Waiting until a packet is actually in hand is what lets us use the real
     * value: guess it and every timestamp in the file is off by the difference,
     * which shows up as playback drifting against the transcript.
     *
     * By the time this runs, either [captureFormatPreSkip] or
     * [captureCsdPreSkip] has had its chance, because both happen strictly
     * before the first non-config output buffer. If neither produced anything we
     * fall back to the 312 samples (6.5 ms) that desktop and iOS use.
     */
    private fun ensureOggWriter(): OggStreamWriter {
        oggWriter?.let { return it }

        if (reportedPreSkip == null) {
            runCatching { codec.outputFormat }.getOrNull()?.let(::captureFormatPreSkip)
        }
        val preSkip = reportedPreSkip ?: OggStreamWriter.OPUS_PRE_SKIP
        if (reportedPreSkip == null) {
            Log.w(TAG, "encoder reported no OpusHead; assuming pre-skip $preSkip")
        }

        val writer = OggStreamWriter(sink = ::writePage, preSkip = preSkip)
        writer.writeHeaders()
        oggWriter = writer
        return writer
    }

    /**
     * Put one finished page on disk.
     *
     * The `flush()` is not optional bookkeeping — it is the durability promise.
     * Once the bytes are out of our buffer and into the OS page cache, killing
     * the process cannot lose them: the kernel still owns them and still writes
     * them out. Everything before that lives in a `BufferedOutputStream` that
     * dies with the process.
     */
    private fun writePage(page: ByteArray) {
        try {
            output.write(page)
            output.flush()
        } catch (e: IOException) {
            throw OpusEncodeException.MuxerFailed(
                "could not write ${outputFile.absolutePath}", e,
            )
        }
        if (++pagesSinceSync >= PAGES_PER_FSYNC) {
            pagesSinceSync = 0
            // A `flush()` survives the app dying; only an `fsync()` survives the
            // *machine* dying (kernel panic, battery pull). Doing it every page
            // would mean a disk barrier every second for the whole meeting; not
            // doing it at all would risk the page cache going down with the
            // kernel. Every ~30 pages is ~30 s of audio at ~3 KB a page: a
            // rounding error of I/O, and a bounded amount to lose. A failing
            // fsync is never a reason to fail a recording that is otherwise fine.
            runCatching { rawOutput.fd.sync() }
        }
    }

    private fun release() {
        if (released) return
        released = true
        runCatching { codec.stop() }
        runCatching { codec.release() }
        runCatching { output.close() }
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

        /** Offset of the pre-skip field inside a 19-byte `OpusHead`. */
        private const val PRE_SKIP_OFFSET = 10

        /**
         * `fsync()` cadence, in pages. See the comment at the call site in
         * [writePage] for the trade-off this number picks.
         */
        private const val PAGES_PER_FSYNC = 30

        /**
         * A 20 ms packet this large means the codec is not doing what we think.
         * See [writePacket]; ~60 bytes is normal at 24 kbps.
         */
        private const val SUSPICIOUS_PACKET_BYTES = 600

        /**
         * Output buffer size. Pages are flushed as they are produced, so this
         * only has to swallow one page (~3 KB at 24 kbps) without splitting the
         * write; 8 KB leaves room for a page that runs long.
         */
        private const val OUTPUT_BUFFER_BYTES = 8 * 1024

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

            val stream = try {
                outputFile.parentFile?.mkdirs()
                if (outputFile.exists()) outputFile.deleteQuietly()
                FileOutputStream(outputFile)
            } catch (e: Exception) {
                runCatching { codec.stop() }
                runCatching { codec.release() }
                throw OpusEncodeException.MuxerFailed("cannot write ${outputFile.absolutePath}", e)
            }

            return OggOpusEncoder(
                outputFile, codec, stream, BufferedOutputStream(stream, OUTPUT_BUFFER_BYTES),
            )
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
         * Read the pre-skip out of a codec-supplied `OpusHead`, or null if this
         * blob is not one.
         *
         * The check is worth having: `csd-0` is whatever the vendor decided to
         * put there, and a short or mislabelled blob would otherwise yield a
         * nonsense pre-skip that misaligns playback for the entire recording.
         * Rejecting it costs us the real priming figure and falls back to 312 —
         * a much smaller error than trusting garbage.
         */
        private fun parsePreSkip(head: ByteArray): Int? {
            if (head.size < OggStreamWriter.OPUS_HEAD_BYTES) return null
            if (String(head, 0, 8, Charsets.US_ASCII) != "OpusHead") return null
            val preSkip = ByteBuffer.wrap(head).order(ByteOrder.LITTLE_ENDIAN)
                .getShort(PRE_SKIP_OFFSET).toInt() and 0xFFFF
            return preSkip
        }
    }
}
