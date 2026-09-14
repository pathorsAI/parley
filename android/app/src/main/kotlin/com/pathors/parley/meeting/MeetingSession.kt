package com.pathors.parley.meeting

import android.content.Context
import android.media.AudioManager
import android.media.AudioRecordingConfiguration
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
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
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
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
     *
     * [interruptedBy] is set when the meeting was saved because something ended
     * it rather than because the user did — the mic was taken, the process lost
     * the foreground service, an unexpected exception reached the capture loop.
     * The recording is real and complete up to that moment; the flag is there so
     * the UI can say so instead of implying the user stopped when they did not.
     */
    data class Finished(
        val recordingId: String?,
        val pendingUpload: Boolean,
        val dropped: Boolean,
        val interruptedBy: MeetingFailure? = null,
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
 * Everything the live meeting screen reads off a recording in progress.
 *
 * [MeetingSession] is the only implementation that touches a microphone; the
 * screenshot demo (`screenshot/DemoMeetingSession`) supplies the same five flows
 * from scripted fixtures, which is what lets the live screen be captured on an
 * emulator with no audio input and no network.
 */
interface LiveMeeting {
    val state: StateFlow<MeetingState>
    val segments: StateFlow<List<TranscriptSegment>>
    val issue: StateFlow<TranscriptionIssue?>

    /** Input level, 0..1 — drives the level meter. */
    val level: StateFlow<Float>
    val elapsedMs: StateFlow<Long>

    /**
     * True while the platform is handing us silence because another app took
     * the microphone.
     *
     * From Android 10 this is the *only* signal there is: `AudioRecord.read`
     * keeps returning success and keeps returning zeroes, so without watching
     * for it a meeting can record forty minutes of nothing and report no
     * problem at all. The UI turns it into a banner; the recording deliberately
     * keeps running, because the takeover usually ends by itself and what comes
     * after it is still worth having.
     */
    val micSilenced: StateFlow<Boolean>
}

private const val TAG = "MeetingSession"

/**
 * The scope a session runs on when the caller does not supply one.
 *
 * The [CoroutineExceptionHandler] is the point of it. A [SupervisorJob] only
 * stops the session's jobs from cancelling *each other*; an exception none of
 * them catches still reaches the thread's default handler, which on Android
 * means the process dies. The ticker, the relay event collector and the
 * reconnect job all run here, so without this a stray throw in any of them
 * would crash the app in the middle of a recording instead of, at worst,
 * losing a live transcript.
 */
private fun defaultSessionScope(): CoroutineScope = CoroutineScope(
    SupervisorJob() + Dispatchers.IO +
        CoroutineExceptionHandler { _, t -> Log.e(TAG, "unhandled in session scope", t) },
)

/**
 * One live meeting: microphone → Ogg/Opus file **and** microphone → STT relay,
 * from the same chunk stream, plus the upload that follows. See [CapturePipeline]
 * for the fan-out and for why only one of those two branches is allowed to fail
 * loudly.
 *
 * Hosted by [MeetingService] so the capture survives the screen going away; the
 * UI observes the flows and never touches the pipeline directly beyond [stop].
 *
 * The session owns its own coroutine scope: it must outlive both the composable
 * that shows it and the service that started it (the upload tail runs while the
 * service is already stopping itself).
 *
 * ## Saving is the default; deleting takes a decision
 *
 * There are four ways out — [stop], [stopInterrupted], [discard], [dispose] —
 * and only [discard] removes the audio. Every other ending closes the container
 * and hands the file to the upload queue, including the endings that are
 * failures: a microphone taken away forty minutes in has ended the *recording*,
 * not the *recorded*. [CaptureEnding] holds that table.
 */
class MeetingSession(
    private val context: Context,
    private val auth: AuthManager,
    private val uploader: MeetingUploader,
    /** Display title for the finished recording; built by the UI layer. */
    private val title: String,
    private val scope: CoroutineScope = defaultSessionScope(),
) : LiveMeeting {
    private val mic = MicCapture(context)

    private val _state = MutableStateFlow<MeetingState>(MeetingState.Idle)
    override val state: StateFlow<MeetingState> = _state.asStateFlow()

    private val _segments = MutableStateFlow<List<TranscriptSegment>>(emptyList())
    override val segments: StateFlow<List<TranscriptSegment>> = _segments.asStateFlow()

    private val _issue = MutableStateFlow<TranscriptionIssue?>(null)
    override val issue: StateFlow<TranscriptionIssue?> = _issue.asStateFlow()

    private val _elapsedMs = MutableStateFlow(0L)
    override val elapsedMs: StateFlow<Long> = _elapsedMs.asStateFlow()

    private val _micSilenced = MutableStateFlow(false)
    override val micSilenced: StateFlow<Boolean> = _micSilenced.asStateFlow()

    /** RMS of the last microphone chunk, 0..1 — drives the level meter. */
    override val level: StateFlow<Float> get() = mic.level

    /** Wall-clock start, carried into the recording's `createdAt`. */
    val startedAtMs: Long = System.currentTimeMillis()

    /** `@Volatile` because the microphone coroutine reads it for every chunk
     *  while a reconnect may be swapping it on another thread. */
    @Volatile private var relay: SttRelayClient? = null
    private var encoder: OggOpusEncoder? = null
    private var captureJob: Job? = null
    private var eventsJob: Job? = null
    private var tickerJob: Job? = null
    private var reconnectJob: Job? = null
    private var micMonitor: AudioManager.AudioRecordingCallback? = null

    /** Bumped for every relay connection this recording makes; each leg
     *  numbers its own segments from zero, so without a per-leg id prefix a
     *  reconnect would overwrite the opening of the meeting. */
    private var relayLeg = 0

    /** Consecutive-failure budget for redialling the relay. */
    private val reconnect = ReconnectPolicy()

    /** `elapsedRealtime` at the first microphone chunk — the offset a
     *  reconnected leg needs to place its timestamps after the audio that
     *  came before it. */
    private var captureStartedAt = 0L

    @Volatile private var finishRequested = false

    /**
     * Guards the save: the user tapping Stop and the capture loop failing can
     * arrive at the same instant, and the encoder may only be finished once.
     * Whichever gets here first owns the outcome.
     */
    private val saveMutex = Mutex()
    private var saved = false

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

    /**
     * The capture, with a floor under it. [capture] already maps the failures it
     * knows about; this catches everything else — a full disk, a device quirk, a
     * bug — and saves the recording rather than letting it reach the thread's
     * default handler.
     *
     * This catch-all used to be the most expensive line in the file: it deleted
     * the audio before reporting the failure, so any exception nobody had
     * thought of cost the user their meeting.
     */
    private suspend fun runCapture() {
        try {
            capture()
        } catch (e: CancellationException) {
            throw e // ordinary teardown (discard/dispose), not a failure
        } catch (t: Throwable) {
            Log.e(TAG, "meeting capture failed", t)
            interruptFromCapture(MeetingFailure.UNKNOWN, t.message)
        }
    }

    private suspend fun capture() {
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

        val client = newRelay(token, leg = 0, timeOffsetMs = 0)
        relay = client
        // Collect before connecting: open() does not wait for the handshake, and
        // a rejected one arrives as an event rather than an exception.
        eventsJob = scope.launch { client.events.collect(::onRelayEvent) }
        // `open()` rather than `connect()`: the socket does not have to be up
        // before the microphone does. Audio queued before the upgrade lands is
        // held and written in order, so the recording begins when the user
        // asked for it instead of one network round trip later.
        client.open()

        // stop() can win the race against everything above: the user tapped
        // Stop while we were still connecting. It has already cancelled the
        // (not yet existing) ticker and told the microphone to stay stopped, so
        // there is nothing left to start here — and it is waiting on this very
        // job before finishing the encoder we just published, which is what
        // turns the race into an ordinary dropped recording.
        if (finishRequested) return

        _state.value = MeetingState.Recording
        captureStartedAt = SystemClock.elapsedRealtime()
        startTicker()
        startMicMonitor()

        val pipeline = CapturePipeline(
            audio = { chunk -> encoder.append(chunk) },
            // The field, not the local: a reconnect swaps the client, and a
            // captured one would keep feeding a socket nobody reads.
            relay = { this.relay?.let { client -> RelaySink { chunk -> client.enqueuePcm(chunk) } } },
        )

        try {
            mic.start().collect(pipeline::accept)
        } catch (e: MicCaptureException) {
            interruptFromCapture(micFailure(e), e.message)
        } catch (e: OpusEncodeException) {
            interruptFromCapture(MeetingFailure.ENCODER_UNAVAILABLE, e.message)
        }
    }

    private fun onRelayEvent(event: SttRelayEvent) {
        when (event) {
            is SttRelayEvent.Segment -> upsert(event.segment)
            // Out of quota is the one failure reconnecting cannot fix: the next
            // handshake is refused the same way, so this stays a banner.
            is SttRelayEvent.QuotaExceeded -> _issue.value = TranscriptionIssue.QUOTA_EXCEEDED
            is SttRelayEvent.Error -> {
                _issue.value = TranscriptionIssue.RELAY_ERROR
                scheduleReconnect()
            }
            // A close after finalize is the normal end of the stream.
            is SttRelayEvent.Closed ->
                if (!finishRequested) {
                    _issue.value = TranscriptionIssue.RELAY_CLOSED
                    scheduleReconnect()
                }
        }
    }

    private fun newRelay(token: String, leg: Int, timeOffsetMs: Long) =
        SttRelayClient(
            SttRelayClient.Options(
                bearerToken = token,
                feature = SttRelayClient.Feature.MEETING,
                idPrefix = if (leg == 0) null else "${SttRelayClient.SOURCE}@$leg",
                timeOffsetMs = timeOffsetMs,
            )
        )

    /**
     * Reopen the relay while the microphone keeps running.
     *
     * Nothing about the audio file depends on the socket, so a dropped relay
     * costs live transcript, not the recording. That is why this retries
     * quietly in the background instead of failing the meeting.
     *
     * It is NOT because the cloud transcribes the uploaded audio for us — an
     * earlier version of this comment said so and it was never true. Uploading a
     * recording stores it; nothing on the server side transcribes it again. What
     * repairs a transcript this loop failed to save is the client's own backfill
     * pass (`upload/TranscriptBackfiller`), which measures what came back
     * against the audio on disk and re-runs the whole file when it falls short.
     * Anything here that quietly gives up on the live transcript is therefore
     * spending that pass's budget, not deferring to a server that would have
     * done the work anyway.
     *
     * The budget is [ReconnectPolicy]'s, which counts *consecutive* failures:
     * see there for why a meeting that reconnects successfully must get its
     * retries back.
     */
    private fun scheduleReconnect() {
        if (finishRequested || reconnectJob != null) return
        if (_state.value !is MeetingState.Recording) return
        val backoff = reconnect.nextDelayMs()
        if (backoff == null) {
            Log.w(TAG, "relay reconnect budget spent; the live transcript stops here")
            return
        }
        reconnectJob = scope.launch {
            delay(backoff)
            reconnectJob = null
            if (finishRequested || _state.value !is MeetingState.Recording) return@launch
            val token = auth.currentToken() ?: return@launch

            relayLeg += 1
            val offset = SystemClock.elapsedRealtime() - captureStartedAt
            val next = newRelay(token, relayLeg, offset)
            eventsJob?.cancel()
            runCatching { relay?.cancel() }
            relay = next
            eventsJob = scope.launch { next.events.collect(::onRelayEvent) }
            next.open()

            // Only a handshake that actually completed refills the budget.
            // `awaitOpen` resolves either way — a rejected upgrade arrives as an
            // event, not an exception — so `isTerminated` is what tells an open
            // socket from a refused one. The wait is bounded because a socket
            // that never resolves at all would otherwise keep this coroutine
            // alive for the rest of the meeting, and *that* case is not a
            // success either: a leg nobody ever answered has proved nothing.
            val resolved =
                withTimeoutOrNull(HANDSHAKE_TIMEOUT_MS) { next.awaitOpen(); true } ?: false
            if (resolved && !next.isTerminated) {
                reconnect.recordSuccess()
                _issue.value = null
            }
        }
    }

    /**
     * Watch for the platform silencing our microphone. See [LiveMeeting.micSilenced]
     * — on Android 10 and up an app only ever sees its own recordings here, so
     * "any silenced configuration" means ours.
     */
    private fun startMicMonitor() {
        if (finishRequested) return
        val audio = context.getSystemService(AudioManager::class.java) ?: return
        val callback = object : AudioManager.AudioRecordingCallback() {
            override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
                _micSilenced.value = configs.any { it.isClientSilenced }
            }
        }
        // A Handler is required: this runs on Dispatchers.IO, which has no Looper.
        audio.registerAudioRecordingCallback(callback, Handler(Looper.getMainLooper()))
        micMonitor = callback
        // Same race as the ticker: a stop() that ran between the guard above and
        // this line found `micMonitor` still null and had nothing to
        // unregister, so unregister it here instead of leaking the callback.
        if (finishRequested) stopMicMonitor()
    }

    private fun stopMicMonitor() {
        val callback = micMonitor ?: return
        micMonitor = null
        _micSilenced.value = false
        context.getSystemService(AudioManager::class.java)
            ?.unregisterAudioRecordingCallback(callback)
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
        if (finishRequested) return
        val startedAt = captureStartedAt
        val job = scope.launch {
            while (true) {
                _elapsedMs.value = SystemClock.elapsedRealtime() - startedAt
                delay(TICK_MS)
            }
        }
        tickerJob = job
        // stop() cancels `tickerJob`; if it read it while it was still null we
        // have just started a loop nobody will ever stop. Cheaper to re-check
        // than to give the session a lock.
        if (finishRequested) job.cancel()
    }

    /**
     * Stop recording, finish the transcript, then save and upload.
     *
     * Runs to completion in the caller's coroutine (the application scope — see
     * [MeetingService]), so the state flow keeps reporting progress even after
     * the service has stopped itself.
     */
    suspend fun stop() {
        if (!beginFinishing()) return
        quiesce()
        withTimeoutOrNull(CAPTURE_JOIN_TIMEOUT_MS) { captureJob?.join() }
        closeRelay()
        save(interruptedBy = null, detail = null)
    }

    /**
     * Save and stop because something *else* ended the recording.
     *
     * Same path as [stop] in every respect that touches the file — the container
     * is closed, the transcript is finalised, the recording goes to the upload
     * queue — and different only in what the terminal state says afterwards.
     * That sameness is the fix: the microphone being taken, the encoder dying or
     * the foreground service being destroyed used to route to a teardown that
     * deleted the .ogg, so an interruption at minute forty cost all forty.
     *
     * Mirrors iOS, where losing the microphone sets a flag and takes the
     * ordinary stop path (`MeetingRecorder.handle(_:)`).
     *
     * @param reason what ended it, for the log and for the UI when there turns
     *   out to be nothing worth saving.
     */
    suspend fun stopInterrupted(reason: MeetingFailure, detail: String? = null) {
        if (!beginFinishing()) return
        Log.w(TAG, "meeting interrupted ($reason): $detail — saving what was recorded")
        quiesce()
        withTimeoutOrNull(CAPTURE_JOIN_TIMEOUT_MS) { captureJob?.join() }
        closeRelay()
        save(interruptedBy = reason, detail = detail)
    }

    /**
     * [stopInterrupted] for a failure raised *by the capture coroutine itself*.
     *
     * Identical except that it must not wait for the capture job: it is running
     * on it, and a job cannot join itself.
     */
    private suspend fun interruptFromCapture(reason: MeetingFailure, detail: String?) {
        if (!beginFinishing()) return
        Log.w(TAG, "capture ended early ($reason): $detail — saving what was recorded")
        quiesce()
        closeRelay()
        save(interruptedBy = reason, detail = detail)
    }

    /**
     * Claim the wind-down. False when there is nothing live to wind down, either
     * because the recording never started or because somebody else got here
     * first.
     */
    private fun beginFinishing(): Boolean {
        while (true) {
            val current = _state.value
            if (current !is MeetingState.Recording && current !is MeetingState.Connecting) {
                return false
            }
            // Compare-and-set rather than a plain write: the user tapping Stop
            // and the capture loop throwing are genuinely concurrent, and
            // exactly one of them may own the wind-down.
            if (_state.compareAndSet(current, MeetingState.Finishing)) {
                finishRequested = true
                return true
            }
        }
    }

    /**
     * Everything that is not the audio file: the ticker, the reconnects, the
     * silenced-mic monitor and the microphone itself. Deliberately touches
     * neither the encoder nor the capture job — releasing the microphone is not
     * the same act as throwing the recording away. See [CaptureEnding].
     */
    private fun quiesce() {
        tickerJob?.cancel()
        reconnectJob?.cancel()
        reconnectJob = null
        runCatching { stopMicMonitor() }
        runCatching { mic.stop() }
    }

    /** Finalize the transcript and let the relay flush its tail, then hang up. */
    private suspend fun closeRelay() {
        relay?.let { client ->
            runCatching { client.finish() }
            // The relay keeps the socket open to flush the last utterance; the
            // events flow completes when it closes. Don't wait forever for it.
            withTimeoutOrNull(TAIL_TIMEOUT_MS) { eventsJob?.join() }
            client.cancel()
        }
        eventsJob?.cancel()
    }

    /**
     * Close the container, hand the file to the upload queue, publish the
     * outcome. Runs at most once per session.
     */
    private suspend fun save(interruptedBy: MeetingFailure?, detail: String?) =
        saveMutex.withLock {
            if (saved) return@withLock
            saved = true

            // stop() can win the race against capture() reaching the encoder, so
            // there may be nothing to finish.
            val encoder = this.encoder
            val audio = encoder?.let { withContext(Dispatchers.IO) { finishEncoder(it) } }
            if (encoder == null || audio == null) {
                _state.value = MeetingState.Failed(
                    interruptedBy ?: MeetingFailure.ENCODER_UNAVAILABLE,
                    detail,
                )
                return@withLock
            }

            _state.value = MeetingState.Uploading
            val id = try {
                uploader.enqueue(
                    EnqueueRequest(
                        audio = audio,
                        title = title,
                        durationMs = encoder.durationMs.toDouble(),
                        segments = finalSegments(),
                        startedAtMs = startedAtMs,
                        source = RecordingSource.LIVE,
                    )
                )
            } catch (e: Throwable) {
                _state.value = MeetingState.Failed(MeetingFailure.UPLOAD_FAILED, e.message)
                return@withLock
            }

            val result = if (id == null) null else runCatching { uploader.drain() }.getOrNull()
            _state.value = terminalStateFor(
                recordingId = id,
                pendingUpload = result == null || result.remaining > 0,
                interruptedBy = interruptedBy,
                detail = detail,
            )
        }

    /**
     * Close the Ogg container, and keep the bytes even when closing fails.
     *
     * Ogg is a streaming container: the pages already on disk decode on their
     * own, so a file whose muxer could not be stopped is a recording that ends a
     * fraction early, not a write-off. Since the likeliest reason `finish()`
     * throws is the disk filling up mid-meeting — precisely when the user has
     * the most to lose — "no clean close" must not mean "no recording".
     * [OggOpusEncoder.finish] deletes only a file it wrote nothing into.
     *
     * @return the file to upload, or null when there is genuinely nothing there.
     */
    private fun finishEncoder(encoder: OggOpusEncoder): File? = try {
        encoder.finish()
    } catch (e: CancellationException) {
        throw e
    } catch (t: Throwable) {
        Log.e(TAG, "could not finalise ${encoder.file.name}; keeping what is on disk", t)
        encoder.file.takeIf { it.isFile && it.length() > 0L }
    }

    /**
     * Throw the recording away: stop the microphone, drop the relay without
     * draining it, and delete the audio.
     *
     * The only path in the session that deletes anything, and it exists so that
     * every *other* path can safely not. Mirrors iOS `MeetingRecorder.discard()`.
     */
    fun discard() {
        // Through the same claim as every other ending, so it cannot overwrite a
        // recording that has already been saved.
        if (!beginFinishing()) return
        release(CaptureEnding.DISCARDED)
        byId.clear()
        _segments.value = emptyList()
        _issue.value = null
        _state.value = MeetingState.Finished(null, pendingUpload = false, dropped = true)
    }

    /**
     * Release everything this session still holds, without touching the audio.
     *
     * Called once the UI has acknowledged a terminal state, by which point the
     * recording is either in the upload queue or was never worth keeping — so
     * there is nothing here to decide and nothing to delete.
     */
    fun dispose() {
        release(CaptureEnding.RELEASED)
        scope.coroutineContext[Job]?.cancel()
    }

    /**
     * Wind the machinery down. [ending] decides the one thing that cannot be
     * undone; see [CaptureEnding] for the table and for why it is so lopsided.
     */
    private fun release(ending: CaptureEnding) {
        quiesce()
        eventsJob?.cancel()
        runCatching { relay?.cancel() }
        if (ending.deletesAudio) {
            // Before the encoder: the capture loop is the only thing that calls
            // `encoder.append`, and a chunk that arrives after `encoder.cancel()`
            // throws. `cancel()` does not wait, so the ordering is a strong hint
            // rather than a guarantee — the catch-all in [runCapture] is what
            // makes the remaining window harmless.
            captureJob?.cancel()
            runCatching { encoder?.cancel() }
        }
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

        /** Ceiling on waiting for a reconnect's handshake to resolve; the
         *  client's own connect timeout is shorter, so this is a backstop. */
        const val HANDSHAKE_TIMEOUT_MS = 20_000L
    }
}
