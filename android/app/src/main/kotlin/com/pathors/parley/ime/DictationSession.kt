package com.pathors.parley.ime

import android.content.Context
import android.os.SystemClock
import android.util.Log
import com.pathors.parley.audio.MicCapture
import com.pathors.parley.audio.MicCaptureException
import com.pathors.parley.auth.AuthManager
import com.pathors.parley.cloud.CloudClient
import com.pathors.parley.kit.SttRelayClient
import com.pathors.parley.kit.SttRelayEvent
import com.pathors.parley.kit.TranscriptPolisher
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** Where one dictation is in its life. The keyboard renders straight off this. */
sealed interface DictationState {

    /** Constructed, microphone not open. */
    data object Idle : DictationState

    /** Opening the relay socket. The microphone is already live. */
    data object Connecting : DictationState

    /** Listening. [DictationSession.text] is growing. */
    data object Listening : DictationState

    /**
     * The microphone is closed and the words are being settled: the relay is
     * flushing its last utterance, and then the cleanup pass gets its six
     * seconds. The keyboard keeps showing the text it already has.
     */
    data object Finishing : DictationState

    /**
     * The text is final. The input method commits [text] and then calls
     * [DictationService.clear].
     *
     * [polished] only says which text this is, for the keyboard's own label; the
     * raw and the polished outcome are both perfectly good results.
     *
     * [reachedLimit] is true when the ten-minute cap stopped the microphone
     * rather than the user — delivered exactly as a stop would have been, polish
     * included, with a note the keyboard shows afterwards (iOS
     * `DictationEnding.limitReached`). Only a note, never a failure.
     */
    data class Done(
        val text: String,
        val polished: Boolean,
        val reachedLimit: Boolean = false,
    ) : DictationState

    /**
     * Dictation ended badly. [partialText] is whatever had been heard before it
     * did — the input method commits it rather than snatching it back, because
     * the user did say those words and they are already on screen as composing
     * text. Blank when nothing was heard.
     */
    data class Failed(
        val reason: DictationFailure,
        val partialText: String,
        val detail: String? = null,
    ) : DictationState

    /** The user discarded it. Nothing is committed; the composing text is dropped. */
    data object Cancelled : DictationState
}

/** Why a dictation ended badly. The keyboard owns the (bilingual) copy for each. */
enum class DictationFailure {
    NOT_SIGNED_IN,
    MIC_PERMISSION,
    MIC_UNAVAILABLE,
    QUOTA_EXCEEDED,
    RELAY_ERROR,
    UNKNOWN,
}

/**
 * One dictation: microphone → STT relay → the text the keyboard commits.
 *
 * The Android counterpart of iOS `DictationCoordinator`, and about a fifth of its
 * size. Everything that is missing was iOS sandbox tax rather than dictation:
 * there is no App Group mailbox, no Darwin notification, no heartbeat, no
 * host-app hand-off and no private-API hop back to the foreground app, because
 * an Android input method runs **in the app's own process**, may open the
 * microphone itself, and never leaves the app the user is typing into.
 *
 * ## What it deliberately does not do
 *
 * - **No relay reconnect ladder.** `MeetingSession` redials because a meeting is
 *   an hour long and its audio file is the irreplaceable artefact. A dictation is
 *   one utterance under a ten-minute cap with no file behind it: if the socket
 *   dies, finishing with the words already heard is both simpler and what the
 *   user wants, and they can press the key again.
 * - **No audio file, no upload, no library entry.** Nothing is encoded and
 *   nothing is pushed to `POST /recordings/{id}`. The audio is streamed, the
 *   words are typed, and both are gone.
 * - **No high-water mark of inserted characters, no adoption window, no
 *   three-state downlink.** See [DictationTranscript]: Android's composing text
 *   is retractable, so the whole class of problem those solved does not arise.
 *
 * ## Who owns the microphone permission
 *
 * Nobody here. The session assumes `RECORD_AUDIO` is granted and a
 * `microphone`-typed foreground service is already running — [DictationService]
 * guarantees both before it constructs this — and reports
 * [DictationFailure.MIC_PERMISSION] if `MicCapture` disagrees. An input method
 * has no `Activity` and therefore cannot request a runtime permission at all;
 * that is [VoiceTypingSettingsActivity]'s job.
 */
class DictationSession(
    private val context: Context,
    private val auth: AuthManager,
    private val cloud: CloudClient,
    private val settings: VoiceTypingSettings,
    /**
     * The [DictationFieldGate] token of the field this dictation was started in.
     * The keyboard writes this session's words only while that field is still
     * the one attached.
     */
    val ownerToken: Long = DictationFieldGate.NO_OWNER,
) {

    private val _state = MutableStateFlow<DictationState>(DictationState.Idle)
    val state: StateFlow<DictationState> = _state.asStateFlow()

    /**
     * What the input connection should be showing as composing text. Empty until
     * the first words land.
     */
    private val _text = MutableStateFlow("")
    val text: StateFlow<String> = _text.asStateFlow()

    private val _elapsedMs = MutableStateFlow(0L)
    val elapsedMs: StateFlow<Long> = _elapsedMs.asStateFlow()

    private val mic = MicCapture(context)

    /** Input level, 0..1 — drives the key's halo. Straight through from the mic. */
    val level: StateFlow<Float> get() = mic.level

    /**
     * Not the caller's scope: the keyboard view is destroyed and recreated as the
     * user moves between fields, and a dictation must not die with a view. The
     * exception handler is the floor under the whole session — an unhandled throw
     * here would otherwise reach the thread's default handler and take the
     * *keyboard* down, which on Android means the user is left with no way to
     * type at all.
     */
    private val scope = CoroutineScope(
        SupervisorJob() + Dispatchers.Default +
            CoroutineExceptionHandler { _, t -> Log.e(TAG, "unhandled in dictation scope", t) },
    )

    /**
     * Mutated by the relay's event collector and read by [finishUp] and [fail],
     * which run on other `Dispatchers.Default` threads. [DictationTranscript] is a
     * plain `LinkedHashMap`, so every touch goes through [transcriptLock].
     */
    private val transcript = DictationTranscript()
    private val transcriptLock = Any()

    @Volatile private var relay: SttRelayClient? = null
    private var captureJob: Job? = null
    private var eventsJob: Job? = null
    private var tickerJob: Job? = null
    private var capJob: Job? = null

    /** Set by [requestStop] and [cancel], and never cleared. See [MicCapture]. */
    @Volatile private var stopRequested = false

    @Volatile private var cancelled = false

    /** Set when the cap, not the user, ended the dictation. See [startCap]. */
    @Volatile private var reachedLimit = false

    /**
     * True once [finishUp] has been entered. The microphone flow completing and
     * the ten-minute cap firing can land together, and the relay may only be
     * finalized once.
     */
    private val settling = AtomicBoolean(false)

    /**
     * True once a terminal state has been published. Whichever of the endings
     * gets here first owns the outcome — the same discipline
     * `MeetingSession.saveMutex` enforces, and for the same reason: a relay error
     * and the user's own stop routinely arrive in the same millisecond, and the
     * loser must not overwrite the winner's state.
     */
    private val terminal = AtomicBoolean(false)

    /** Begin. Safe to call twice; the second call is a no-op. */
    fun start() {
        if (_state.value !is DictationState.Idle) return
        _state.value = DictationState.Connecting
        captureJob = scope.launch { runCapture() }
    }

    /**
     * The user is done talking: close the microphone, let the relay flush its
     * tail, run the cleanup pass, and land on [DictationState.Done].
     *
     * Idempotent, and safe before [start] has got anywhere — `MicCapture.stop()`
     * counts even when it arrives before the flow is collected, so "stop while
     * still connecting" ends as an ordinary empty dictation rather than a leaked
     * microphone.
     */
    fun requestStop() {
        if (stopRequested) return
        stopRequested = true
        mic.stop()
    }

    /**
     * Throw the dictation away at the user's request: no text is committed and
     * the composing region is cleared.
     *
     * The action iOS had to build a whole second mailbox and a cancelled-state
     * downlink for. Here it is the microphone stopping and a state, because the
     * words on screen are composing text and composing text is retractable.
     * Deliberately does **not** drain the relay or spend a polish request on text
     * that is about to be discarded.
     */
    fun cancel() {
        if (cancelled) return
        cancelled = true
        stopRequested = true
        mic.stop()
        if (terminal.compareAndSet(false, true)) {
            _state.value = DictationState.Cancelled
        }
        teardown()
    }

    /**
     * End before the microphone was ever opened, as [reason]. For the service
     * when the platform refused the foreground start: without a
     * `microphone`-typed foreground service `AudioRecord` would only hand back
     * silence, so the honest outcome is a failure the keyboard can show.
     */
    fun refuse(reason: DictationFailure) {
        if (_state.value !is DictationState.Idle) return
        fail(reason, null)
    }

    /** Release everything. Called by [DictationService] once the state is read. */
    fun dispose() {
        cancelled = true
        stopRequested = true
        mic.stop()
        teardown()
        scope.cancel()
    }

    // ── the capture ──────────────────────────────────────────────────────────

    /**
     * The capture with a floor under it: [capture] maps the failures it knows
     * about, and this turns anything else into a [DictationState.Failed] that
     * keeps the words already heard.
     */
    private suspend fun runCapture() {
        try {
            capture()
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            Log.e(TAG, "dictation failed", t)
            fail(DictationFailure.UNKNOWN, t.message)
        }
    }

    private suspend fun capture() {
        val token = auth.currentToken()
        if (token == null) {
            fail(DictationFailure.NOT_SIGNED_IN, null)
            return
        }

        val client = SttRelayClient(
            SttRelayClient.Options(
                bearerToken = token,
                // The billing tag the relay meters this against, identical to the
                // one iOS `DictationCoordinator` sends and the one the desktop
                // sends. Nothing server-side needed changing for Android.
                feature = SttRelayClient.Feature.VOICE_TYPING,
                // Dictation is the one place the script matters: this is also
                // what turns on the relay's Simplified→Traditional rewrite, and
                // the polish pass then refuses anything that drifts back.
                languageHints = listOf("zh", "en"),
            ),
        )
        relay = client

        // Collect before connecting: open() does not wait for the handshake, and
        // a rejected one arrives as an event rather than an exception.
        eventsJob = scope.launch { client.events.collect(::onRelayEvent) }
        // open(), not connect(): audio queued before the upgrade lands is held
        // and written in order, so dictation starts when the key was tapped
        // rather than one network round trip later. On a key you hold for two
        // seconds that round trip is most of the interaction.
        client.open()

        if (stopRequested) {
            // The key was tapped twice faster than the socket opened.
            finishUp()
            return
        }

        _state.value = DictationState.Listening
        startTicker()
        startCap()

        try {
            mic.start().collect { chunk -> relay?.enqueuePcm(chunk) }
        } catch (e: MicCaptureException) {
            fail(micFailure(e), e.message)
            return
        }

        // The flow completed normally, which means `mic.stop()` was called — by
        // the user, by the cap, or by the service being taken down.
        if (!cancelled) finishUp()
    }

    private fun onRelayEvent(event: SttRelayEvent) {
        if (cancelled) return
        when (event) {
            is SttRelayEvent.Segment -> {
                _text.value = synchronized(transcriptLock) {
                    transcript.accept(event.segment)
                    transcript.live
                }
            }

            // Out of quota is terminal: the next handshake is refused the same
            // way, so there is nothing to retry into.
            is SttRelayEvent.QuotaExceeded -> {
                mic.stop()
                fail(DictationFailure.QUOTA_EXCEEDED, event.message)
            }

            is SttRelayEvent.Error -> {
                mic.stop()
                fail(DictationFailure.RELAY_ERROR, event.message)
            }

            // After a finalize this is the relay signing off, and `finishUp` is
            // already running. Any other time the socket dropped under us, and
            // we finish with what we have rather than redial — see the class doc.
            is SttRelayEvent.Closed -> if (!stopRequested) {
                mic.stop()
                fail(DictationFailure.RELAY_ERROR, event.reason)
            }
        }
    }

    /**
     * Settle the text: drain the relay, fold the tentative tail in, then polish.
     *
     * Guarded by [settling] because the microphone flow completing and the cap
     * firing can arrive together, and the finalize must only be sent once.
     */
    private suspend fun finishUp() {
        if (terminal.get()) return
        if (!settling.compareAndSet(false, true)) return
        _state.value = DictationState.Finishing
        tickerJob?.cancel()
        capJob?.cancel()

        // finish() sends the finalize frame and deliberately leaves the socket
        // open so the relay can stream the flushed tail back; closing now would
        // truncate the last utterance. Bounded, because a dead socket must not be
        // able to hold the keyboard hostage.
        //
        // Wait for the *collector*, not the socket. The relay's event channel is
        // unbounded and completes right after its terminal event, so the socket
        // reporting terminated says nothing about whether the final segment has
        // been read out of the channel yet; the collector finishing does.
        val client = relay
        if (client != null) {
            runCatching { client.finish() }
            withTimeoutOrNull(DRAIN_TIMEOUT_MS) { eventsJob?.join() }
        }

        // Fold after the drain, not before: the flushed tail is the last thing
        // the relay sends and it is usually the end of the sentence.
        val raw = synchronized(transcriptLock) {
            transcript.foldPartial()
            _text.value = transcript.live
            transcript.committed
        }
        if (cancelled || terminal.get()) return
        if (raw.isBlank()) {
            // Nothing was heard. Not a failure — a key tapped twice, or a silent
            // room. The input method clears the (empty) composing region.
            publishDone(text = "", polished = false)
            return
        }

        val polished = polishedOrNull(raw)
        publishDone(text = polished ?: raw, polished = polished != null)
    }

    /** The one place [DictationState.Done] is published, guarded by [terminal]. */
    private fun publishDone(text: String, polished: Boolean) {
        if (!terminal.compareAndSet(false, true)) return
        _state.value = DictationState.Done(text = text, polished = polished, reachedLimit = reachedLimit)
        teardown()
    }

    /**
     * The cleanup pass with a deadline on it. Every way this can go wrong — the
     * switch being off, too short to bother with, a timeout, no network, an HTTP
     * error, a reply that failed `accept` — comes back as null, which the caller
     * reads as "keep the raw transcript". None of them is news the user has to be
     * told, and none of them may cost them their words.
     */
    private suspend fun polishedOrNull(raw: String): String? {
        if (!runCatching { settings.polishEnabledNow() }.getOrDefault(true)) return null
        if (!TranscriptPolisher.shouldPolish(raw)) return null
        return withTimeoutOrNull(TranscriptPolisher.POLISH_BUDGET_MS) {
            runCatching {
                TranscriptPolisher.polish(
                    raw = raw,
                    // CloudClient is the ChatCompletions transport, exactly
                    // as for the filing pass (`filing/FilingPass`).
                    chat = cloud,
                )
            }.getOrNull()
        }
    }

    private fun fail(reason: DictationFailure, detail: String?) {
        if (cancelled) return
        if (!terminal.compareAndSet(false, true)) return
        val partial = synchronized(transcriptLock) {
            transcript.foldPartial()
            _text.value = transcript.live
            transcript.committed
        }
        _state.value = DictationState.Failed(
            reason = reason,
            partialText = partial,
            detail = detail,
        )
        teardown()
    }

    /**
     * Close the socket and stop the clocks. Safe to call twice, and safe to call
     * from a terminal state that has already called it.
     */
    private fun teardown() {
        tickerJob?.cancel()
        capJob?.cancel()
        eventsJob?.cancel()
        runCatching { relay?.cancel() }
        relay = null
    }

    private fun startTicker() {
        val startedAt = SystemClock.elapsedRealtime()
        tickerJob?.cancel()
        tickerJob = scope.launch {
            while (true) {
                _elapsedMs.value = SystemClock.elapsedRealtime() - startedAt
                delay(TICK_MS)
            }
        }
    }

    /**
     * The ten-minute cap: iOS `MicActivityPolicy.dictationLimit` and the
     * desktop's `HOSTED_VOICE_TYPING_MAX_SECONDS`, so hosted voice typing ends at
     * the same moment on every platform.
     *
     * It bounds the foreground service and means a key left running in a pocket
     * cannot meter audio all afternoon. It is not silent: the keyboard counts the
     * last 30 seconds down ([DictationCountdown]), and reaching it is an
     * ordinary stop — the words are polished and committed — with a note
     * ([DictationState.Done.reachedLimit]) saying why it ended.
     */
    private fun startCap() {
        capJob?.cancel()
        capJob = scope.launch {
            delay(MAX_DURATION_MS)
            reachedLimit = true
            requestStop()
        }
    }

    private fun micFailure(e: MicCaptureException): DictationFailure = when (e) {
        is MicCaptureException.PermissionDenied -> DictationFailure.MIC_PERMISSION
        is MicCaptureException.DeviceUnavailable -> DictationFailure.MIC_UNAVAILABLE
        is MicCaptureException.UnsupportedConfiguration -> DictationFailure.MIC_UNAVAILABLE
        is MicCaptureException.ReadFailed -> DictationFailure.MIC_UNAVAILABLE
    }

    companion object {
        private const val TAG = "DictationSession"

        /** Ten minutes, iOS `MicActivityPolicy.dictationLimit`. See [startCap]. */
        const val MAX_DURATION_MS = 600_000L

        /** How long to wait for the relay's flushed tail before giving up on it. */
        private const val DRAIN_TIMEOUT_MS = 3_000L

        private const val TICK_MS = 200L
    }
}
