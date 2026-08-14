package com.pathors.parley.audio

import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.FlowCollector
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.transform
import kotlinx.coroutines.withContext
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.roundToInt

/** What we learned about an imported file before decoding it. */
data class AudioSourceInfo(
    /** Track MIME, e.g. `audio/mpeg`, `audio/mp4a-latm`, `audio/opus`, `audio/raw`. */
    val mimeType: String,
    /** Source sample rate in Hz. */
    val sampleRate: Int,
    /** Source channel count (downmixed to 1 on the way out). */
    val channelCount: Int,
    /** Duration in microseconds, or -1 when the container does not say. */
    val durationUs: Long,
) {
    /** Duration in milliseconds, or -1 when unknown. */
    val durationMs: Long get() = if (durationUs < 0) -1 else durationUs / 1000

    /** Bytes of 16 kHz mono s16le this file should produce, or -1 when unknown. */
    val estimatedPcmBytes: Long
        get() = if (durationUs < 0) -1 else durationUs * Pcm.BYTES_PER_SECOND / 1_000_000L
}

/** Progress-carrying events from [AudioFileDecoder.decodeWithProgress]. */
sealed interface DecodeEvent {
    /** Always the first event: what we are about to decode. */
    data class Started(val info: AudioSourceInfo) : DecodeEvent

    /**
     * One chunk of 16 kHz mono s16le PCM ([Pcm.CHUNK_BYTES] except the last).
     *
     * @property bytesDecoded total output bytes emitted so far, this chunk included
     * @property estimatedTotalBytes total output bytes expected, or -1 when the
     *   container had no duration
     */
    data class Chunk(
        val pcm: ByteArray,
        val bytesDecoded: Long,
        val estimatedTotalBytes: Long,
    ) : DecodeEvent {
        /** Progress in [0, 1], or -1f when the total is unknown. */
        val progress: Float
            get() = if (estimatedTotalBytes <= 0) -1f
            else (bytesDecoded.toDouble() / estimatedTotalBytes).coerceIn(0.0, 1.0).toFloat()

        /** Position in the source this chunk ends at, in microseconds. */
        val positionUs: Long
            get() = bytesDecoded * 1_000_000L / Pcm.BYTES_PER_SECOND
    }

    /**
     * Always the last event on a successful decode.
     *
     * @property durationUs the container's duration, or -1 when it had none
     * @property decodedDurationUs duration actually produced, derived from the
     *   output byte count — authoritative even when the container lied
     */
    data class Completed(
        val totalBytes: Long,
        val durationUs: Long,
        val decodedDurationUs: Long,
    ) : DecodeEvent
}

/** Typed failures from [AudioFileDecoder]. Nothing else escapes the flow. */
sealed class AudioDecodeException(message: String, cause: Throwable? = null) :
    Exception(message, cause) {

    /** The URI could not be opened or is not a media container we can parse. */
    class SourceUnreadable(uri: Uri, cause: Throwable? = null) :
        AudioDecodeException("cannot read audio source $uri", cause)

    /** Parsed fine, but there is no audio track in it (e.g. a silent video). */
    class NoAudioTrack(uri: Uri) : AudioDecodeException("no audio track in $uri")

    /** There is an audio track but this device has no decoder for it. */
    class UnsupportedCodec(val mimeType: String, cause: Throwable? = null) :
        AudioDecodeException("no decoder for $mimeType on this device", cause)

    /** The decoder started but failed or stalled part-way through. */
    class DecodeFailed(message: String, cause: Throwable? = null) :
        AudioDecodeException(message, cause)
}

/**
 * Decode any audio file Android can read into **16 kHz mono s16le PCM**,
 * streaming: the caller can push chunks to a websocket while the rest of the
 * file is still being decoded.
 *
 * Covers everything `MediaExtractor` + `MediaCodec` handle — mp3, m4a/aac,
 * wav, flac, ogg/vorbis, ogg/opus, webm, 3gp, and the audio track of an mp4
 * video — which is the same practical set as the desktop's Symphonia path.
 *
 * ```kotlin
 * // simple: stream to the relay
 * AudioFileDecoder.decode(context, uri).collect { relay.send(it) }
 *
 * // with progress + duration
 * AudioFileDecoder.decodeWithProgress(context, uri).collect { event ->
 *     when (event) {
 *         is DecodeEvent.Started   -> total = event.info.durationMs
 *         is DecodeEvent.Chunk     -> { relay.send(event.pcm); ui.progress(event.progress) }
 *         is DecodeEvent.Completed -> ui.done(event.decodedDurationUs / 1000)
 *     }
 * }
 * ```
 *
 * ## How it works
 *
 * `MediaExtractor` picks the first audio track; `MediaCodec` decodes it in a
 * synchronous dequeue loop (simplest correct end-of-stream handling: input EOS
 * is flagged on the last buffer, and the loop only exits on the *output* EOS
 * flag). Decoded PCM is downmixed by averaging channels, then run through
 * [Resampler] — a windowed-sinc band-limited converter, not linear
 * interpolation, so 44.1 kHz sources do not fold aliases into the speech band.
 * `audio/raw` tracks (WAV) skip `MediaCodec` entirely and are read straight off
 * the extractor.
 *
 * ## Flow semantics
 *
 * The work runs on [Dispatchers.IO]. The flow is cold — collecting twice
 * decodes twice — and back-pressures: a slow collector suspends the decode loop
 * rather than buffering the file in memory. Cancelling the collector releases
 * the codec and extractor promptly. All failures are [AudioDecodeException].
 */
object AudioFileDecoder {

    private const val TAG = "AudioFileDecoder"
    private const val DEQUEUE_TIMEOUT_US = 10_000L

    /** ~20 s of doing nothing at [DEQUEUE_TIMEOUT_US] before we call it stuck. */
    private const val MAX_STALL_ITERATIONS = 2_000

    private const val MIME_RAW = "audio/raw"
    private const val RAW_READ_BYTES = 64 * 1024

    /** Inspect a file without decoding it: MIME, rate, channels, duration. */
    suspend fun probe(context: Context, uri: Uri): AudioSourceInfo =
        withContext(Dispatchers.IO) { probeBlocking(context, uri) }

    /** Stream the file as 16 kHz mono s16le PCM chunks. */
    fun decode(
        context: Context,
        uri: Uri,
        quality: Resampler.Quality = Resampler.Quality.BALANCED,
    ): Flow<ByteArray> = decodeWithProgress(context, uri, quality).transform { event ->
        if (event is DecodeEvent.Chunk) emit(event.pcm)
    }

    /** As [decode], but also reporting the source info and decode progress. */
    fun decodeWithProgress(
        context: Context,
        uri: Uri,
        quality: Resampler.Quality = Resampler.Quality.BALANCED,
    ): Flow<DecodeEvent> = flow { decodeInto(this, context, uri, quality) }.flowOn(Dispatchers.IO)

    // ---------------------------------------------------------------- internals

    private fun probeBlocking(context: Context, uri: Uri): AudioSourceInfo {
        val extractor = MediaExtractor()
        try {
            openSource(extractor, context, uri)
            val track = selectAudioTrack(extractor, uri)
            return describe(context, uri, track.format, track.mime)
        } finally {
            runCatching { extractor.release() }
        }
    }

    private suspend fun decodeInto(
        out: FlowCollector<DecodeEvent>,
        context: Context,
        uri: Uri,
        quality: Resampler.Quality,
    ) {
        val extractor = MediaExtractor()
        var codec: MediaCodec? = null
        try {
            openSource(extractor, context, uri)
            val track = selectAudioTrack(extractor, uri)
            extractor.selectTrack(track.index)
            val info = describe(context, uri, track.format, track.mime)
            out.emit(DecodeEvent.Started(info))

            val sink = Pcm16Sink(info.sampleRate, info.channelCount, quality, Pcm.CHUNK_BYTES)
            val emitter = ChunkEmitter(out, info.estimatedPcmBytes)

            if (track.mime == MIME_RAW) {
                decodeRawTrack(extractor, track.format, sink, emitter)
            } else {
                codec = createDecoder(track.mime, track.format)
                decodeWithCodec(extractor, codec, sink, emitter)
            }

            val tail = ArrayList<ByteArray>(2)
            sink.finish(tail)
            emitter.emitAll(tail)
            out.emit(
                DecodeEvent.Completed(
                    totalBytes = sink.totalOutputBytes,
                    durationUs = info.durationUs,
                    decodedDurationUs =
                        sink.totalOutputBytes * 1_000_000L / Pcm.BYTES_PER_SECOND,
                ),
            )
        } catch (e: AudioDecodeException) {
            throw e
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw AudioDecodeException.DecodeFailed("decoding $uri failed: ${e.message}", e)
        } finally {
            codec?.let {
                runCatching { it.stop() }
                runCatching { it.release() }
            }
            runCatching { extractor.release() }
        }
    }

    /** Accumulates the running byte count and pushes chunks through the flow. */
    private class ChunkEmitter(
        private val out: FlowCollector<DecodeEvent>,
        private val estimatedTotalBytes: Long,
    ) {
        private var decoded = 0L

        suspend fun emitAll(chunks: List<ByteArray>) {
            for (chunk in chunks) {
                decoded += chunk.size
                out.emit(DecodeEvent.Chunk(chunk, decoded, estimatedTotalBytes))
            }
        }
    }

    private class Track(val index: Int, val mime: String, val format: MediaFormat)

    private fun openSource(extractor: MediaExtractor, context: Context, uri: Uri) {
        try {
            extractor.setDataSource(context, uri, null)
        } catch (e: Exception) {
            throw AudioDecodeException.SourceUnreadable(uri, e)
        }
    }

    private fun selectAudioTrack(extractor: MediaExtractor, uri: Uri): Track {
        for (i in 0 until extractor.trackCount) {
            val format = extractor.getTrackFormat(i)
            val mime = format.getString(MediaFormat.KEY_MIME) ?: continue
            if (mime.startsWith("audio/")) return Track(i, mime, format)
        }
        throw AudioDecodeException.NoAudioTrack(uri)
    }

    private fun describe(
        context: Context,
        uri: Uri,
        format: MediaFormat,
        mime: String,
    ): AudioSourceInfo {
        val rate = format.intOr(MediaFormat.KEY_SAMPLE_RATE, 0)
        val channels = format.intOr(MediaFormat.KEY_CHANNEL_COUNT, 1)
        if (rate <= 0) {
            throw AudioDecodeException.DecodeFailed("track $mime declares no sample rate")
        }
        val durationUs = when {
            format.containsKey(MediaFormat.KEY_DURATION) ->
                format.getLong(MediaFormat.KEY_DURATION)

            else -> retrieverDurationUs(context, uri)
        }
        return AudioSourceInfo(mime, rate, channels.coerceAtLeast(1), durationUs)
    }

    /** Fallback duration for containers whose track format has none. */
    private fun retrieverDurationUs(context: Context, uri: Uri): Long {
        val retriever = MediaMetadataRetriever()
        return try {
            retriever.setDataSource(context, uri)
            retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
                ?.toLongOrNull()
                ?.times(1000L)
                ?: -1L
        } catch (e: Exception) {
            Log.w(TAG, "no duration for $uri: ${e.message}")
            -1L
        } finally {
            runCatching { retriever.release() }
        }
    }

    private fun createDecoder(mime: String, format: MediaFormat): MediaCodec {
        val codec = try {
            MediaCodec.createDecoderByType(mime)
        } catch (e: Exception) {
            throw AudioDecodeException.UnsupportedCodec(mime, e)
        }
        try {
            codec.configure(format, null, null, 0)
        } catch (e: Exception) {
            runCatching { codec.release() }
            throw AudioDecodeException.UnsupportedCodec(mime, e)
        }
        return codec
    }

    /**
     * Synchronous MediaCodec decode loop.
     *
     * End-of-stream handling: once the extractor runs dry we queue an empty
     * input buffer flagged `BUFFER_FLAG_END_OF_STREAM` and keep draining until
     * an *output* buffer comes back with the same flag — draining is what makes
     * the codec release the samples it still holds. Codec-config output buffers
     * are skipped; a codec that neither accepts input nor produces output for
     * [MAX_STALL_ITERATIONS] rounds is declared stuck instead of spinning
     * forever.
     */
    private suspend fun decodeWithCodec(
        extractor: MediaExtractor,
        codec: MediaCodec,
        sink: Pcm16Sink,
        emitter: ChunkEmitter,
    ) {
        codec.start()
        val loop = CodecLoop()
        var stall = 0

        while (!loop.sawOutputEos) {
            currentCoroutineContext().ensureActive()
            var progressed = false

            if (!loop.sawInputEos) progressed = feedInput(extractor, codec, loop)
            if (pumpOutput(codec, sink, emitter, loop)) progressed = true

            if (progressed) {
                stall = 0
            } else if (++stall > MAX_STALL_ITERATIONS) {
                throw AudioDecodeException.DecodeFailed("decoder stalled before end of stream")
            }
        }
    }

    /** The mutable state of one [decodeWithCodec] run, so the halves can share it. */
    private class CodecLoop {
        val bufferInfo = MediaCodec.BufferInfo()
        val ready = ArrayList<ByteArray>(4)
        var pcmEncoding = Pcm.ENCODING_PCM_16BIT
        var sawInputEos = false
        var sawOutputEos = false
    }

    /**
     * Hand the extractor's next sample to the codec, flagging end of stream once
     * it runs dry.
     *
     * @return true when an input buffer was available this round.
     */
    private fun feedInput(
        extractor: MediaExtractor,
        codec: MediaCodec,
        loop: CodecLoop,
    ): Boolean {
        val inIndex = codec.dequeueInputBuffer(DEQUEUE_TIMEOUT_US)
        if (inIndex < 0) return false
        val buffer = codec.getInputBuffer(inIndex)
        val size = if (buffer == null) -1 else {
            buffer.clear()
            extractor.readSampleData(buffer, 0)
        }
        if (size < 0) {
            codec.queueInputBuffer(
                inIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM,
            )
            loop.sawInputEos = true
        } else {
            codec.queueInputBuffer(
                inIndex, 0, size, extractor.sampleTime.coerceAtLeast(0L), 0,
            )
            extractor.advance()
        }
        return true
    }

    /**
     * Take one round off the codec's output side.
     *
     * @return true when the codec had something for us — a buffer, a format
     *   change or a buffer-set change — i.e. the loop is not stalled.
     */
    private suspend fun pumpOutput(
        codec: MediaCodec,
        sink: Pcm16Sink,
        emitter: ChunkEmitter,
        loop: CodecLoop,
    ): Boolean {
        val outIndex = codec.dequeueOutputBuffer(loop.bufferInfo, DEQUEUE_TIMEOUT_US)
        return when {
            outIndex >= 0 -> {
                consumeOutput(codec, sink, emitter, loop, outIndex)
                true
            }

            outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                onOutputFormatChanged(codec, sink, emitter, loop)
                true
            }

            outIndex == MediaCodec.INFO_OUTPUT_BUFFERS_CHANGED -> true

            else -> false
        }
    }

    private suspend fun consumeOutput(
        codec: MediaCodec,
        sink: Pcm16Sink,
        emitter: ChunkEmitter,
        loop: CodecLoop,
        outIndex: Int,
    ) {
        val info = loop.bufferInfo
        val isConfig = (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0
        if (!isConfig && info.size > 0) {
            val buffer = codec.getOutputBuffer(outIndex)
            if (buffer != null) {
                loop.ready.clear()
                sink.feed(buffer, info.offset, info.size, loop.pcmEncoding, loop.ready)
            }
        }
        val eos = (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
        codec.releaseOutputBuffer(outIndex, false)
        // Emit after releasing: a slow collector must not pin a codec buffer.
        emitReady(emitter, loop)
        if (eos) loop.sawOutputEos = true
    }

    private suspend fun onOutputFormatChanged(
        codec: MediaCodec,
        sink: Pcm16Sink,
        emitter: ChunkEmitter,
        loop: CodecLoop,
    ) {
        val format = codec.outputFormat
        loop.pcmEncoding = format.intOr(MediaFormat.KEY_PCM_ENCODING, Pcm.ENCODING_PCM_16BIT)
        val rate = format.intOr(MediaFormat.KEY_SAMPLE_RATE, sink.sourceRate)
        val channels = format.intOr(MediaFormat.KEY_CHANNEL_COUNT, sink.channels)
        loop.ready.clear()
        sink.reconfigure(rate, channels, loop.ready)
        emitReady(emitter, loop)
        Log.i(TAG, "decoder output: $rate Hz, $channels ch, encoding ${loop.pcmEncoding}")
    }

    private suspend fun emitReady(emitter: ChunkEmitter, loop: CodecLoop) {
        if (loop.ready.isNotEmpty()) {
            emitter.emitAll(loop.ready)
            loop.ready.clear()
        }
    }

    /**
     * WAV and friends: `MediaExtractor` already hands us PCM, so the `audio/raw`
     * passthrough decoder buys nothing and only adds a device-dependent
     * component to the path.
     */
    private suspend fun decodeRawTrack(
        extractor: MediaExtractor,
        format: MediaFormat,
        sink: Pcm16Sink,
        emitter: ChunkEmitter,
    ) {
        val encoding = format.intOr(MediaFormat.KEY_PCM_ENCODING, Pcm.ENCODING_PCM_16BIT)
        val buffer = ByteBuffer.allocate(RAW_READ_BYTES)
        val ready = ArrayList<ByteArray>(4)
        while (true) {
            currentCoroutineContext().ensureActive()
            buffer.clear()
            val size = extractor.readSampleData(buffer, 0)
            if (size < 0) break
            if (size > 0) {
                ready.clear()
                sink.feed(buffer, 0, size, encoding, ready)
                if (ready.isNotEmpty()) emitter.emitAll(ready)
            }
            if (!extractor.advance()) break
        }
    }

    private fun MediaFormat.intOr(key: String, fallback: Int): Int =
        if (containsKey(key)) getInteger(key) else fallback
}

/**
 * Decoder output → 16 kHz mono s16le chunks: de-interleave/downmix, resample,
 * quantise, and cut into fixed-size chunks.
 *
 * Deliberately free of Android types (PCM encodings come from [Pcm], buffers are
 * plain [ByteBuffer]) so it can be unit-tested on the JVM. All byte access is
 * explicitly [ByteOrder.LITTLE_ENDIAN]: that is both what every Android ABI
 * hands us and what the rest of the pipeline expects.
 *
 * Not thread-safe; one instance per decode.
 */
internal class Pcm16Sink(
    var sourceRate: Int,
    var channels: Int,
    private val quality: Resampler.Quality,
    private val chunkBytes: Int,
) {
    private var resampler = Resampler(sourceRate, Pcm.SAMPLE_RATE, quality)
    private var interleaved = FloatArray(0)
    private var mono = FloatArray(0)
    private val carry = ByteArray(chunkBytes)
    private var carryLen = 0

    /** Total 16 kHz mono s16le bytes handed to the caller so far. */
    var totalOutputBytes: Long = 0
        private set

    init {
        require(chunkBytes > 0 && chunkBytes % Pcm.BYTES_PER_SAMPLE == 0) {
            "chunkBytes must be a positive even number (got $chunkBytes)"
        }
    }

    /**
     * Consume `size` bytes of interleaved PCM starting at `offset`, appending
     * completed chunks to [out].
     *
     * @throws AudioDecodeException.DecodeFailed for a PCM encoding we cannot read
     */
    fun feed(
        buffer: ByteBuffer,
        offset: Int,
        size: Int,
        encoding: Int,
        out: MutableList<ByteArray>,
    ) {
        val bytesPerSample = Pcm.bytesPerSample(encoding)
        if (bytesPerSample == 0) {
            throw AudioDecodeException.DecodeFailed("unsupported PCM encoding $encoding")
        }
        val frameBytes = bytesPerSample * channels
        val frames = size / frameBytes
        if (frames <= 0) return

        val needed = frames * channels
        if (interleaved.size < needed) interleaved = FloatArray(needed)
        if (mono.size < frames) mono = FloatArray(frames)

        // Own the position/limit rather than trusting whatever the producer left
        // behind: clear() first so `offset` can never fall outside the limit.
        val view = buffer.duplicate().order(ByteOrder.LITTLE_ENDIAN)
        view.clear()
        view.position(offset)
        view.limit(offset + frames * frameBytes)
        readSamples(view, needed, encoding)

        Pcm.downmixToMono(interleaved, frames, channels, mono)
        appendPcm(resampler.process(mono, frames), out)
    }

    /** Mid-stream format change (rare): flush the old converter, build a new one. */
    fun reconfigure(rate: Int, channelCount: Int, out: MutableList<ByteArray>) {
        if (rate == sourceRate && channelCount == channels) return
        appendPcm(resampler.flush(), out)
        sourceRate = rate
        channels = channelCount.coerceAtLeast(1)
        resampler = Resampler(sourceRate, Pcm.SAMPLE_RATE, quality)
    }

    /** Flush the resampler tail and the partial chunk. Call once, at the end. */
    fun finish(out: MutableList<ByteArray>) {
        appendPcm(resampler.flush(), out)
        if (carryLen > 0) {
            out.add(carry.copyOf(carryLen))
            totalOutputBytes += carryLen
            carryLen = 0
        }
    }

    private fun readSamples(view: ByteBuffer, count: Int, encoding: Int) {
        when (encoding) {
            Pcm.ENCODING_PCM_16BIT -> {
                val shorts = view.asShortBuffer()
                for (i in 0 until count) interleaved[i] = shorts.get().toFloat() / 32768f
            }

            Pcm.ENCODING_PCM_FLOAT -> {
                val floats = view.asFloatBuffer()
                for (i in 0 until count) interleaved[i] = floats.get()
            }

            Pcm.ENCODING_PCM_8BIT -> {
                // Android's 8-bit PCM is unsigned, centred on 128.
                for (i in 0 until count) {
                    interleaved[i] = ((view.get().toInt() and 0xFF) - 128) / 128f
                }
            }

            Pcm.ENCODING_PCM_24BIT_PACKED -> {
                for (i in 0 until count) {
                    val b0 = view.get().toInt() and 0xFF
                    val b1 = view.get().toInt() and 0xFF
                    val b2 = view.get().toInt() // sign-extends the top byte
                    interleaved[i] = ((b2 shl 16) or (b1 shl 8) or b0) / 8388608f
                }
            }

            Pcm.ENCODING_PCM_32BIT -> {
                val ints = view.asIntBuffer()
                for (i in 0 until count) interleaved[i] = ints.get() / 2147483648f
            }

            else -> throw AudioDecodeException.DecodeFailed("unsupported PCM encoding $encoding")
        }
    }

    private fun appendPcm(samples: FloatArray, out: MutableList<ByteArray>) {
        for (sample in samples) {
            // Round to nearest, same as Pcm.floatToS16le — truncation would bias
            // every sample toward zero by up to a full LSB.
            val v = (sample.coerceIn(-1f, 1f) * 32767f).roundToInt()
            carry[carryLen++] = (v and 0xFF).toByte()
            carry[carryLen++] = ((v shr 8) and 0xFF).toByte()
            if (carryLen == chunkBytes) {
                out.add(carry.copyOf())
                totalOutputBytes += chunkBytes
                carryLen = 0
            }
        }
    }
}
