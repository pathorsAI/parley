package com.pathors.parley.voicetyping

import android.content.Context
import android.os.SystemClock
import com.pathors.parley.BuildConfig
import com.pathors.parley.audio.MicCapture
import com.pathors.parley.audio.MicCaptureException
import com.pathors.parley.auth.AuthManager
import com.pathors.parley.kit.SttRelayClient
import com.pathors.parley.kit.SttRelayEvent
import com.pathors.parley.kit.TranscriptSegment
import com.pathors.parley.screenshot.DemoMode
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** Where one dictation is in its lifecycle. The keyboard's state line reads this. */
sealed interface VoiceTypingState {
    /** Nothing running. */
    data object Idle : VoiceTypingState

    /** Opening the relay socket. */
    data object Connecting : VoiceTypingState

    /** Microphone is live and audio is streaming. */
    data object Listening : VoiceTypingState

    /** Input drained; waiting for the relay to flush the last utterance. */
    data object Finishing : VoiceTypingState

    /**
     * Ended cleanly. [reachedLimit] when [VoiceTypingSession.MAX_SESSION_SECONDS]
     * ended it rather than the user — the keyboard says so, because a session
     * that stopped on its own otherwise looks like a bug.
     */
    data class Done(val reachedLimit: Boolean) : VoiceTypingState

    /** The dictation could not run (or died mid-stream). */
    data class Failed(val reason: VoiceTypingFailure) : VoiceTypingState
}

/**
 * Why a dictation failed. The keyboard owns the (bilingual) copy for each case,
 * and the first two are the ones it can actually route out of — see
 * [VoiceTypingSetup].
 */
enum class VoiceTypingFailure {
    /** No cloud session token: the relay has nothing to authenticate with. */
    NOT_SIGNED_IN,

    /** `RECORD_AUDIO` is not granted, and an IME cannot ask for it itself. */
    MIC_PERMISSION,

    /** The mic exists but would not open — a call, or another app holding it. */
    MIC_UNAVAILABLE,

    /** The relay handshake failed (offline, expired session, rejected). */
    CONNECTION,

    /** The account's hosted transcription quota is used up. */
    QUOTA_EXCEEDED,

    /** The stream died for some other reason. */
    RELAY_ERROR,
}

/**
 * One dictation: microphone → hosted STT relay → growing text. No recording, no
 * upload, no diarization UI — the meeting stack stripped down to what typing
 * needs.
 *
 * This is the Android sibling of desktop `src-tauri/src/voice_typing.rs` and iOS
 * `DictationCoordinator`, and it is deliberately the same shape as
 * [com.pathors.parley.meeting.MeetingSession] minus the encoder and the
 * uploader:
 *
 * ```
 * MicCapture ──ByteArray(3200)──▶ SttRelayClient.sendPcm ──▶ segments ──▶ text
 * ```
 *
 * The one thing it does *not* do is touch an editor. It publishes [text] and
 * [state]; [ParleyInputMethodService] is what turns those into
 * `InputConnection` calls through [TranscriptCommitter]. That split is what makes
 * the commit rule testable without an IME.
 *
 * One session per instance — build a new one per dictation, like
 * [SttRelayClient] itself.
 */
class VoiceTypingSession(
    context: Context,
    private val auth: AuthManager,
    /**
     * Where the pipeline runs. Owned by the caller (the IME service's scope) so
     * a session cannot outlive the keyboard that started it.
     */
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    private val relayFactory: (String) -> SttRelayClient = { token ->
        SttRelayClient(
            SttRelayClient.Options(
                bearerToken = token,
                // The cloud whitelists exactly `meeting | voice_typing | realtime`;
                // anything else is billed unattributed. This is the one flow that
                // uses VOICE_TYPING on Android.
                feature = SttRelayClient.Feature.VOICE_TYPING,
            )
        )
    },
) {
    private val appContext = context.applicationContext
    private val mic = MicCapture(appContext)

    private val _state = MutableStateFlow<VoiceTypingState>(VoiceTypingState.Idle)
    val state: StateFlow<VoiceTypingState> = _state.asStateFlow()

    private val _text = MutableStateFlow(DictationText())
    val text: StateFlow<DictationText> = _text.asStateFlow()

    private val _level = MutableStateFlow(0f)

    /** RMS of the last microphone chunk, 0..1 — drives the mic button's ring. */
    val level: StateFlow<Float> = _level.asStateFlow()

    private val _elapsedMs = MutableStateFlow(0L)

    /** How long the mic has been open, for the countdown near the cap. */
    val elapsedMs: StateFlow<Long> = _elapsedMs.asStateFlow()

    private var relay: SttRelayClient? = null
    private var captureJob: Job? = null
    private var eventsJob: Job? = null
    private var capJob: Job? = null
    private var tickerJob: Job? = null

    @Volatile private var finishRequested = false

    @Volatile private var hitLimit = false

    /** Segments → plain text. Pure, and unit-tested against real relay frames. */
    private val assembler = DictationTextAssembler()

    /** Begin. Safe to call twice; the second call is a no-op. */
    fun start() {
        if (_state.value !is VoiceTypingState.Idle) return
        _state.value = VoiceTypingState.Connecting
        captureJob = scope.launch { run() }
    }

    private suspend fun run() {
        // ScreenshotDemo: play a scripted transcript instead of opening a
        // microphone, so the keyboard can be exercised (and captured) with no
        // account, no network and — the reason this exists — no microphone at
        // all, which is every emulator. Debug builds only, and only while a
        // `parley://demo/…` link has turned demo mode on. Faking stops at the
        // source: the assembler, the committer and the InputConnection writes
        // below it are the production path. Mirrors iOS
        // `DictationCoordinator.streamDemoTranscript`.
        if (BuildConfig.DEBUG && DemoMode.isActive) {
            runDemo()
            return
        }

        val token = auth.currentToken()
        if (token == null) {
            _state.value = VoiceTypingState.Failed(VoiceTypingFailure.NOT_SIGNED_IN)
            return
        }
        // Checked here as well as by the keyboard before it offers the mic: the
        // grant can be revoked between the two, and MicCapture's own
        // PermissionDenied would otherwise be reported as a generic mic failure.
        if (!VoiceTypingSetup.hasMicPermission(appContext)) {
            _state.value = VoiceTypingState.Failed(VoiceTypingFailure.MIC_PERMISSION)
            return
        }

        val client = relayFactory(token)
        relay = client
        // Collect before connecting: connect() does not wait for the stream, and
        // a rejected handshake arrives as an event rather than an exception.
        eventsJob = scope.launch { client.events.collect(::onRelayEvent) }
        try {
            client.connect()
        } catch (_: IllegalArgumentException) {
            abandon()
            _state.value = VoiceTypingState.Failed(VoiceTypingFailure.CONNECTION)
            return
        }
        if (_state.value is VoiceTypingState.Failed) return

        _state.value = VoiceTypingState.Listening
        startTicker()
        armCap()

        try {
            mic.start().collect { chunk ->
                client.sendPcm(chunk)
                _level.value = mic.level.value
            }
        } catch (e: MicCaptureException) {
            abandon()
            _state.value = VoiceTypingState.Failed(micFailure(e))
        }
    }

    /**
     * The scripted stand-in for mic + relay. It builds the same segments the
     * relay would — one growing `mix-0` run plus a `mix-tail` that is rewritten
     * and then absorbed — and pushes them through the real [assembler], so the
     * partial/final behaviour on screen is the real behaviour.
     */
    private suspend fun runDemo() {
        _state.value = VoiceTypingState.Listening
        startTicker()
        armCap()
        var settled = ""
        var tail = ""
        for (piece in DemoMode.dictationScript()) {
            delay(DEMO_PIECE_MS)
            if (_state.value !is VoiceTypingState.Listening) return
            tail += piece
            // A tail long enough to be a phrase settles into the committed run,
            // which is roughly the cadence a real endpoint detector produces.
            if (tail.length >= DEMO_SETTLE_CHARS) {
                settled += tail
                tail = ""
            }
            emitDemo(settled, tail)
            _level.value = DEMO_LEVELS[(settled.length + tail.length) % DEMO_LEVELS.size]
        }
    }

    private fun emitDemo(settled: String, tail: String) {
        if (settled.isNotEmpty()) {
            _text.value = assembler.accept(
                TranscriptSegment(
                    id = "${SttRelayClient.SOURCE}-0",
                    source = SttRelayClient.SOURCE,
                    speaker = 1,
                    text = settled,
                    isFinal = true,
                    startMs = 0,
                    endMs = settled.length * 60L,
                )
            )
        }
        _text.value = assembler.accept(
            TranscriptSegment(
                id = "${SttRelayClient.SOURCE}-tail",
                source = SttRelayClient.SOURCE,
                speaker = 1,
                text = tail,
                isFinal = false,
                startMs = settled.length * 60L,
                endMs = settled.length * 60L,
            )
        )
    }

    /**
     * The hosted single-dictation cap, mirroring the desktop's
     * `HOSTED_VOICE_TYPING_MAX_SECONDS` (`src/lib/limits.ts`) exactly. A session
     * the user forgets to stop must not quietly burn the account's whole
     * transcription quota — and on Android that risk is real in a way it is not
     * on the desktop, because the keyboard can be dismissed while the mic is
     * still open.
     *
     * iOS uses a tighter 120 s ([DictationCoordinator]) because its keyboard
     * extension records through the host app under a hard jetsam limit; an
     * Android IME runs in the app's own process, so it can afford the desktop
     * number.
     */
    private fun armCap() {
        capJob = scope.launch {
            delay(MAX_SESSION_SECONDS * 1_000L)
            if (_state.value is VoiceTypingState.Listening) {
                hitLimit = true
                stop()
            }
        }
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

    private fun onRelayEvent(event: SttRelayEvent) {
        when (event) {
            is SttRelayEvent.Segment -> _text.value = assembler.accept(event.segment)
            // A close after finalize is the normal end of the stream; a close
            // before it means the relay hung up on us mid-dictation.
            is SttRelayEvent.Closed ->
                if (finishRequested) foldTail() else fail(VoiceTypingFailure.RELAY_ERROR)

            is SttRelayEvent.QuotaExceeded -> fail(VoiceTypingFailure.QUOTA_EXCEEDED)
            is SttRelayEvent.Error ->
                fail(
                    // A rejected handshake is the same user-visible problem as
                    // being offline: nothing was transcribed and retrying is the
                    // advice. Anything mid-stream is a relay error.
                    if (_state.value is VoiceTypingState.Connecting) {
                        VoiceTypingFailure.CONNECTION
                    } else {
                        VoiceTypingFailure.RELAY_ERROR
                    }
                )
        }
    }

    /**
     * Stop the mic, let the relay flush the last utterance, then fold the tail
     * into the settled text so nothing said just before the stop is dropped —
     * `DictationCoordinator.finishUp`'s contract, and what
     * [TranscriptCommitter.finish] leans on.
     *
     * Suspends until the transcript is final. Idempotent.
     */
    suspend fun stop() {
        val current = _state.value
        if (current !is VoiceTypingState.Listening && current !is VoiceTypingState.Connecting) {
            return
        }
        finishRequested = true
        _state.value = VoiceTypingState.Finishing
        capJob?.cancel()
        tickerJob?.cancel()

        mic.stop()
        withTimeoutOrNull(CAPTURE_JOIN_TIMEOUT_MS) { captureJob?.join() }

        relay?.let { client ->
            runCatching { client.finish() }
            // The relay holds the socket open to flush the tail; the events flow
            // completes when it closes. Don't wait forever for a server that
            // never does.
            withTimeoutOrNull(TAIL_TIMEOUT_MS) { eventsJob?.join() }
            client.cancel()
        }
        eventsJob?.cancel()
        foldTail()
    }

    /** Tentative tail becomes settled text; the session is over. */
    private fun foldTail() {
        _text.value = assembler.foldTail()
        if (_state.value !is VoiceTypingState.Failed) {
            _state.value = VoiceTypingState.Done(reachedLimit = hitLimit)
        }
    }

    private fun fail(reason: VoiceTypingFailure) {
        if (_state.value is VoiceTypingState.Done || _state.value is VoiceTypingState.Failed) return
        abandon()
        _state.value = VoiceTypingState.Failed(reason)
    }

    /** Tear everything down without waiting for a flush. Idempotent. */
    fun abandon() {
        capJob?.cancel()
        tickerJob?.cancel()
        runCatching { mic.stop() }
        runCatching { relay?.cancel() }
        eventsJob?.cancel()
    }

    /**
     * Release everything this session holds, including its coroutine scope. The
     * session is spent afterwards. Mirrors `MeetingSession.dispose`.
     */
    fun dispose() {
        abandon()
        scope.coroutineContext[Job]?.cancel()
    }

    private fun micFailure(e: MicCaptureException): VoiceTypingFailure = when (e) {
        is MicCaptureException.PermissionDenied -> VoiceTypingFailure.MIC_PERMISSION
        is MicCaptureException.DeviceUnavailable,
        is MicCaptureException.UnsupportedConfiguration,
        is MicCaptureException.ReadFailed,
        -> VoiceTypingFailure.MIC_UNAVAILABLE
    }

    companion object {
        /**
         * Cap on one dictation, in seconds. The desktop's
         * `HOSTED_VOICE_TYPING_MAX_SECONDS` (`src/lib/limits.ts`) — keep the two
         * in step.
         */
        const val MAX_SESSION_SECONDS = 600L

        private const val TICK_MS = 250L
        private const val TAIL_TIMEOUT_MS = 8_000L
        private const val CAPTURE_JOIN_TIMEOUT_MS = 5_000L

        /** ScreenshotDemo playback: roughly speaking pace. */
        private const val DEMO_PIECE_MS = 420L
        private const val DEMO_SETTLE_CHARS = 12
        private val DEMO_LEVELS = floatArrayOf(0.10f, 0.28f, 0.17f, 0.36f, 0.22f)
    }
}
