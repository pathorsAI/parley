package com.pathors.parley.ui

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.pathors.parley.AppContainer
import com.pathors.parley.cloud.BatchTranscriptionProblem
import com.pathors.parley.cloud.CloudClient
import com.pathors.parley.cloud.CloudException
import com.pathors.parley.cloud.CloudFolder
import com.pathors.parley.cloud.RecordingMeta
import com.pathors.parley.cloud.asBatchTranscriptionProblem
import com.pathors.parley.filing.FilingCardController
import com.pathors.parley.filing.FilingSuggestionModel
import com.pathors.parley.filing.FilingTarget
import com.pathors.parley.filing.PendingFiling
import com.pathors.parley.filing.SampleFilingTarget
import com.pathors.parley.kit.GettingStartedState
import com.pathors.parley.feedback.FeedbackTrigger
import com.pathors.parley.feedback.ProblemSignals
import com.pathors.parley.feedback.RecordingContext
import com.pathors.parley.feedback.RetranscribeTag
import com.pathors.parley.kit.GettingStartedStep
import com.pathors.parley.kit.GuidedLap
import com.pathors.parley.kit.SampleManifest
import com.pathors.parley.library.LibraryFolders
import com.pathors.parley.onboarding.SampleRecordingStore
import com.pathors.parley.playback.PlaybackController
import com.pathors.parley.playback.PlaybackPhase
import com.pathors.parley.playback.PlaybackState
import com.pathors.parley.screenshot.DemoMode
import com.pathors.parley.upload.BackfillStatus
import com.pathors.parley.upload.ManualRetryBudgetSpentException
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * One finding from the desktop's retro analysis — the phone renders it read-only.
 *
 * Read tolerantly out of the raw meta rather than through a typed decoder: the
 * desktop owns this shape (`src/lib/types.ts` `TimelineEvent`) and evolves it
 * without asking the phone, so an unexpected field must degrade to a missing line
 * rather than failing the whole screen.
 */
data class FindingRow(
    val id: String,
    val title: String,
    val detail: String,
    /** Where on the recording it starts; 0 when the entry does not say, as on iOS. */
    val atMs: Long,
    val severity: String?,
)

/** One action item (`src/lib/types.ts` `ActionItem`). */
data class ActionItemRow(
    /** The item's own id, or `action-{index}` — what a tick is keyed by. */
    val id: String,
    val text: String,
    val done: Boolean,
    /** Where on the recording it came from, when the analysis could say. */
    val atMs: Long?,
)

/**
 * Why the recording could not be shown. A code — the screen owns the copy for
 * each, and says it under iOS's "Couldn't load".
 */
enum class DetailLoadFailure {
    /** The bundled sample was taken out of the library meanwhile. */
    SAMPLE_MISSING,

    /** The request never reached the cloud, or it timed out. */
    NETWORK,

    /** The cloud answered with an error. */
    SERVER,

    /** The recording is not in the cloud any more (404). */
    NOT_FOUND,

    /** Signed in, but not allowed to read it (403) — typically an org it left. */
    FORBIDDEN,

    /** The session is dead (401). */
    SIGNED_OUT,
}

/**
 * Why "transcribe again" cannot be offered right now.
 *
 * A code rather than a sentence, the same split [com.pathors.parley.playback.PlaybackFailure]
 * makes: the ViewModel decides *whether* the action is available and the screen
 * owns the bilingual copy for each reason.
 */
enum class RetranscribeBlock {
    /** A run for this recording is alive right now. A queued one is not this. */
    IN_FLIGHT,

    /** The cap on hand-triggered runs is used up. */
    BUDGET_SPENT,

    /** Nothing to send: no audio on this phone and none in the cloud either. */
    NO_AUDIO,
}

/** What the last attempt ran into. */
sealed interface RetranscribeFailure {

    /** The cloud refused, or the network did. Carries its own display copy. */
    data class Cloud(val problem: BatchTranscriptionProblem) : RetranscribeFailure

    /**
     * The audio could not be fetched, so nothing was sent. Deliberately does not
     * carry the download's own reason: the player is pinned directly above this
     * line and is already showing it.
     */
    data object AudioUnavailable : RetranscribeFailure

    /** The cap ran out between the screen opening and the tap landing. */
    data object BudgetSpent : RetranscribeFailure

    /**
     * A pass came back without this recording's new transcript and gave no
     * reason worth reading — iOS "Re-transcribing didn't finish this time."
     */
    data object DidNotFinish : RetranscribeFailure
}

/**
 * Everything the "transcribe again" entry point needs, in one snapshot.
 *
 * Split out of [RecordingDetailViewModel.UiState] rather than folded into it
 * because the two change on completely different clocks — the meta is fetched
 * once, this moves through a confirmation, a queue and possibly a failure — and
 * because a state machine that is its own value is one a test can drive without
 * a container, a cloud or a coroutine.
 *
 * ## Running is not queued (iOS 1.14)
 *
 * The spinner belongs to a run that is actually alive — this screen's own
 * ([Phase.WORKING]) or a background pass that has picked this recording up
 * ([runningNow]). A request that is merely *waiting* in the queue gets plain
 * text, the truth about what will move it, and a **Start now** action; it no
 * longer blocks asking again. A spinner over a request nothing was running was
 * the whole of the reported bug: the phone said it was transcribing, it was
 * not, and the retry that would have moved it was disabled because of it.
 */
data class RetranscribeState(
    val phase: Phase = Phase.IDLE,
    /** The confirmation dialog is up. The phase underneath is left as it was. */
    val confirming: Boolean = false,
    /** Hand-triggered runs left on this recording, 0…3. */
    val retriesRemaining: Int = 0,
    /** Whether audio exists to send — on the phone, or downloadable from the cloud. */
    val audioObtainable: Boolean = false,
    /**
     * The last attempt's complaint, or null. Survives into [Phase.QUEUED]: a run
     * that failed while staying queued is both things at once, and saying only
     * "waiting" would hide a quota message the person needs. Never drawn beside
     * the spinner (see [status]).
     */
    val failure: RetranscribeFailure? = null,
    /** A run for this recording is alive right now, started by anyone. */
    val runningNow: Boolean = false,
    /** When a run last started on the queued request, epoch ms; null if none ever has. */
    val lastAttemptAtMs: Long? = null,
) {

    enum class Phase {
        IDLE,

        /** This screen is fetching the audio, queueing the run and running it. */
        WORKING,

        /** In the backfill queue: this screen's transcript is going to be replaced. */
        QUEUED,

        /** The attempt did not reach the queue. [failure] says why. */
        FAILED,
    }

    /** What the inline status band shows — one of these, never two. */
    enum class Status {
        NONE,

        /** Spinner and "Re-transcribing… this can take a few minutes." Nothing else. */
        RUNNING,

        /** The last complaint, if any, then "Waiting to re-transcribe…" and Start now. */
        WAITING,

        /** Nothing queued; only the refusal that explains a tap that did nothing. */
        FAILURE,
    }

    /** A run is alive: this screen's own, or a pass that picked the queued request up. */
    val isRunning: Boolean
        get() = phase == Phase.WORKING || (phase == Phase.QUEUED && runningNow)

    /** Queued, and nothing is running it. */
    val isWaiting: Boolean get() = phase == Phase.QUEUED && !runningNow

    val status: Status
        get() = when {
            isRunning -> Status.RUNNING
            isWaiting -> Status.WAITING
            failure != null -> Status.FAILURE
            else -> Status.NONE
        }

    /**
     * Why the action is unavailable, or null when it can be taken. Only a run
     * that is alive closes it — a queued request is one nobody is working on,
     * and asking again is exactly the right thing to be able to do.
     */
    val block: RetranscribeBlock?
        get() = when {
            isRunning -> RetranscribeBlock.IN_FLIGHT
            retriesRemaining <= 0 -> RetranscribeBlock.BUDGET_SPENT
            !audioObtainable -> RetranscribeBlock.NO_AUDIO
            else -> null
        }

    val canRequest: Boolean get() = block == null

    /** Whether "Start now" can run the queued request. */
    val canStartNow: Boolean get() = isWaiting && !confirming

    // ── transitions ──────────────────────────────────────────────────────────
    //
    // Pure, and all of them here rather than as `copy` calls scattered through
    // the ViewModel: these lines are the whole contract the screen renders, and
    // they are what the unit test drives.

    fun confirming(): RetranscribeState = if (canRequest) copy(confirming = true) else this

    fun dismissed(): RetranscribeState = copy(confirming = false)

    /**
     * The person said yes, or tapped Start now. Clears the previous complaint —
     * this is a new attempt, and a red line under a live spinner would be the
     * band claiming both at once.
     */
    fun working(): RetranscribeState = copy(phase = Phase.WORKING, confirming = false, failure = null)

    fun queued(retriesRemaining: Int = this.retriesRemaining): RetranscribeState =
        copy(phase = Phase.QUEUED, retriesRemaining = retriesRemaining, failure = null)

    /**
     * The run landed and the transcript on screen has been replaced: back to
     * idle, with one fewer retry.
     */
    fun settled(retriesRemaining: Int): RetranscribeState =
        copy(phase = Phase.IDLE, retriesRemaining = retriesRemaining, failure = null, runningNow = false)

    /**
     * The pass ended without clearing this recording. It stays queued and will
     * be retried, and the band says why it stopped — the queue's own reason
     * when it kept one, "didn't finish this time" otherwise — because
     * "waiting" alone reads as progress.
     */
    fun stillQueued(problem: BatchTranscriptionProblem?): RetranscribeState = copy(
        phase = Phase.QUEUED,
        failure = problem?.let { RetranscribeFailure.Cloud(it) } ?: RetranscribeFailure.DidNotFinish,
    )

    fun failed(failure: RetranscribeFailure): RetranscribeState = copy(
        phase = Phase.FAILED,
        failure = failure,
        // A budget refusal is also the authoritative answer about the budget, so
        // the count follows it — otherwise the menu would offer a retry the
        // queue has just said it will not accept.
        retriesRemaining =
            if (failure is RetranscribeFailure.BudgetSpent) 0 else retriesRemaining,
    )

    /**
     * What the queue says about this recording, read after a load, a landed
     * run, or a change in what is running. Only ever moves an idle or failed
     * screen into the queued state, or a queued one out of it: a request this
     * screen is in the middle of making owns [Phase.WORKING], and must not be
     * overwritten by a queue read that was in flight at the same time.
     */
    fun observed(status: BackfillStatus): RetranscribeState = when (status) {
        BackfillStatus.Running -> copy(runningNow = true, phase = promotedToQueued())
        is BackfillStatus.Queued -> copy(
            runningNow = false,
            lastAttemptAtMs = status.lastAttemptAtMs,
            phase = promotedToQueued(),
        )
        BackfillStatus.None -> copy(
            runningNow = false,
            lastAttemptAtMs = null,
            phase = if (phase == Phase.QUEUED) Phase.IDLE else phase,
        )
    }

    private fun promotedToQueued(): Phase =
        if (phase == Phase.IDLE || phase == Phase.FAILED) Phase.QUEUED else phase
}

/**
 * The "send us diagnostics" prompts this screen can raise about the recording
 * on it (spec §4) — each null or false when it is not up.
 *
 * Decided once, when the recording first loads, and only for a personal cloud
 * recording: never the sample, an organization's copy (somebody else's
 * recording, as far as a report goes) or a screenshot run. Each goes through
 * the app's frequency limits (`feedback/PromptGate`) before it is shown, and
 * counts as shown from then on — reopening the recording does not bring it
 * back.
 */
data class DetailPrompts(
    /**
     * The empty transcript's own state is drawn whenever the recording is 20 s
     * or more with no transcript; [emptyCanSend] says whether its "Send us
     * diagnostics" button is in it. The explanation and "Transcribe again" are
     * worth showing even when the prompt itself is resting.
     */
    val emptyMinutes: Int? = null,
    val emptyCanSend: Boolean = false,
    /** Where a truncated transcript stops, for the banner over it. */
    val truncatedAtMs: Long? = null,
    /** "What was wrong last time?" after a re-transcription landed here. */
    val askRetranscribe: Boolean = false,
)

class RecordingDetailViewModel(
    private val container: AppContainer,
    val recordingId: String,
    /**
     * The organization whose library this recording was opened from, or null
     * for a personal recording. An org recording is read through the org's
     * endpoints, and everything on this screen that writes through the
     * *personal* ones — re-transcribing, filing, downloading the audio — is
     * unavailable for it, as on iOS.
     */
    private val orgId: String? = null,
    /**
     * Application context, for the player. Passed in rather than reached for
     * through [AppContainer]: a ViewModel that can see the whole Application is
     * a ViewModel that can leak an Activity by accident.
     */
    context: Context,
) : ViewModel() {

    /**
     * The bundled sample (`SampleRecordingStore`): read from the APK, never the
     * cloud, so everything that writes to the cloud is off for it.
     */
    val isSample: Boolean = SampleManifest.isSample(recordingId)

    /**
     * The player for this recording. Built with the screen and released with
     * it — one recording, one engine, and `onCleared` is what guarantees the
     * audio stops when the screen goes away.
     *
     * The sample plays its real, bundled audio even in demo mode: it needs no
     * network and no account, and it is the one recording a screenshot run can
     * genuinely play.
     */
    private val playback = PlaybackController(
        context = context,
        cloud = container.cloud,
        store = if (isSample) container.sample.audioStore else container.localAudio,
        scope = viewModelScope,
        demo = DemoMode.isActive && !isSample,
    )

    val playbackState: StateFlow<PlaybackState> = playback.state

    fun togglePlayPause() = playback.togglePlayPause()

    /**
     * Every caller is a person — the scrubber, a highlight dot, TalkBack's
     * ±15 s — so the first seek ticks the checklist's "replay". Called on every
     * move of a scrub, hence the once-only mark. Only a seek that moved the
     * playhead counts: "replay" is the lesson that a line takes you there, and
     * a tick over a player that stayed put would teach the opposite.
     */
    fun seekTo(ms: Long) {
        if (playback.seekTo(ms)) markReplayed()
    }

    /**
     * A seek asked for from the text — a tapped turn or its timecode. The
     * player glides its playhead there and rings the spot; see
     * [PlaybackController.jumpTo]. Ticks "replay" only when it moved.
     */
    fun jumpTo(ms: Long) {
        if (playback.jumpTo(ms)) markReplayed()
    }

    private var replayMarked = false

    private fun markReplayed() {
        if (replayMarked) return
        replayMarked = true
        container.gettingStarted.mark(GettingStartedStep.REPLAYED)
    }

    fun setRate(rate: Float) = playback.setRate(rate)

    fun cycleRate() = playback.cycleRate()

    fun downloadAudio() {
        // `GET /recordings/{id}/audio` is the personal endpoint; an org
        // recording's audio lives behind an org path this client does not
        // speak, and a download that would 404 is worse than none.
        // The sample's audio is in the APK; there is nothing to fetch.
        if (orgId == null && !isSample) playback.download()
    }

    /** Whether this screen can file the recording: personal recordings only, as on iOS. */
    val canMoveToFolder: Boolean get() = orgId == null

    /**
     * Whether "transcribe again" applies — it re-pushes through the personal
     * endpoints. Never the sample: its transcript is written, not transcribed,
     * and its audio is not in the cloud to be sent again.
     */
    val canRetranscribe: Boolean get() = orgId == null && !isSample

    /**
     * The analysis prompt plus the transcript — [HandoffText] — or empty
     * before the meta has arrived. The sample asks the questions written for
     * its script.
     */
    fun handoffText(context: Context): String {
        val meta = _state.value.meta ?: return ""
        return HandoffText.build(context, meta, sampleQuestions)
    }

    /** "Copy with analysis prompt" put it on the clipboard: that is a hand-off too. */
    fun noteCopiedWithPrompt() = container.gettingStarted.mark(GettingStartedStep.SHARED_TO_AI)

    private var sampleQuestions: List<String>? = null

    override fun onCleared() {
        playback.release()
        // Leaving with a prompt still up and unanswered is brushing it off —
        // the same as its ×, as far as the frequency limits go.
        val left = _prompts.value
        listOf(
            FeedbackTrigger.EMPTY_TRANSCRIPT,
            FeedbackTrigger.TRUNCATED_TRANSCRIPT,
            FeedbackTrigger.RETRANSCRIBE,
        ).filter { left.isShowing(it) }.forEach(container.feedback::promptIgnored)
    }

    data class UiState(
        val loading: Boolean = true,
        val meta: RecordingMeta? = null,
        /** The analysis's brief, as `BriefMarkup` source; empty when there is none. */
        val brief: String = "",
        val findings: List<FindingRow> = emptyList(),
        val actionItems: List<ActionItemRow> = emptyList(),
        /** Why nothing could be shown, or null. */
        val failure: DetailLoadFailure? = null,
    ) {
        val failed: Boolean get() = failure != null

        /**
         * Whether there is anything for the summary page to show: a brief, a
         * finding, or an action item. What the screen opens on is decided by
         * this — iOS `RecordingMeta.hasAnalysis`.
         */
        val hasAnalysis: Boolean
            get() = brief.isNotEmpty() || findings.isNotEmpty() || actionItems.isNotEmpty()
    }

    /**
     * Whether a tick on an action item is kept. The sample only: it keeps its
     * ticks on the phone. A cloud recording shows the ticks it has and takes
     * none, because the phone has no write path for them — iOS
     * `canTickActionItems`.
     */
    val canTickActionItems: Boolean get() = isSample

    /** Tick or untick one of the sample's action items, on screen and in its store. */
    fun tickActionItem(id: String, done: Boolean) {
        if (!canTickActionItems) return
        val meta = _state.value.meta ?: return
        _state.value = fromMeta(meta.withActionItem(id, done))
        viewModelScope.launch { container.sample.setActionItem(id, done) }
    }

    /** An edge of the transcript is held (2×) or let go. See [PlaybackController.holdTwoX]. */
    fun holdTwoX(holding: Boolean) = playback.holdTwoX(holding)

    /**
     * "Move to folder" from the overflow menu: the personal folders the picker
     * offers, and how the last move went. Its own flow, like [retranscribe], so
     * a folder list arriving does not rebuild the transcript's state.
     */
    data class FilingState(
        val folders: List<CloudFolder> = emptyList(),
        val moving: Boolean = false,
        val moveFailed: Boolean = false,
    )

    private val _filing = MutableStateFlow(FilingState())
    val filing: StateFlow<FilingState> = _filing.asStateFlow()

    /**
     * The filing suggestion card, above Summary | Transcript, for a recording
     * with a suggestion still pending — one a desktop pass or the backfill's
     * pass left in the synced meta, or the sample's own (through
     * [AppContainer.sampleFiling]). iOS `RecordingDetailView` since #450.
     *
     * Null where the recording cannot be filed from here (an org recording).
     *
     * ## Hooks for a guide (the onboarding GuideBar)
     *
     * - `filingCard?.wash()` — tint the card for 1.2 s: "look here".
     * - `filingCard?.openPicker()` — open "Choose another…", the folder
     *   picker with the suggested folders first.
     * - `filingCard?.state` — whether there is a card to point at
     *   ([com.pathors.parley.filing.FilingUiState.hasSomethingToOffer]).
     *
     * [washFilingCard] and [openFilingPicker] are the same two, for a caller
     * that holds only this ViewModel.
     */
    val filingCard: FilingCardController? = if (orgId == null) {
        FilingCardController(
            model = FilingSuggestionModel(
                cloud = container.cloud,
                // Only the meeting screen runs a pass; this one presents.
                speakerLabel = { "" },
                onFiled = { container.gettingStarted.mark(GettingStartedStep.FILED) },
                createFolder = if (DemoMode.isActive) {
                    { name -> demoFolder(name) }
                } else {
                    { name -> container.cloud.createFolder(name) }
                },
            ),
            scope = viewModelScope,
            backgroundScope = container.appScope,
            onWritten = ::showFilingAnswer,
        )
    } else {
        null
    }

    /** GuideBar hook: wash the filing card for 1.2 s. A no-op when there is no card. */
    fun washFilingCard() {
        filingCard?.wash()
    }

    /** GuideBar hook: open the filing card's folder picker. A no-op when there is no card. */
    fun openFilingPicker() {
        filingCard?.openPicker()
    }

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private val _retranscribe = MutableStateFlow(RetranscribeState())
    val retranscribe: StateFlow<RetranscribeState> = _retranscribe.asStateFlow()

    private val _prompts = MutableStateFlow(DetailPrompts())
    val prompts: StateFlow<DetailPrompts> = _prompts.asStateFlow()

    init {
        load()
        observeBackfills()
    }

    // ── problem reports ──────────────────────────────────────────────────────

    /** Whether this screen raises prompts at all — see [DetailPrompts]. */
    private val raisesPrompts: Boolean get() = orgId == null && !isSample && !DemoMode.isActive

    /** Prompts decided once per screen, on the first load that produced a recording. */
    private var promptsDecided = false

    /** The transcript as a report describes it: its shape, never its words. */
    private fun recordingContext(): RecordingContext? {
        val meta = _state.value.meta ?: return null
        val finals = meta.segments.filter { it.isFinal }
        return RecordingContext(
            recordingId = recordingId,
            recordingDurationMs = meta.durationMs.toLong(),
            transcriptSegments = finals.size,
            lastSegmentEndMs = finals.maxOfOrNull { it.endMs } ?: 0L,
        )
    }

    /**
     * Look at the transcript that just loaded and raise whichever of the two
     * transcript prompts it calls for. Not while a re-transcription is queued
     * for it: that is already the fix, and asking for a report about a
     * transcript that is about to be replaced would be asking about the past.
     */
    private suspend fun decidePrompts() {
        if (!raisesPrompts || promptsDecided) return
        val context = recordingContext() ?: return
        promptsDecided = true
        container.feedback.noteRecordingShape(context)
        val duration = context.recordingDurationMs ?: return
        val segments = context.transcriptSegments ?: return
        val lastEnd = context.lastSegmentEndMs ?: 0L
        if (_retranscribe.value.isRunning) return
        when {
            ProblemSignals.isEmptyTranscript(duration, segments) -> {
                val canSend = container.feedback.claimPrompt(FeedbackTrigger.EMPTY_TRANSCRIPT, recordingId)
                _prompts.update {
                    it.copy(emptyMinutes = ProblemSignals.wholeMinutes(duration), emptyCanSend = canSend)
                }
            }
            ProblemSignals.isTruncatedTranscript(duration, segments, lastEnd) -> {
                if (container.feedback.claimPrompt(FeedbackTrigger.TRUNCATED_TRANSCRIPT, recordingId)) {
                    _prompts.update { it.copy(truncatedAtMs = lastEnd) }
                }
            }
        }
    }

    /** A re-transcription of this recording landed while the screen was up. */
    private suspend fun offerRetranscribeChips() {
        if (!raisesPrompts) return
        recordingContext()?.let(container.feedback::noteRecordingShape)
        if (container.feedback.claimPrompt(FeedbackTrigger.RETRANSCRIBE, recordingId)) {
            _prompts.update { it.copy(askRetranscribe = true) }
        }
    }

    /** "Send us diagnostics" on the empty state or the truncated banner. */
    fun sendDiagnostics(trigger: FeedbackTrigger) {
        container.feedback.send(trigger, recordingContext())
        _prompts.update { it.without(trigger) }
    }

    /** One of the "what was wrong last time?" chips: that answer is the report. */
    fun answerRetranscribe(tag: RetranscribeTag) {
        container.feedback.send(FeedbackTrigger.RETRANSCRIBE, recordingContext(), tags = listOf(tag.id))
        _prompts.update { it.copy(askRetranscribe = false) }
    }

    /** The × on a prompt. */
    fun dismissPrompt(trigger: FeedbackTrigger) {
        if (!_prompts.value.isShowing(trigger)) return
        container.feedback.promptIgnored(trigger)
        _prompts.update { it.without(trigger) }
    }

    private fun DetailPrompts.isShowing(trigger: FeedbackTrigger): Boolean = when (trigger) {
        FeedbackTrigger.EMPTY_TRANSCRIPT -> emptyCanSend
        FeedbackTrigger.TRUNCATED_TRANSCRIPT -> truncatedAtMs != null
        FeedbackTrigger.RETRANSCRIBE -> askRetranscribe
        else -> false
    }

    /** The prompt taken down; the empty state itself stays, without its button. */
    private fun DetailPrompts.without(trigger: FeedbackTrigger): DetailPrompts = when (trigger) {
        FeedbackTrigger.EMPTY_TRANSCRIPT -> copy(emptyCanSend = false)
        FeedbackTrigger.TRUNCATED_TRANSCRIPT -> copy(truncatedAtMs = null)
        FeedbackTrigger.RETRANSCRIBE -> copy(askRetranscribe = false)
        else -> this
    }

    /**
     * A re-transcription landed somewhere in the app, and it may well be this
     * recording's: the queue drains on launch, on sign-in, on every
     * foregrounding and from the Re-transcribe tap, so a repaired transcript
     * can arrive while somebody is reading the recording it belongs to. iOS
     * observes `backfillRevision` for exactly this; before it, the screen kept
     * the transcript it had fetched and the new one turned up on some later
     * visit.
     *
     * Not for the sample (never transcribed) or a screenshot run (no queue).
     */
    private fun observeBackfills() {
        if (isSample || DemoMode.isActive) return
        viewModelScope.launch {
            container.backfiller.landed.drop(1).collect { backfillLanded() }
        }
        // A pass run from anywhere — the foreground drain, a network coming
        // back — picking this recording up, or letting go of it: the band
        // follows, so the spinner is up exactly while a run is alive.
        viewModelScope.launch {
            container.backfiller.running.drop(1).collect { syncRetranscribe() }
        }
    }

    private suspend fun backfillLanded() {
        val status = backfillStatus(default = BackfillStatus.Queued(null))
        val oursLanded =
            status == BackfillStatus.None && _retranscribe.value.phase == RetranscribeState.Phase.QUEUED
        if (oursLanded) {
            // Ours landed while the screen was saying it was waiting.
            val remaining = retriesRemaining()
            _retranscribe.update { it.settled(remaining) }
        }
        refreshMeta()
        syncRetranscribe()
        if (oursLanded) offerRetranscribeChips()
    }

    private suspend fun backfillStatus(default: BackfillStatus): BackfillStatus = try {
        container.backfiller.status(recordingId)
    } catch (e: CancellationException) {
        throw e
    } catch (e: Throwable) {
        default
    }

    fun load() {
        if (isSample) {
            viewModelScope.launch { loadSample() }
            if (canMoveToFolder) viewModelScope.launch { loadFolders() }
            return
        }
        if (DemoMode.isActive) {
            _state.value = fromMeta(DemoMode.meta(recordingId))
            openPlayer()
            viewModelScope.launch { syncRetranscribe() }
            if (canMoveToFolder) _filing.update { it.copy(folders = DemoMode.pickerFolders()) }
            return
        }
        viewModelScope.launch {
            _state.value = UiState(loading = true)
            _state.value = try {
                fromMeta(fetchMeta())
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                UiState(loading = false, failure = classifyLoadFailure(e))
            }
            openPlayer()
            presentFiling()
            syncRetranscribe()
            decidePrompts()
        }
        if (canMoveToFolder) viewModelScope.launch { loadFolders() }
    }

    /**
     * The sample is read from the APK, never the cloud — see
     * `SampleRecordingStore`. Its audio is unpacked into the cache first, so
     * the player finds it where it looks.
     */
    private suspend fun loadSample() {
        val sample = container.sample
        val entry = sample.currentEntry()
        val manifest = sample.manifestOf(entry)?.takeIf { it.id == recordingId }
        if (entry == null || manifest == null) {
            _state.value = UiState(loading = false, failure = DetailLoadFailure.SAMPLE_MISSING)
            return
        }
        sampleQuestions = manifest.questions
        _state.value = fromMeta(SampleRecordingStore.metaOf(manifest, entry))
        // The audio first: it is in the APK, so the player can be ready by the
        // time anyone taps a line — the guide bar's step 2 is exactly that tap.
        sample.ensureAudio(manifest)
        openPlayer()
        presentFiling()
    }

    private suspend fun fetchMeta(): RecordingMeta =
        if (orgId == null) {
            container.cloud.recordingMeta(recordingId)
        } else {
            container.cloud.orgRecordingMeta(orgId, recordingId)
        }

    // ── filing ───────────────────────────────────────────────────────────────

    /** Best-effort: without the list the picker still offers Unfiled and "New folder…". */
    private suspend fun loadFolders() {
        if (DemoMode.isActive) {
            _filing.update { it.copy(folders = DemoMode.pickerFolders()) }
            presentFiling()
            return
        }
        val folders = runCatching {
            LibraryFolders.personalFolders(container.cloud.listFolders())
        }.getOrNull() ?: return
        _filing.update { it.copy(folders = folders) }
        // Again, now with the list: the chips' "existing folder" captions and
        // the picker's suggested section are drawn against it.
        presentFiling()
    }

    /**
     * Put the recording's pending suggestion on the card, if it has one. Safe
     * to call on every load: an offer already being answered, or one the
     * person said no to, is left alone ([FilingSuggestionModel.present]).
     *
     * In a screenshot run only on the sample, whose answers stay in memory
     * (`DemoMode.sampleEntry`) — a cloud recording there has no account to
     * write to. The guided lap's first step is this card, so a demo walk
     * through the sample without it would not be the lap at all.
     */
    private suspend fun presentFiling() {
        val card = filingCard ?: return
        if (DemoMode.isActive && !isSample) return
        val meta = _state.value.meta ?: return
        val (offer, target) = pendingOffer(
            recordingId = recordingId,
            meta = meta,
            folders = _filing.value.folders,
            sample = container.sampleFiling.takeIf { isSample },
        ) ?: return
        card.model.present(offer, target)
    }

    /**
     * An answer landed: the title in the top bar, the folder the overflow
     * menu's picker ticks, and a folder created for it all follow.
     */
    private fun showFilingAnswer() {
        val offer = filingCard?.state?.value ?: return
        val meta = _state.value.meta ?: return
        var shown = meta
        val renamed = offer.currentTitle.isNotEmpty() && offer.currentTitle != meta.title
        if (renamed) shown = shown.withTitle(offer.currentTitle)
        if (offer.folderAnswered && offer.currentFolderId != currentFolderId()) {
            shown = shown.withFolderId(offer.currentFolderId)
            offer.existingFolders.firstOrNull { it.id == offer.currentFolderId }?.let {
                _lastFiling.value = FiledNote(it.name, renamed)
            }
        }
        if (shown !== meta) _state.update { it.copy(meta = shown) }
        val known = _filing.value.folders.mapTo(HashSet()) { it.id }
        val created = offer.existingFolders.filterNot { it.id in known }
        if (created.isNotEmpty()) _filing.update { it.copy(folders = it.folders + created) }
    }

    /**
     * The folder the recording is in, as the picker should tick it: an id that
     * is not in the live folder list is the desktop's orphan, Unfiled
     * everywhere else in the app.
     */
    fun currentFolderId(): String? =
        LibraryFolders.liveFolderId(_state.value.meta?.folderId, _filing.value.folders)

    /**
     * File the recording, or take it back to the root — the same full re-push
     * the library's row menu does. On success the meta on screen is updated in
     * place; the library re-reads on the way back, so its row follows.
     */
    fun moveToFolder(folderId: String?) {
        if (!canMoveToFolder || _filing.value.moving) return
        val meta = _state.value.meta ?: return
        // Filed on this phone and nowhere else — see `SampleRecordingStore`.
        if (DemoMode.isActive || isSample) {
            if (isSample) viewModelScope.launch { container.sample.setFolder(folderId) }
            showFiled(meta.withFolderId(folderId), folderId)
            return
        }
        viewModelScope.launch { refile(folderId) }
    }

    private suspend fun refile(folderId: String?) {
        _filing.update { it.copy(moving = true, moveFailed = false) }
        val landed = try {
            container.cloud.refileRecording(recordingId, folderId)
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            false
        }
        if (landed) _state.value.meta?.let { showFiled(it.withFolderId(folderId), folderId) }
        _filing.update { it.copy(moving = false, moveFailed = !landed) }
    }

    /** The move landed: the meta on screen follows, and filing into a folder ticks the checklist. */
    private fun showFiled(meta: RecordingMeta, folderId: String?) {
        _state.update { it.copy(meta = meta) }
        if (folderId == null) return
        _filing.value.folders.firstOrNull { it.id == folderId }?.let { _lastFiling.value = FiledNote(it.name, false) }
        container.gettingStarted.mark(GettingStartedStep.FILED)
    }

    /** The name of the (live) folder the recording is in, or null at the root. */
    fun currentFolderName(): String? {
        val id = currentFolderId() ?: return null
        return _filing.value.folders.firstOrNull { it.id == id }?.name
    }

    // ── the guided lap ───────────────────────────────────────────────────────

    /** What the last filing on this screen did, for the guide bar's ✓ line. */
    data class FiledNote(val folder: String, val renamed: Boolean)

    /**
     * The guide bar's lap, with the checklist it was last observed against
     * and what it shows right now. See [GuidedLap] and `GuideBar`.
     */
    data class LapUi(
        val lap: GuidedLap,
        val checklist: GettingStartedState,
        val display: GuidedLap.Display,
    )

    private val _lastFiling = MutableStateFlow<FiledNote?>(null)
    val lastFiling: StateFlow<FiledNote?> = _lastFiling.asStateFlow()

    private val _lap = MutableStateFlow<LapUi?>(null)

    /**
     * Null until the checklist has been read. Held here rather than in the
     * screen so a rotation keeps a ✓ that is being held, and the step the bar
     * was on.
     */
    val lap: StateFlow<LapUi?> = _lap.asStateFlow()

    private var lapRedraw: Job? = null

    // After the flows above: the collection starts at once on the main
    // dispatcher, and must find them built.
    init {
        observeLap()
    }

    /**
     * The checklist, as the bar sees it: every change is observed, so a step
     * finished anywhere — the card, the player, the share sheet, the library —
     * moves the bar, and one finished while it is up is held as a ✓ first.
     * Not for an org recording, which is never the lap's.
     */
    private fun observeLap() {
        if (orgId != null) return
        viewModelScope.launch {
            container.gettingStarted.state.filterNotNull().collect { checklist ->
                val lap = _lap.value?.lap?.observed(checklist, System.currentTimeMillis())
                    ?: GuidedLap.start(checklist)
                publishLap(lap, checklist)
            }
        }
    }

    /** Show [lap], and schedule the one redraw its ✓ hold needs — a timer, not polling. */
    private fun publishLap(lap: GuidedLap, checklist: GettingStartedState) {
        val now = System.currentTimeMillis()
        _lap.value = LapUi(lap, checklist, lap.display(now))
        lapRedraw?.cancel()
        val end = lap.holdEndsAtMs(now) ?: return
        lapRedraw = viewModelScope.launch {
            delay(end - now + LAP_REDRAW_SLACK_MS)
            _lap.value?.let { publishLap(it.lap, it.checklist) }
        }
    }

    /**
     * Whether this is the lap's recording: opened as it ([guided], which the
     * library sets for the sample or the only recording), or the sample
     * itself. Never an organization's.
     */
    fun isLapRecording(guided: Boolean): Boolean = orgId == null && (guided || isSample)

    /** "Close" on the done card. Local to this screen: the lap is over anyway. */
    fun closeLap() {
        _lap.value?.let { publishLap(it.lap.closing(), it.checklist) }
    }

    /** The three questions step 3 lists: the sample's own, or the generic three. */
    fun lapQuestions(context: Context): List<String> =
        sampleQuestions?.takeIf { it.isNotEmpty() } ?: HandoffText.genericQuestions(context)

    /**
     * "New folder…": create it in the personal library, then move the
     * recording into it. Throws when the folder could not be created, so the
     * picker can keep the name on screen with the error.
     */
    suspend fun createFolderAndMove(name: String) {
        check(canMoveToFolder) { "org recordings are not filed from this screen" }
        val folder = if (DemoMode.isActive) {
            CloudFolder(id = CloudClient.newCloudId(), name = name)
        } else {
            container.cloud.createFolder(name)
        }
        _filing.update { it.copy(folders = it.folders + folder) }
        moveToFolder(folder.id)
    }

    fun clearMoveError() = _filing.update { it.copy(moveFailed = false) }

    // ── transcribe again ─────────────────────────────────────────────────────

    /** The menu item. Opens the confirmation rather than starting anything. */
    fun askToRetranscribe() {
        if (canRetranscribe) _retranscribe.update { it.confirming() }
    }

    fun dismissRetranscribe() = _retranscribe.update { it.dismissed() }

    /**
     * The confirmation's "Transcribe again": get the audio, queue the run, and
     * drive the queue right now rather than waiting for the next foreground
     * pass — the person is looking at the screen they asked from.
     */
    fun confirmRetranscribe() {
        if (!_retranscribe.value.confirming) return
        _retranscribe.update { it.working() }
        // Transcribing again *is* the answer to the truncated banner, which
        // offers it; the banner goes without counting as brushed off.
        _prompts.update { it.copy(truncatedAtMs = null) }
        viewModelScope.launch { runRetranscription() }
    }

    /**
     * "Start now" under a waiting request: run the queue for it, right here.
     *
     * Deliberately not a second [TranscriptBackfiller.requestRetranscription]:
     * the manifest and the audio are already on disk, and queueing again would
     * spend another retry for a job the person has already paid for. This is
     * the foreground drain, asked for by hand — iOS `drainNow`.
     */
    fun startRetranscriptionNow() {
        if (!_retranscribe.value.canStartNow || DemoMode.isActive) return
        _retranscribe.update { it.working() }
        viewModelScope.launch { drainAndSettle() }
    }

    private suspend fun runRetranscription() {
        val meta = _state.value.meta
        if (meta == null) {
            _retranscribe.update { it.failed(RetranscribeFailure.AudioUnavailable) }
            return
        }
        if (DemoMode.isActive) {
            // A screenshot run has no cloud and no queue. Show the state the
            // action leads to and touch nothing — the same line every other
            // network path in this app draws around demo mode.
            _retranscribe.update { it.queued() }
            return
        }

        val audio = obtainAudio()
        if (audio == null) {
            _retranscribe.update { it.failed(RetranscribeFailure.AudioUnavailable) }
            return
        }

        try {
            container.backfiller.requestRetranscription(meta, audio)
        } catch (e: CancellationException) {
            throw e
        } catch (e: ManualRetryBudgetSpentException) {
            _retranscribe.update { it.failed(RetranscribeFailure.BudgetSpent) }
            return
        } catch (e: Throwable) {
            _retranscribe.update {
                it.failed(RetranscribeFailure.Cloud(e.asBatchTranscriptionProblem()))
            }
            return
        }

        // Queued from here on, and persisted: whatever the pass below does, the
        // request will be retried. The band stays on "running" through the
        // pass — the drain below is what runs this recording.
        drainAndSettle()
    }

    /**
     * Run the queue now and say where this recording ended up: gone from the
     * queue is the one unambiguous "it worked"; still there is "waiting", with
     * the pass's reason (or "didn't finish this time") above it.
     */
    private suspend fun drainAndSettle() {
        val failure = try {
            container.backfiller.drain().failure
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            e
        }
        val status = backfillStatus(default = BackfillStatus.Queued(null))
        if (status != BackfillStatus.None) {
            // A cancellation is not a reason worth reading: it means the app
            // went away mid-pass, which the foreground drain takes care of.
            val problem = failure?.takeUnless { it is CancellationException }?.asBatchTranscriptionProblem()
            // `observed` brings the last-attempt time, and a pass that has
            // meanwhile picked the request up again.
            _retranscribe.update { it.stillQueued(problem).observed(status) }
            return
        }

        // The run landed: the cloud now holds a different transcript for this
        // recording than the one on screen.
        refreshMeta()
        val remaining = retriesRemaining()
        _retranscribe.update { it.settled(remaining) }
        offerRetranscribeChips()
    }

    /**
     * The audio to re-transcribe, or null when there is none to be had.
     *
     * A recording made on another device — or on this one with "keep audio on
     * this phone" off — has nothing local to send, so it is downloaded first,
     * **through the player this screen already has**. That is deliberate reuse
     * rather than a second downloader: [PlaybackController.download] writes into
     * the same [com.pathors.parley.playback.LocalAudioStore] file the backfiller
     * would read, reports its progress in the bar pinned at the top of this
     * screen, and leaves the audio behind playable. A private copy would
     * duplicate an hour of audio to say less.
     *
     * The backfiller copies rather than moves what it is given, so the player
     * keeps reading this file throughout.
     */
    private suspend fun obtainAudio(): File? {
        val store = container.localAudio
        val local = store.audioFile(recordingId)
        if (withContext(Dispatchers.IO) { local.isFile && local.length() > 0L }) return local
        if (_state.value.meta?.hasAudio != true) return null

        playback.download()
        // The controller settles on exactly one of these two, and the bar is
        // drawing the progress in between.
        playback.state.first {
            it.phase == PlaybackPhase.READY || it.phase == PlaybackPhase.FAILED
        }
        return withContext(Dispatchers.IO) {
            local.takeIf { it.isFile && it.length() > 0L }
        }
    }

    /**
     * Re-read the meta without blanking the screen.
     *
     * [load] flips `loading` and empties the transcript for as long as the fetch
     * takes, which is right on arrival and wrong here: the reader is mid-page on
     * a transcript that is still correct, and a spinner would take it away to
     * replace it with the same words plus a few. A failed refresh keeps what is
     * on screen for the same reason.
     *
     * The player is untouched on purpose — see [openPlayer].
     */
    private suspend fun refreshMeta() {
        val meta = runCatching { fetchMeta() }.getOrNull()
            ?: return
        _state.value = fromMeta(meta)
    }

    private suspend fun retriesRemaining(): Int =
        runCatching { container.backfiller.retriesRemaining(recordingId) }.getOrDefault(0)

    /**
     * Ask the queue and the ledger where this recording stands, and the store
     * whether there is anything to send.
     *
     * Runs after every meta load because all three answers can have changed
     * elsewhere: a background pass may have drained the queue, and "is the audio
     * here" is a question about the filesystem.
     */
    private suspend fun syncRetranscribe() {
        if (DemoMode.isActive) {
            _retranscribe.update {
                it.copy(retriesRemaining = DEMO_RETRIES_REMAINING, audioObtainable = true)
            }
            return
        }
        val inCloud = _state.value.meta?.hasAudio == true
        val status = backfillStatus(default = BackfillStatus.None)
        val remaining = retriesRemaining()
        val onPhone = withContext(Dispatchers.IO) { container.localAudio.has(recordingId) }
        _retranscribe.update {
            // `observed` only ever moves an idle, failed or queued screen; a
            // request this ViewModel is in the middle of making owns the phase.
            it.observed(status).copy(
                retriesRemaining = remaining,
                audioObtainable = onPhone || inCloud,
            )
        }
    }

    /**
     * Point the player at this recording once the meta has arrived.
     *
     * The meta's `durationMs` is what the scrubber is scaled by until the
     * engine has opened the file and can report its own: an Ogg's true length
     * is only known after its last page, so a player that waited for it would
     * draw a zero-width timeline for the first moment of every screen.
     */
    private fun openPlayer() {
        val duration = _state.value.meta?.durationMs?.toLong() ?: 0L
        playback.open(recordingId, duration)
    }

    companion object {

        /**
         * What a screenshot run shows in the overflow menu. Mid-range on
         * purpose: 3 would look like an untouched recording and 0 would put the
         * screenshot in the one state where the action is disabled.
         */
        private const val DEMO_RETRIES_REMAINING = 2

        /** A hair past the ✓ hold's end, so the redraw lands after it rather than on it. */
        private const val LAP_REDRAW_SLACK_MS = 50L

        /**
         * The suggestion waiting on [meta], as the card offers it, and where
         * its answer goes: the synced meta's own for a cloud recording, or —
         * [sample] given — the sample's store, which composes the manifest's
         * suggestion with [folders].
         */
        internal suspend fun pendingOffer(
            recordingId: String,
            meta: RecordingMeta,
            folders: List<CloudFolder>,
            sample: SampleFilingTarget?,
        ): Pair<PendingFiling, FilingTarget>? {
            val (suggestion, target) = if (sample == null) {
                val pending = meta.filingSuggestion ?: return null
                pending to FilingTarget.Cloud(recordingId)
            } else {
                val pending = sample.pendingFilingSuggestion(folders) ?: return null
                pending to FilingTarget.Sample(sample)
            }
            val offer = PendingFiling(
                suggestion = suggestion,
                currentTitle = meta.title,
                currentFolderId = LibraryFolders.liveFolderId(meta.folderId, folders),
                folders = folders,
            )
            return offer to target
        }

        /** A folder "created" in a screenshot run: in memory, like everything else there. */
        private fun demoFolder(name: String): CloudFolder = CloudFolder(id = CloudClient.newCloudId(), name = name)

        /** The loaded state for a meta, or the failed state when there is none. */
        internal fun fromMeta(meta: RecordingMeta?): UiState = when (meta) {
            null -> UiState(loading = false, failure = DetailLoadFailure.SERVER)
            else -> UiState(
                loading = false,
                meta = meta,
                brief = meta.brief,
                findings = readFindings(meta),
                actionItems = readActionItems(meta),
            )
        }

        /** What a failed meta fetch says to the reader. See [DetailLoadFailure]. */
        internal fun classifyLoadFailure(error: Throwable): DetailLoadFailure {
            val cloud = error as? CloudException ?: return DetailLoadFailure.NETWORK
            return when {
                cloud.isAuthExpired -> DetailLoadFailure.SIGNED_OUT
                cloud.isForbidden -> DetailLoadFailure.FORBIDDEN
                cloud.isNotFound -> DetailLoadFailure.NOT_FOUND
                cloud.status == HTTP_TIMEOUT -> DetailLoadFailure.NETWORK
                else -> DetailLoadFailure.SERVER
            }
        }

        private const val HTTP_TIMEOUT = 408

        fun factory(
            container: AppContainer,
            recordingId: String,
            orgId: String?,
            context: Context,
        ) = viewModelFactory {
            initializer {
                RecordingDetailViewModel(
                    container = container,
                    recordingId = recordingId,
                    orgId = orgId,
                    context = context.applicationContext,
                )
            }
        }

        /**
         * The findings, in timeline order — iOS `RecordingMeta.findings`. A
         * finding needs a title to be a highlight (the older `label` / `text`
         * spellings are accepted); one without a moment sits at 0.
         */
        internal fun readFindings(meta: RecordingMeta): List<FindingRow> =
            (meta.raw["findings"] as? JsonArray).orEmptyIndexedObjects().mapNotNull { (index, obj) ->
                val title = obj.text("title") ?: obj.text("label") ?: obj.text("text")
                    ?: return@mapNotNull null
                FindingRow(
                    id = obj.text("id") ?: "finding-$index",
                    title = title,
                    detail = obj.text("detail") ?: obj.text("description").orEmpty(),
                    atMs = (obj.number("atMs") ?: 0.0).toLong().coerceAtLeast(0L),
                    severity = obj.text("severity"),
                )
            }.sortedBy { it.atMs }

        /**
         * The action items, in the order the analysis wrote them — which is the
         * order of importance, not of time, so they are not re-sorted. iOS
         * `RecordingMeta.actionItems`.
         */
        internal fun readActionItems(meta: RecordingMeta): List<ActionItemRow> =
            (meta.raw["actionItems"] as? JsonArray).orEmptyIndexedObjects().mapNotNull { (index, obj) ->
                val text = (obj.text("text") ?: obj.text("title"))?.takeIf { it.isNotBlank() }
                    ?: return@mapNotNull null
                ActionItemRow(
                    id = obj.text("id") ?: "action-$index",
                    text = text,
                    done = obj.bool("done") ?: false,
                    atMs = obj.number("atMs")?.toLong()?.coerceAtLeast(0L),
                )
            }

        /**
         * The objects of an array with their positions in it — the position is
         * the id fallback, so it has to be the raw one, counting entries that
         * are skipped.
         */
        private fun JsonArray?.orEmptyIndexedObjects(): List<Pair<Int, JsonObject>> =
            this?.mapIndexedNotNull { index, element -> (element as? JsonObject)?.let { index to it } }
                .orEmpty()

        private fun JsonObject.text(key: String): String? =
            (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() }

        private fun JsonObject.number(key: String): Double? =
            (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toDoubleOrNull()

        private fun JsonObject.bool(key: String): Boolean? =
            (this[key] as? JsonPrimitive)?.content?.toBooleanStrictOrNull()
    }
}
