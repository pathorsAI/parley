package com.pathors.parley.audio

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Process
import android.util.Log
import kotlinx.coroutines.channels.ProducerScope
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.channels.trySendBlocking
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.callbackFlow
import kotlin.math.max

/**
 * Failure modes of [MicCapture]. The [Flow] returned by [MicCapture.start] fails
 * with one of these; nothing else is thrown out of the flow.
 */
sealed class MicCaptureException(message: String, cause: Throwable? = null) :
    Exception(message, cause) {

    /** `RECORD_AUDIO` was not granted when capture started. */
    class PermissionDenied :
        MicCaptureException("RECORD_AUDIO permission is not granted")

    /** No usable AudioRecord configuration — every candidate sample rate failed. */
    class UnsupportedConfiguration(message: String) : MicCaptureException(message)

    /** The microphone exists but could not be opened or started (busy, in a call…). */
    class DeviceUnavailable(message: String, cause: Throwable? = null) :
        MicCaptureException(message, cause)

    /**
     * `AudioRecord.read` returned an error mid-stream: the device died
     * ([AudioRecord.ERROR_DEAD_OBJECT]) or the record object was invalidated
     * ([AudioRecord.ERROR_INVALID_OPERATION]) — which is what a mid-stream
     * permission revocation looks like on the devices that do not simply kill
     * the process.
     */
    class ReadFailed(val errorCode: Int) :
        MicCaptureException("AudioRecord.read failed with $errorCode")
}

/**
 * Microphone capture → a [Flow] of **16 kHz mono s16le PCM** chunks, the
 * pipeline's universal format. The Android counterpart of iOS `AudioCapture` and
 * desktop `audio/microphone.rs`.
 *
 * ```kotlin
 * val mic = MicCapture(context)
 * scope.launch {
 *     mic.start()
 *         .catch { e -> ui.showError(e as MicCaptureException) }
 *         .collect { chunk -> relay.send(chunk); encoder.append(chunk) }
 * }
 * // later, from anywhere:
 * mic.stop()
 * ```
 *
 * ## Semantics
 *
 * * **Cold flow.** Recording starts when collection starts and ends when
 *   collection ends. Collect it once at a time; a second concurrent collection
 *   opens a second `AudioRecord` and will most likely fail with
 *   [MicCaptureException.DeviceUnavailable].
 * * **Chunk size.** Exactly [Pcm.CHUNK_BYTES] (100 ms) per emission, except for
 *   a possible short final chunk. A stable size keeps the relay's byte metering
 *   honest.
 * * **Threading.** `AudioRecord.read` runs on a dedicated thread at
 *   `THREAD_PRIORITY_URGENT_AUDIO`; chunks reach the collector through the
 *   `callbackFlow` channel (64-chunk buffer ≈ 6.4 s of slack). When the
 *   collector cannot keep up the reader thread blocks on send, which is the
 *   right back-pressure: the `AudioRecord` ring buffer absorbs the difference
 *   and, if the stall outlasts it, the kernel drops the oldest audio rather than
 *   the app growing without bound.
 * * **Stopping.** [stop] completes the flow *normally* (the collector sees a
 *   clean end of stream). Cancelling the collecting coroutine also works and is
 *   equally safe. Either way the `AudioRecord` is stopped and released before
 *   the flow finishes.
 * * **Audio source.** [MediaRecorder.AudioSource.VOICE_RECOGNITION] — the
 *   speech-to-text source, which on most devices bypasses the AGC/noise
 *   suppression tuned for phone calls. Falls back to
 *   [MediaRecorder.AudioSource.MIC] when the device will not open it.
 * * **Sample rate.** 16 kHz capture is mandated by the CDD and is what we ask
 *   for. On a device that refuses it we capture at 48 kHz or 44.1 kHz and run
 *   [Resampler] in the read loop (≈ 0.3 % of one core) so callers always see
 *   16 kHz.
 *
 * ## Error policy
 *
 * Every failure is surfaced as a [MicCaptureException] through the flow
 * (`catch { }`), never thrown from [start] itself and never swallowed:
 *
 * | Situation | Result |
 * |---|---|
 * | `RECORD_AUDIO` missing at start | [MicCaptureException.PermissionDenied] |
 * | Mic busy / in a call / opened by a higher-priority app | [MicCaptureException.DeviceUnavailable] |
 * | No sample rate works | [MicCaptureException.UnsupportedConfiguration] |
 * | Device died or permission revoked mid-stream | [MicCaptureException.ReadFailed] |
 *
 * One case Android gives us no signal for: from Android 10 on, when another app
 * takes the mic away mid-recording the framework feeds us **silence** instead of
 * an error. Detecting that needs
 * `AudioManager.registerAudioRecordingCallback`, which belongs with the UI /
 * foreground-service layer, not here. The [level] meter makes it visible to the
 * user in the meantime.
 */
class MicCapture @JvmOverloads constructor(
    private val context: Context,
    private val chunkBytes: Int = Pcm.CHUNK_BYTES,
) {
    private val _level = MutableStateFlow(0f)

    /** RMS of the most recent chunk, in [0, 1] — for a level meter. */
    val level: StateFlow<Float> = _level.asStateFlow()

    @Volatile
    private var stopRequested = false

    /** Sample rate actually opened on the device (16 000 unless it refused). */
    @Volatile
    var captureSampleRate: Int = Pcm.SAMPLE_RATE
        private set

    /** The `MediaRecorder.AudioSource` actually opened, or -1 before [start]. */
    @Volatile
    var captureSource: Int = -1
        private set

    init {
        require(chunkBytes > 0 && chunkBytes % Pcm.BYTES_PER_SAMPLE == 0) {
            "chunkBytes must be a positive even number (got $chunkBytes)"
        }
    }

    /**
     * Start capturing. Each emission is [chunkBytes] of 16 kHz mono s16le PCM.
     * See the class docs for the error policy.
     */
    fun start(): Flow<ByteArray> = callbackFlow {
        stopRequested = false
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            throw MicCaptureException.PermissionDenied()
        }

        val opened = openRecord()
        captureSampleRate = opened.sampleRate
        captureSource = opened.source
        val record = opened.record

        try {
            record.startRecording()
        } catch (e: IllegalStateException) {
            record.release()
            throw MicCaptureException.DeviceUnavailable("could not start recording", e)
        }
        if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
            runCatching { record.stop() }
            record.release()
            throw MicCaptureException.DeviceUnavailable(
                "microphone is busy (recordingState=${record.recordingState})",
            )
        }

        val producer = this@callbackFlow
        val thread = Thread({ readLoop(producer, record, opened.sampleRate) }, "parley-mic")
        thread.isDaemon = true
        thread.start()

        awaitClose {
            stopRequested = true
            runCatching { thread.join(THREAD_JOIN_MILLIS) }
            runCatching { record.stop() }
            runCatching { record.release() }
            _level.value = 0f
        }
    }

    /**
     * Stop capturing and let the flow complete normally. Idempotent, safe from
     * any thread, and a no-op when nothing is running.
     */
    fun stop() {
        stopRequested = true
    }

    // ---------------------------------------------------------------- internals

    private class OpenedRecord(val record: AudioRecord, val sampleRate: Int, val source: Int)

    /**
     * Open an `AudioRecord`, preferring VOICE_RECOGNITION at 16 kHz and walking
     * down the fallbacks. Buffer is at least 2× the reported minimum and at
     * least 4 chunks, so a scheduling hiccup cannot cost us audio.
     */
    @SuppressLint("MissingPermission") // checked by the caller before we get here
    private fun openRecord(): OpenedRecord {
        val failures = StringBuilder()
        for (rate in CANDIDATE_RATES) {
            val minBuffer = AudioRecord.getMinBufferSize(
                rate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
            )
            if (minBuffer <= 0) {
                failures.append("${rate}Hz: getMinBufferSize=$minBuffer; ")
                continue
            }
            val chunkAtRate = rate * Pcm.CHUNK_MILLIS / 1000 * Pcm.BYTES_PER_SAMPLE
            val bufferSize = max(minBuffer * 2, chunkAtRate * 4)
            for (source in CANDIDATE_SOURCES) {
                val record = try {
                    AudioRecord.Builder()
                        .setAudioSource(source)
                        .setAudioFormat(
                            AudioFormat.Builder()
                                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                                .setSampleRate(rate)
                                .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                                .build(),
                        )
                        .setBufferSizeInBytes(bufferSize)
                        .build()
                } catch (e: Exception) {
                    // UnsupportedOperationException / IllegalArgumentException /
                    // SecurityException all mean "not this combination".
                    failures.append("${rate}Hz src=$source: ${e.javaClass.simpleName}; ")
                    continue
                }
                if (record.state == AudioRecord.STATE_INITIALIZED) {
                    Log.i(TAG, "capturing at $rate Hz mono, source=$source → ${Pcm.SAMPLE_RATE} Hz")
                    return OpenedRecord(record, rate, source)
                }
                failures.append("${rate}Hz src=$source: state=${record.state}; ")
                record.release()
            }
        }
        throw MicCaptureException.UnsupportedConfiguration(
            "no usable AudioRecord configuration ($failures)",
        )
    }

    /**
     * Drain the `AudioRecord` on a dedicated thread until [stop], cancellation or
     * an error. Runs off the coroutine machinery entirely: it only touches the
     * producer scope to hand chunks over.
     */
    private fun readLoop(scope: ProducerScope<ByteArray>, record: AudioRecord, sourceRate: Int) {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
        val resampler =
            if (sourceRate == Pcm.SAMPLE_RATE) null else Resampler(sourceRate, Pcm.SAMPLE_RATE)
        // One read ≈ one chunk of source audio.
        val readBytes = sourceRate * Pcm.CHUNK_MILLIS / 1000 * Pcm.BYTES_PER_SAMPLE
        val readBuf = ByteArray(readBytes)
        val floats = FloatArray(readBytes / Pcm.BYTES_PER_SAMPLE)
        val sender = ChunkSender(scope)

        try {
            loop@ while (!stopRequested && sender.open) {
                val read = record.read(readBuf, 0, readBytes)
                when {
                    read > 0 ->
                        if (!deliverRead(sender, resampler, readBuf, read, floats)) break@loop
                    read == 0 -> continue@loop // no data yet; poll the stop flag again
                    else -> throw MicCaptureException.ReadFailed(read)
                }
            }
            // Tail: whatever the resampler still holds, plus a short final chunk.
            if (sender.open) flushTail(sender, resampler)
            scope.close()
        } catch (e: Throwable) {
            scope.close(e)
        }
    }

    /**
     * Resample one `AudioRecord.read` result when the device forced us off
     * 16 kHz, then hand it to [sender].
     *
     * @return false when the collector is gone and the read loop should stop.
     */
    private fun deliverRead(
        sender: ChunkSender,
        resampler: Resampler?,
        readBuf: ByteArray,
        read: Int,
        floats: FloatArray,
    ): Boolean {
        val payload: ByteArray
        val payloadLen: Int
        if (resampler == null) {
            payload = readBuf
            payloadLen = read
        } else {
            val n = Pcm.s16leToFloat(readBuf, 0, read, floats)
            val resampled = resampler.process(floats, n)
            payload = Pcm.floatToS16le(resampled, resampled.size)
            payloadLen = payload.size
        }
        return payloadLen <= 0 || sender.deliver(payload, payloadLen)
    }

    /** Everything the resampler still holds, then the short final chunk. */
    private fun flushTail(sender: ChunkSender, resampler: Resampler?) {
        if (resampler != null) {
            val tail = resampler.flush()
            if (tail.isNotEmpty()) sender.deliver(Pcm.floatToS16le(tail, tail.size), tail.size * 2)
        }
        sender.flushPartial()
    }

    /**
     * Cuts the reader thread's variable-sized reads into exactly [chunkBytes]
     * emissions, meters each one, and hands them to the collector.
     */
    private inner class ChunkSender(private val scope: ProducerScope<ByteArray>) {
        private val chunk = ByteArray(chunkBytes)
        private var chunkLen = 0

        /** False once the collector has gone away and nothing more can be sent. */
        var open = true
            private set

        /** @return false when the collector is gone and we should stop. */
        fun deliver(bytes: ByteArray, length: Int): Boolean {
            var consumed = 0
            while (consumed < length) {
                val n = minOf(chunkBytes - chunkLen, length - consumed)
                System.arraycopy(bytes, consumed, chunk, chunkLen, n)
                chunkLen += n
                consumed += n
                if (chunkLen == chunkBytes) {
                    val out = chunk.copyOf()
                    _level.value = Pcm.rmsFromS16le(out)
                    chunkLen = 0
                    if (scope.trySendBlocking(out).isFailure) {
                        open = false
                        return false
                    }
                }
            }
            return true
        }

        /** Emit whatever is left of a partial chunk. */
        fun flushPartial() {
            if (chunkLen > 0) {
                scope.trySendBlocking(chunk.copyOf(chunkLen))
            }
        }
    }

    companion object {
        private const val TAG = "MicCapture"
        private const val THREAD_JOIN_MILLIS = 2_000L

        /** 16 kHz is CDD-mandated; the rest are insurance. */
        private val CANDIDATE_RATES = intArrayOf(Pcm.SAMPLE_RATE, 48_000, 44_100)

        private val CANDIDATE_SOURCES = intArrayOf(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            MediaRecorder.AudioSource.MIC,
        )
    }
}
