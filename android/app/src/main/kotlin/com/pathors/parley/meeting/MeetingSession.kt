package com.pathors.parley.meeting

import android.content.Context
import android.os.SystemClock
import com.pathors.parley.audio.MicCapture
import com.pathors.parley.audio.MicCaptureException
import com.pathors.parley.audio.OggOpusEncoder
import com.pathors.parley.audio.OpusEncodeException
import com.pathors.parley.auth.AuthManager
import com.pathors.parley.cloud.RecordingSource
import com.pathors.parley.cloud.TranscriptSegmentDto
import com.pathors.parley.kit.SttRelayClient
import com.pathors.parley.kit.SttRelayEvent
import com.pathors.parley.kit.TranscriptSegment
import com.pathors.parley.upload.EnqueueRequest
import com.pathors.parley.upload.MeetingUploader
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** Where a live meeting is in its lifecycle. Everything the UI renders hangs off this. */
sealed interface MeetingState {
    /** Constructed but not started. */
    data object Idle : MeetingState

    /** Opening the relay socket and the encoder. */
    data object Connecting : MeetingState

    /** Microphone is live; audio is being encoded and streamed. */
    data object Recording : MeetingState

    /** Input drained; waiting for the relay to flush the last utterance. */
    data object Finishing : MeetingState

    /** Audio and transcript are on disk; pushing them to the cloud. */
    data object Uploading : MeetingState

    /**
     * Done. [recordingId] is null when the capture was dropped as a misfire
     * ([dropped]); [pendingUpload] means it is saved locally but not yet in the
     * cloud, which is a normal offline outcome, not a failure.
     */
    data class Finished(
        val recordingId: String?,
        val pendingUpload: Boolean,
        val dropped: Boolean,
    ) : MeetingState

    /** The recording could not happen (or could not be saved). */
    data class Failed(val reason: MeetingFailure, val detail: String? = null) : MeetingState
}

/** Why a meeting ended badly. The UI owns the (bilingual) copy for each case. */
enum class MeetingFailure {
    NOT_SIGNED_IN,
    MIC_PERMISSION,
    MIC_UNAVAILABLE,
    ENCODER_UNAVAILABLE,
    UPLOAD_FAILED,
    UNKNOWN,
}

/**
 * A transcription problem that did **not** stop the recording. The mic keeps
 * running and the audio is still saved and uploaded — only the live transcript
 * stopped growing — so this is a banner, not an error screen.
 */
enum class TranscriptionIssue {
    QUOTA_EXCEEDED,
    RELAY_ERROR,
    RELAY_CLOSED,
}

/**
 * One live meeting: microphone → Ogg/Opus file **and** microphone → STT relay,
 * from the same chunk stream, plus the upload that follows.
 *
 * ```
 * MicCapture ──ByteArray(3200)──┬──▶ OggOpusEncoder.append   ──▶ {id}.ogg
 *                               └──▶ SttRelayClient.sendPcm  ──▶ segments
 * ```
 *
 * Hosted by [MeetingService] so the capture survives the screen going away; the
 * UI observes the flows and never touches the pipeline directly beyond [stop].
 *
 * The session owns its own coroutine scope: it must outlive both the composable
 * that shows it and the service that started it (the upload tail runs while the
 * service is already stopping itself).
 */
class MeetingSession(
    private val context: Context,
    private val auth: AuthManager,
    private val uploader: MeetingUploader,
    /** Display title for the finished recording; built by the UI layer. */
    private val title: String,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    private val mic = MicCapture(context)

    private val _state = MutableStateFlow<MeetingState>(MeetingState.Idle)
    val state: StateFlow<MeetingState> = _state.asStateFlow()

    private val _segments = MutableStateFlow<List<TranscriptSegment>>(emptyList())
    val segments: StateFlow<List<TranscriptSegment>> = _segments.asStateFlow()

    private val _issue = MutableStateFlow<TranscriptionIssue?>(null)
    val issue: StateFlow<TranscriptionIssue?> = _issue.asStateFlow()

    private val _elapsedMs = MutableStateFlow(0L)
    val elapsedMs: StateFlow<Long> = _elapsedMs.asStateFlow()

    /** RMS of the last microphone chunk, 0..1 — drives the level meter. */
    val level: StateFlow<Float> get() = mic.level

    /** Wall-clock start, carried into the recording's `createdAt`. */
    val startedAtMs: Long = System.currentTimeMillis()

    private var relay: SttRelayClient? = null
    private var encoder: OggOpusEncoder? = null
    private var captureJob: Job? = null
    private var eventsJob: Job? = null
    private var tickerJob: Job? = null

    @Volatile private var finishRequested = false

    /**
     * Committed runs and the tentative tail, keyed by segment id — the relay
     * re-emits a growing run under the same id, so this is an upsert, never an
     * append. Insertion order is transcript order.
     */
    private val byId = LinkedHashMap<String, TranscriptSegment>()

    /** Begin capturing. Safe to call twice; the second call is a no-op. */
    fun start() {
        if (_state.value !is MeetingState.Idle) return
        _state.value = MeetingState.Connecting
        captureJob = scope.launch { runCapture() }
    }

    private suspend fun runCapture() {
        val token = auth.currentToken()
        if (token == null) {
            _state.value = MeetingState.Failed(MeetingFailure.NOT_SIGNED_IN)
            return
        }

        val encoder = try {
            OggOpusEncoder.create(newAudioFile())
        } catch (e: OpusEncodeException) {
            _state.value = MeetingState.Failed(MeetingFailure.ENCODER_UNAVAILABLE, e.message)
            return
        }
        this.encoder = encoder

        val client = SttRelayClient(
            SttRelayClient.Options(
                bearerToken = token,
                feature = SttRelayClient.Feature.MEETING,
            )
        )
        relay = client
        // Collect before connecting: connect() does not wait for the stream, and
        // a rejected handshake arrives as an event rather than an exception.
        eventsJob = scope.launch { client.events.collect(::onRelayEvent) }
        client.connect()

        _state.value = MeetingState.Recording
        startTicker()

        try {
            mic.start().collect { chunk ->
                encoder.append(chunk)
                client.sendPcm(chunk)
            }
        } catch (e: MicCaptureException) {
            abandon()
            _state.value = MeetingState.Failed(micFailure(e), e.message)
        } catch (e: OpusEncodeException) {
            abandon()
            _state.value = MeetingState.Failed(MeetingFailure.ENCODER_UNAVAILABLE, e.message)
        }
    }

    private fun onRelayEvent(event: SttRelayEvent) {
        when (event) {
            is SttRelayEvent.Segment -> upsert(event.segment)
            is SttRelayEvent.QuotaExceeded -> _issue.value = TranscriptionIssue.QUOTA_EXCEEDED
            is SttRelayEvent.Error -> _issue.value = TranscriptionIssue.RELAY_ERROR
            // A close after finalize is the normal end of the stream.
            is SttRelayEvent.Closed ->
                if (!finishRequested) _issue.value = TranscriptionIssue.RELAY_CLOSED
        }
    }

    private fun upsert(segment: TranscriptSegment) {
        if (segment.text.isEmpty()) {
            // An empty tail clears the tentative row.
            byId.remove(segment.id) ?: return
        } else {
            byId[segment.id] = segment
        }
        _segments.value = byId.values.toList()
    }

    private fun startTicker() {
        val startedAt = SystemClock.elapsedRealtime()
        tickerJob = scope.launch {
            while (true) {
                _elapsedMs.value = SystemClock.elapsedRealtime() - startedAt
                delay(TICK_MS)
            }
        }
    }

    /**
     * Stop recording, finish the transcript, then save and upload.
     *
     * Runs to completion in the caller's coroutine (the application scope — see
     * [MeetingService]), so the state flow keeps reporting progress even after
     * the service has stopped itself.
     */
    suspend fun stop() {
        val current = _state.value
        if (current !is MeetingState.Recording && current !is MeetingState.Connecting) return
        finishRequested = true
        _state.value = MeetingState.Finishing
        tickerJob?.cancel()

        mic.stop()
        withTimeoutOrNull(CAPTURE_JOIN_TIMEOUT_MS) { captureJob?.join() }

        relay?.let { client ->
            runCatching { client.finish() }
            // The relay keeps the socket open to flush the last utterance; the
            // events flow completes when it closes. Don't wait forever for it.
            withTimeoutOrNull(TAIL_TIMEOUT_MS) { eventsJob?.join() }
            client.cancel()
        }
        eventsJob?.cancel()

        // stop() can win the race against runCapture() reaching the encoder, so
        // there may be nothing to finish. Pin it to a local: from here on the
        // type system carries the fact that we have an encoder.
        val encoder = this.encoder
        if (encoder == null) {
            _state.value = MeetingState.Failed(MeetingFailure.ENCODER_UNAVAILABLE)
            return
        }
        val audio = try {
            withContext(Dispatchers.IO) { encoder.finish() }
        } catch (e: OpusEncodeException) {
            _state.value = MeetingState.Failed(MeetingFailure.ENCODER_UNAVAILABLE, e.message)
            return
        }
        val durationMs = encoder.durationMs.toDouble()

        _state.value = MeetingState.Uploading
        val id = try {
            uploader.enqueue(
                EnqueueRequest(
                    audio = audio,
                    title = title,
                    durationMs = durationMs,
                    segments = finalSegments(),
                    startedAtMs = startedAtMs,
                    source = RecordingSource.LIVE,
                )
            )
        } catch (e: Throwable) {
            _state.value = MeetingState.Failed(MeetingFailure.UPLOAD_FAILED, e.message)
            return
        }
        if (id == null) {
            // Under two seconds: a tap of the record button, not a meeting.
            _state.value = MeetingState.Finished(null, pendingUpload = false, dropped = true)
            return
        }
        val result = runCatching { uploader.drain() }.getOrNull()
        _state.value = MeetingState.Finished(
            recordingId = id,
            pendingUpload = result == null || result.remaining > 0,
            dropped = false,
        )
    }

    /**
     * Tear everything down without saving — the process is going away, or the
     * capture already failed. Idempotent.
     */
    fun abandon() {
        tickerJob?.cancel()
        eventsJob?.cancel()
        runCatching { mic.stop() }
        runCatching { relay?.cancel() }
        runCatching { encoder?.cancel() }
    }

    /** Release everything this session still holds. */
    fun dispose() {
        abandon()
        scope.coroutineContext[Job]?.cancel()
    }

    /** Finals only, tentative tail dropped — what the cloud persists. */
    private fun finalSegments(): List<TranscriptSegmentDto> =
        byId.values
            .filter { it.isFinal && !it.id.endsWith(MeetingUploader.TAIL_SUFFIX) }
            .map {
                TranscriptSegmentDto(
                    id = it.id,
                    source = it.source,
                    speaker = it.speaker,
                    text = it.text,
                    isFinal = true,
                    startMs = it.startMs,
                    endMs = it.endMs,
                )
            }

    private fun newAudioFile(): File {
        val dir = File(context.cacheDir, RECORDINGS_DIR).apply { mkdirs() }
        return File(dir, "meeting-$startedAtMs.ogg")
    }

    private fun micFailure(e: MicCaptureException): MeetingFailure = when (e) {
        is MicCaptureException.PermissionDenied -> MeetingFailure.MIC_PERMISSION
        is MicCaptureException.DeviceUnavailable -> MeetingFailure.MIC_UNAVAILABLE
        is MicCaptureException.UnsupportedConfiguration -> MeetingFailure.MIC_UNAVAILABLE
        is MicCaptureException.ReadFailed -> MeetingFailure.MIC_UNAVAILABLE
    }

    private companion object {
        const val RECORDINGS_DIR = "recordings"
        const val TICK_MS = 200L

        /** How long to wait for the relay's flushed tail before giving up on it. */
        const val TAIL_TIMEOUT_MS = 8_000L
        const val CAPTURE_JOIN_TIMEOUT_MS = 5_000L
    }
}
