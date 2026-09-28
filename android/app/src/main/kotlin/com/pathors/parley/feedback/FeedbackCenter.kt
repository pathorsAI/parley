package com.pathors.parley.feedback

import android.app.Activity
import android.content.Context
import com.pathors.parley.cloud.CloudClient
import java.io.File
import java.util.Locale
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * The report sheet's contents while it is up: why it was opened, and the
 * picture of the app it came with, if any.
 */
data class ReportDraft(val trigger: FeedbackTrigger, val screen: CapturedScreen? = null)

/** Something the feedback host shows at the bottom of the screen, one at a time. */
sealed interface FeedbackNotice {
    /** "Sent. Thank you." — after any report left the phone's hands. */
    data object Sent : FeedbackNotice

    /** "Deleted. Send us diagnostics for this recording?" — for five seconds. */
    data class DeleteOffer(val recording: RecordingContext) : FeedbackNotice

    /** "Report this screen?" — for five seconds, after a screenshot. */
    data class ScreenshotOffer(val screen: CapturedScreen) : FeedbackNotice
}

/**
 * The app's one door for problem reports: every trigger in spec §4 comes
 * through here, and so does everything that leaves the phone because of one.
 *
 * ## What it owns
 *
 * - **Sending.** [send] snapshots the diagnostics *now*, writes the report to
 *   the [queue], says "Sent" and tries the network. The queue, not the
 *   network, is the promise: a report made in a lift is still delivered.
 * - **The frequency limits.** Screens ask [claimPrompt] before they show a
 *   prompt and report [promptIgnored] when it is brushed off, so the rules in
 *   [PromptGate] live in one place however many screens raise prompts.
 * - **Crashes.** [handleLaunch] looks for the last process's crash and either
 *   sends it (the default) or raises [crashOffer] for the banner.
 * - **The shared surfaces** — the report sheet ([draft]), the crash banner, and
 *   the bottom-of-screen notices — which `ui/FeedbackHost.kt` draws once, over
 *   every screen, so no screen has to host them.
 *
 * ## What never goes out
 *
 * Audio, transcript text, anything typed into the app, and a screenshot the
 * person removed. The diagnostics describe a recording by its shape (length,
 * segment count, where the last segment ends); see [RecordingContext].
 *
 * Nothing here runs in demo mode: a screenshot run must not raise prompts over
 * the frames it is capturing, and must never send anything.
 */
class FeedbackCenter(
    private val app: Context,
    private val scope: CoroutineScope,
    private val cloud: CloudClient,
    private val settings: FeedbackSettings,
    private val gate: PromptGateStore,
    private val queue: FeedbackQueue,
    private val collector: DiagnosticsCollector,
    private val crashes: UncaughtCrashRecorder,
    private val isDemo: () -> Boolean,
    private val now: () -> Long = System::currentTimeMillis,
) {

    val autoSendCrashes: Flow<Boolean> = settings.autoSendCrashes

    fun setAutoSendCrashes(on: Boolean) {
        scope.launch { settings.setAutoSendCrashes(on) }
    }

    // ── surfaces ─────────────────────────────────────────────────────────────

    private val _draft = MutableStateFlow<ReportDraft?>(null)

    /** The report sheet, while it is up. */
    val draft: StateFlow<ReportDraft?> = _draft.asStateFlow()

    private val _crashOffer = MutableStateFlow(false)

    /** Whether the "Parley closed unexpectedly last time" banner is up. */
    val crashOffer: StateFlow<Boolean> = _crashOffer.asStateFlow()

    private val _notices = Channel<FeedbackNotice>(Channel.BUFFERED)

    /** Bottom-of-screen notices, in order. One consumer: the feedback host. */
    val notices: Flow<FeedbackNotice> = _notices.receiveAsFlow()

    // ── prompts ──────────────────────────────────────────────────────────────

    /**
     * Whether [trigger] may be shown for [recordingId] — and if so, it counts
     * as shown from this moment, so the same recording never raises it again.
     * One call rather than check-then-mark, so two screens asking at once
     * cannot both win.
     */
    suspend fun claimPrompt(trigger: FeedbackTrigger, recordingId: String?): Boolean {
        if (isDemo()) return false
        return withContext(Dispatchers.IO) {
            var allowed = false
            gate.update { current ->
                allowed = current.canShow(trigger, recordingId, now())
                if (allowed) current.markShown(trigger, recordingId) else current
            }
            allowed
        }
    }

    /** A prompt went away unanswered. See [PromptGate] for what that means. */
    fun promptIgnored(trigger: FeedbackTrigger) {
        scope.launch(Dispatchers.IO) { gate.update { it.markIgnored(trigger, now()) } }
    }

    // ── sending ──────────────────────────────────────────────────────────────

    /**
     * Send one report: diagnostics as of now, queued first, then flushed.
     * Returns at once; the "Sent" notice follows as soon as it is queued.
     */
    fun send(
        trigger: FeedbackTrigger,
        recording: RecordingContext? = null,
        tags: List<String> = emptyList(),
        message: String? = null,
        screen: CapturedScreen? = null,
    ) {
        if (isDemo()) {
            screen?.discard()
            return
        }
        scope.launch {
            withContext(Dispatchers.IO) {
                val payload = FeedbackPayload(
                    id = newReportId(),
                    trigger = trigger,
                    recordingId = recording?.recordingId,
                    message = message,
                    tags = tags,
                    // Reads the upload queue and the sync ledger off disk.
                    diagnostics = collector.collect(recording),
                )
                queue.enqueue(payload, screen?.jpeg, now())
            }
            _notices.send(FeedbackNotice.Sent)
            flushNow()
        }
    }

    /** Try to deliver everything queued. Launch, a returning network, a foreground, a sign-in. */
    fun flush() {
        if (isDemo()) return
        scope.launch { flushNow() }
    }

    private suspend fun flushNow() {
        withContext(Dispatchers.IO) {
            runCatching {
                queue.flush { payloadJson, screenshot ->
                    cloud.submitFeedback(FeedbackMultipart.build(payloadJson, screenshot))
                }
            }.onFailure { Log.w(TAG, "feedback flush failed", it) }
        }
    }

    // ── the report sheet ─────────────────────────────────────────────────────

    /** "Report a problem" — or a tapped screenshot prompt, with its picture. */
    fun openReport(trigger: FeedbackTrigger = FeedbackTrigger.MANUAL, screen: CapturedScreen? = null) {
        _draft.value?.screen?.takeIf { it !== screen }?.discard()
        _draft.value = ReportDraft(trigger, screen)
    }

    /** The sheet went away without sending. The picture, if any, is not kept. */
    fun closeReport() {
        _draft.value?.screen?.discard()
        _draft.value = null
    }

    /** "Send" on the sheet. [keepScreenshot] false is "Remove screenshot". */
    fun submitReport(message: String, keepScreenshot: Boolean) {
        val draft = _draft.value ?: return
        _draft.value = null
        val screen = draft.screen?.takeIf { keepScreenshot }
        if (screen == null) draft.screen?.discard()
        send(trigger = draft.trigger, message = message.trim().ifEmpty { null }, screen = screen)
    }

    // ── delete_failed ────────────────────────────────────────────────────────

    /**
     * What the phone last saw of each recording's transcript, so that deleting
     * one from the library can tell a truncated recording from a fine one —
     * the library's row carries the preview line but not where the transcript
     * ends. In memory and small: the case it serves is "opened it, saw it was
     * broken, went back and deleted it", which happens within one process.
     */
    private val shapes = object : LinkedHashMap<String, RecordingContext>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, RecordingContext>?) =
            size > MAX_REMEMBERED_SHAPES
    }

    fun noteRecordingShape(recording: RecordingContext) {
        val id = recording.recordingId ?: return
        synchronized(shapes) { shapes[id] = recording }
    }

    fun recordingShape(id: String): RecordingContext? = synchronized(shapes) { shapes[id] }

    /**
     * A recording was deleted. When it looked broken, offer — once, for five
     * seconds — to send its diagnostics; the deletion is often the only thing
     * a person does about a failed recording.
     */
    /** The delete offer's answer: its action sends, anything else is a brush-off. */
    fun answerDeleteOffer(recording: RecordingContext, accepted: Boolean) {
        if (accepted) send(FeedbackTrigger.DELETE_FAILED, recording) else promptIgnored(FeedbackTrigger.DELETE_FAILED)
    }

    fun recordingDeleted(recording: RecordingContext) {
        val id = recording.recordingId ?: return
        val duration = recording.recordingDurationMs ?: return
        val segments = recording.transcriptSegments ?: return
        val broken = ProblemSignals.isEmptyTranscript(duration, segments) ||
            ProblemSignals.isTruncatedTranscript(duration, segments, recording.lastSegmentEndMs ?: 0L)
        if (!broken) return
        scope.launch {
            if (claimPrompt(FeedbackTrigger.DELETE_FAILED, id)) {
                _notices.send(FeedbackNotice.DeleteOffer(recording))
            }
        }
    }

    // ── screenshot ───────────────────────────────────────────────────────────

    /**
     * The system says the person took a screenshot (Android 14+). Picture the
     * app's own window and offer "Report this screen?" — unless that prompt is
     * resting, or a report is already being written.
     */
    fun screenshotTaken(activity: Activity) {
        if (isDemo() || _draft.value != null || offeringScreenshot) return
        offeringScreenshot = true
        scope.launch(Dispatchers.Main) {
            val screen = if (claimPrompt(FeedbackTrigger.SCREENSHOT, null)) ScreenCapture.capture(activity) else null
            if (screen == null) {
                offeringScreenshot = false
            } else {
                _notices.send(FeedbackNotice.ScreenshotOffer(screen))
            }
        }
    }

    /**
     * One offer at a time: three screenshots in a row (a person capturing a
     * long transcript) are one "Report this screen?", not three queued up.
     * Main thread only.
     */
    private var offeringScreenshot = false

    /** "Report" opens the sheet with the picture; a timeout is a brush-off and the picture goes. */
    fun answerScreenshotOffer(screen: CapturedScreen, report: Boolean) {
        offeringScreenshot = false
        if (report) {
            openReport(FeedbackTrigger.SCREENSHOT, screen)
        } else {
            screen.discard()
            promptIgnored(FeedbackTrigger.SCREENSHOT)
        }
    }

    // ── crash ────────────────────────────────────────────────────────────────

    /** The crashes waiting on the banner's answer. */
    private var offered: CrashSelection.Selection? = null
    private val crashLock = Mutex()

    /**
     * Launch: find what the last process died of, then deliver whatever is
     * queued. Sent without asking when "Send crash reports automatically" is on
     * (the default); otherwise held for the banner, and asked about on every
     * launch until it is answered.
     */
    fun handleLaunch() {
        if (isDemo()) return
        scope.launch {
            crashLock.withLock {
                val selection = withContext(Dispatchers.IO) {
                    CrashSelection.select(
                        uncaught = crashes.pending(),
                        exits = ExitReasonReader.read(app),
                        watermarkMs = settings.exitWatermarkMs(),
                    )
                }
                when {
                    selection.crashes.isEmpty() -> settle(selection)
                    settings.autoSendCrashesNow() -> {
                        enqueueCrashes(selection)
                        settle(selection)
                    }
                    else -> {
                        offered = selection
                        _crashOffer.value = true
                    }
                }
            }
            flushNow()
        }
    }

    /**
     * The banner's answer. [alwaysSend] is its "Send automatically from now on"
     * box, which sets the switch whichever button was pressed — the box is
     * about the future, the buttons about this crash.
     */
    fun answerCrashOffer(send: Boolean, alwaysSend: Boolean) {
        _crashOffer.value = false
        scope.launch {
            if (alwaysSend) settings.setAutoSendCrashes(true)
            crashLock.withLock {
                val selection = offered ?: return@withLock
                offered = null
                if (send) enqueueCrashes(selection)
                settle(selection)
            }
            if (send) {
                _notices.send(FeedbackNotice.Sent)
                flushNow()
            }
        }
    }

    private suspend fun enqueueCrashes(selection: CrashSelection.Selection) {
        withContext(Dispatchers.IO) {
            selection.crashes.forEach { crash ->
                queue.enqueue(
                    FeedbackPayload(
                        id = newReportId(),
                        trigger = FeedbackTrigger.CRASH,
                        diagnostics = collector.collectForCrash(crash.block),
                    ),
                    nowMs = now(),
                )
            }
        }
    }

    /** These crashes are dealt with — sent or declined — and must not come back. */
    private suspend fun settle(selection: CrashSelection.Selection) {
        selection.watermarkMs?.let { settings.setExitWatermarkMs(it) }
        withContext(Dispatchers.IO) { selection.handledFiles.forEach { it.delete() } }
    }

    companion object {
        private const val TAG = "FeedbackCenter"
        private const val MAX_REMEMBERED_SHAPES = 50

        /** Lowercase, like every id this app mints for the cloud. */
        fun newReportId(): String = UUID.randomUUID().toString().lowercase(Locale.ROOT)

        const val DIRECTORY_NAME = "Feedback"

        fun directory(context: Context): File = File(context.applicationContext.filesDir, DIRECTORY_NAME)
    }
}
