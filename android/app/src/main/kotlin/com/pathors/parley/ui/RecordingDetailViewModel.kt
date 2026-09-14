package com.pathors.parley.ui

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.pathors.parley.AppContainer
import com.pathors.parley.cloud.BatchTranscriptionProblem
import com.pathors.parley.cloud.RecordingMeta
import com.pathors.parley.cloud.asBatchTranscriptionProblem
import com.pathors.parley.playback.PlaybackController
import com.pathors.parley.playback.PlaybackPhase
import com.pathors.parley.playback.PlaybackState
import com.pathors.parley.screenshot.DemoMode
import com.pathors.parley.upload.ManualRetryBudgetSpentException
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
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
    val title: String,
    val detail: String,
    val atMs: Long?,
    val severity: String?,
)

/** One action item (`src/lib/types.ts` `ActionItem`). */
data class ActionItemRow(
    val text: String,
    val rationale: String,
    val done: Boolean,
)

/**
 * Why "transcribe again" cannot be offered right now.
 *
 * A code rather than a sentence, the same split [com.pathors.parley.playback.PlaybackFailure]
 * makes: the ViewModel decides *whether* the action is available and the screen
 * owns the bilingual copy for each reason.
 */
enum class RetranscribeBlock {
    /** A run for this recording is queued or in flight. */
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
}

/**
 * Everything the "transcribe again" entry point needs, in one snapshot.
 *
 * Split out of [RecordingDetailViewModel.UiState] rather than folded into it
 * because the two change on completely different clocks — the meta is fetched
 * once, this moves through a confirmation, a queue and possibly a failure — and
 * because a state machine that is its own value is one a test can drive without
 * a container, a cloud or a coroutine.
 */
data class RetranscribeState(
    val phase: Phase = Phase.IDLE,
    /** Hand-triggered runs left on this recording, 0…3. */
    val retriesRemaining: Int = 0,
    /** Whether audio exists to send — on the phone, or downloadable from the cloud. */
    val audioObtainable: Boolean = false,
    /**
     * The last attempt's complaint, or null. Survives into [Phase.QUEUED]: a run
     * that failed while staying queued is both things at once, and saying only
     * "queued" would hide a quota message the person needs.
     */
    val failure: RetranscribeFailure? = null,
) {

    enum class Phase {
        IDLE,

        /** The confirmation dialog is up. */
        CONFIRMING,

        /** Fetching the audio and enqueuing. Short, but it can involve a download. */
        WORKING,

        /** In the backfill queue: this screen's transcript is going to be replaced. */
        QUEUED,

        /** The attempt did not reach the queue. [failure] says why. */
        FAILED,
    }

    /** Why the action is unavailable, or null when it can be taken. */
    val block: RetranscribeBlock?
        get() = when {
            phase == Phase.WORKING || phase == Phase.QUEUED -> RetranscribeBlock.IN_FLIGHT
            retriesRemaining <= 0 -> RetranscribeBlock.BUDGET_SPENT
            !audioObtainable -> RetranscribeBlock.NO_AUDIO
            else -> null
        }

    val canRequest: Boolean get() = block == null

    /**
     * Whether the inline status band draws at all.
     *
     * [Phase.CONFIRMING] is not on this list on purpose: the dialog is the
     * feedback, and a band that appeared behind it would be describing something
     * that has not been agreed to yet.
     */
    val showsStatus: Boolean
        get() = phase == Phase.WORKING || phase == Phase.QUEUED || failure != null

    /** Whether the band's spinner and "this is happening" line are drawn. */
    val isRunning: Boolean get() = phase == Phase.WORKING || phase == Phase.QUEUED

    // ── transitions ──────────────────────────────────────────────────────────
    //
    // Pure, and all of them here rather than as `copy` calls scattered through
    // the ViewModel: these five lines are the whole contract the screen renders,
    // and they are what the unit test drives.

    fun confirming(): RetranscribeState =
        if (canRequest) copy(phase = Phase.CONFIRMING) else this

    fun dismissed(): RetranscribeState =
        if (phase == Phase.CONFIRMING) copy(phase = Phase.IDLE) else this

    /** The person said yes. Clears the previous complaint — this is a new attempt. */
    fun working(): RetranscribeState = copy(phase = Phase.WORKING, failure = null)

    fun queued(retriesRemaining: Int = this.retriesRemaining): RetranscribeState =
        copy(phase = Phase.QUEUED, retriesRemaining = retriesRemaining, failure = null)

    /**
     * The run landed and the transcript on screen has been replaced: back to
     * idle, with one fewer retry.
     */
    fun settled(retriesRemaining: Int): RetranscribeState =
        copy(phase = Phase.IDLE, retriesRemaining = retriesRemaining, failure = null)

    /**
     * The pass ended without clearing this recording. It stays queued and will
     * be retried, and [problem] — when the pass reported one — says why it
     * stopped, because "still queued" alone reads as progress.
     */
    fun stillQueued(problem: BatchTranscriptionProblem?): RetranscribeState = copy(
        phase = Phase.QUEUED,
        failure = problem?.let { RetranscribeFailure.Cloud(it) },
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
}

class RecordingDetailViewModel(
    private val container: AppContainer,
    private val recordingId: String,
    /**
     * Application context, for the player. Passed in rather than reached for
     * through [AppContainer]: a ViewModel that can see the whole Application is
     * a ViewModel that can leak an Activity by accident.
     */
    context: Context,
) : ViewModel() {

    /**
     * The player for this recording. Built with the screen and released with
     * it — one recording, one engine, and `onCleared` is what guarantees the
     * audio stops when the screen goes away.
     */
    private val playback = PlaybackController(
        context = context,
        cloud = container.cloud,
        store = container.localAudio,
        scope = viewModelScope,
        demo = DemoMode.isActive,
    )

    val playbackState: StateFlow<PlaybackState> = playback.state

    fun togglePlayPause() = playback.togglePlayPause()

    fun seekTo(ms: Long) = playback.seekTo(ms)

    fun setRate(rate: Float) = playback.setRate(rate)

    fun cycleRate() = playback.cycleRate()

    fun downloadAudio() = playback.download()

    override fun onCleared() {
        playback.release()
    }

    data class UiState(
        val loading: Boolean = true,
        val meta: RecordingMeta? = null,
        val findings: List<FindingRow> = emptyList(),
        val actionItems: List<ActionItemRow> = emptyList(),
        val failed: Boolean = false,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private val _retranscribe = MutableStateFlow(RetranscribeState())
    val retranscribe: StateFlow<RetranscribeState> = _retranscribe.asStateFlow()

    init {
        load()
    }

    fun load() {
        if (DemoMode.isActive) {
            _state.value = fromMeta(DemoMode.meta(recordingId))
            openPlayer()
            viewModelScope.launch { syncRetranscribe() }
            return
        }
        viewModelScope.launch {
            _state.value = UiState(loading = true)
            val result = runCatching { container.cloud.recordingMeta(recordingId) }
            _state.value = fromMeta(result.getOrNull())
            openPlayer()
            syncRetranscribe()
        }
    }

    // ── transcribe again ─────────────────────────────────────────────────────

    /** The menu item. Opens the confirmation rather than starting anything. */
    fun askToRetranscribe() = _retranscribe.update { it.confirming() }

    fun dismissRetranscribe() = _retranscribe.update { it.dismissed() }

    /**
     * The confirmation's "Transcribe again": get the audio, queue the run, and
     * drive the queue right now rather than waiting for the next foreground
     * pass — the person is looking at the screen they asked from.
     */
    fun confirmRetranscribe() {
        if (_retranscribe.value.phase != RetranscribeState.Phase.CONFIRMING) return
        _retranscribe.update { it.working() }
        viewModelScope.launch { runRetranscription() }
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

        // Queued from here on: whatever the pass below does, the request is
        // persisted and will be retried, so the screen must say so even if this
        // ViewModel dies in the next second.
        _retranscribe.update { it.queued() }

        val result = runCatching { container.backfiller.drain() }
        val stillQueued = runCatching { container.backfiller.isQueued(recordingId) }
            .getOrDefault(true)
        if (stillQueued) {
            val problem = (result.exceptionOrNull() ?: result.getOrNull()?.failure)
                ?.asBatchTranscriptionProblem()
            _retranscribe.update { it.stillQueued(problem) }
            return
        }

        // The run landed: the cloud now holds a different transcript for this
        // recording than the one on screen.
        refreshMeta()
        val remaining = retriesRemaining()
        _retranscribe.update { it.settled(remaining) }
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
        val meta = runCatching { container.cloud.recordingMeta(recordingId) }.getOrNull()
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
        val queued = runCatching { container.backfiller.isQueued(recordingId) }
            .getOrDefault(false)
        val remaining = retriesRemaining()
        val onPhone = withContext(Dispatchers.IO) { container.localAudio.has(recordingId) }
        _retranscribe.update {
            it.copy(
                // Only ever promotes an idle screen. A confirmation that is open
                // or a request this ViewModel is in the middle of making owns the
                // phase, and must not be overwritten by a queue read that was in
                // flight at the same time.
                phase = if (queued && it.phase == RetranscribeState.Phase.IDLE) {
                    RetranscribeState.Phase.QUEUED
                } else {
                    it.phase
                },
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

        /** The loaded state for a meta, or the failed state when there is none. */
        internal fun fromMeta(meta: RecordingMeta?): UiState = when (meta) {
            null -> UiState(loading = false, failed = true)
            else -> UiState(
                loading = false,
                meta = meta,
                findings = readFindings(meta),
                actionItems = readActionItems(meta),
            )
        }

        fun factory(container: AppContainer, recordingId: String, context: Context) =
            viewModelFactory {
                initializer {
                    RecordingDetailViewModel(
                        container,
                        recordingId,
                        context.applicationContext,
                    )
                }
            }

        internal fun readFindings(meta: RecordingMeta): List<FindingRow> =
            (meta.raw["findings"] as? JsonArray).orEmptyObjects().mapNotNull { obj ->
                val title = obj.text("title") ?: obj.text("label") ?: obj.text("text")
                val detail = obj.text("detail") ?: obj.text("description").orEmpty()
                if (title == null && detail.isEmpty()) return@mapNotNull null
                FindingRow(
                    title = title.orEmpty(),
                    detail = detail,
                    atMs = obj.number("atMs")?.toLong(),
                    severity = obj.text("severity"),
                )
            }

        internal fun readActionItems(meta: RecordingMeta): List<ActionItemRow> =
            (meta.raw["actionItems"] as? JsonArray).orEmptyObjects().mapNotNull { obj ->
                val text = obj.text("text") ?: obj.text("title") ?: return@mapNotNull null
                ActionItemRow(
                    text = text,
                    rationale = obj.text("rationale").orEmpty(),
                    done = obj.bool("done") ?: false,
                )
            }

        private fun JsonArray?.orEmptyObjects(): List<JsonObject> =
            this?.mapNotNull { it as? JsonObject }.orEmpty()

        private fun JsonObject.text(key: String): String? =
            (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() }

        private fun JsonObject.number(key: String): Double? =
            (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toDoubleOrNull()

        private fun JsonObject.bool(key: String): Boolean? =
            (this[key] as? JsonPrimitive)?.content?.toBooleanStrictOrNull()
    }
}
