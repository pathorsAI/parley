package com.pathors.parley.filing

import com.pathors.parley.kit.FilingFolderSuggestion
import com.pathors.parley.kit.FilingMotion
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * The two things something *outside* the filing card can ask of it — the
 * hooks a guide (the onboarding GuideBar) needs to say "look here":
 *
 * - [wash]: tint the card for [FilingMotion.WASH_MS] (1.2 s), fading in and
 *   out — iOS `FilingSuggestionCard(highlighted:)`.
 * - [openPicker]: open "Choose another…", the folder picker with the
 *   suggested folders first.
 *
 * Held by the screen's ViewModel rather than by the card, so a guide that
 * lives beside the card (not inside it) can drive it, and so a rotation keeps
 * an open picker open.
 */
class FilingCardCues(private val scope: CoroutineScope) {
    private val _washed = MutableStateFlow(false)

    /** Whether the card is washed in the tint right now. */
    val washed: StateFlow<Boolean> = _washed.asStateFlow()

    private val _choosing = MutableStateFlow(false)

    /** Whether the folder picker is up. */
    val choosing: StateFlow<Boolean> = _choosing.asStateFlow()

    private var washJob: Job? = null

    /**
     * Wash the card for [durationMs]. Asking again while it is washed restarts
     * the clock rather than stacking a second wash.
     */
    fun wash(durationMs: Long = FilingMotion.WASH_MS) {
        washJob?.cancel()
        _washed.value = true
        washJob = scope.launch {
            delay(durationMs)
            _washed.value = false
        }
    }

    fun openPicker() {
        _choosing.value = true
    }

    fun closePicker() {
        _choosing.value = false
    }
}

/**
 * Everything the filing card can do, bound to one [FilingSuggestionModel] and
 * the scopes it runs in. Shared by the meeting screen and the recording page,
 * which differ only in how the offer arrives (a pass run on the spot, or a
 * suggestion already pending on the recording) — the answers are the same.
 *
 * Every write goes through [FilingSuggestionModel.apply], one at a time, so a
 * rename followed by a chip tap is two pushes in order, never two racing.
 *
 * @param scope where the writes run: the owning ViewModel's.
 * @param backgroundScope where Skip's flag write runs — the app's, so a screen
 *   that leaves right after Skip does not cancel it.
 * @param onWritten told after every write that landed, so the owning screen
 *   can bring what it shows (the title, the folder, the folder list) into
 *   step with the model's state.
 */
class FilingCardController(
    val model: FilingSuggestionModel,
    private val scope: CoroutineScope,
    private val backgroundScope: CoroutineScope,
    private val onWritten: () -> Unit = {},
) {
    val state: StateFlow<FilingUiState> = model.state

    /** The guide's hooks: see [FilingCardCues]. */
    val cues: FilingCardCues = FilingCardCues(scope)

    /**
     * Accept: the name as the field shows it (or the proposed one, when the
     * field was left alone) and the first chip, in one push.
     */
    fun accept(title: String?) {
        val current = state.value
        val name = title?.trim()?.takeIf { it.isNotEmpty() } ?: current.proposedTitle
        write(name, current.proposedFolder?.let(FolderTarget::of))
    }

    /** Return in the title field: rename, and leave the folder half on offer. */
    fun rename(title: String) = write(title, null)

    /** A chip: file into that folder, and leave the name to its own answer. */
    fun file(folder: FilingFolderSuggestion) = write(null, FolderTarget.of(folder))

    /** The picker's pick. Filed exactly as a chip would be. */
    fun pick(target: FolderTarget) = write(null, target)

    /**
     * The picker's "New folder": create it and file into it. Suspends so the
     * picker can keep the name on screen with its error when the write fails.
     */
    suspend fun create(name: String): Boolean {
        val landed = model.apply(null, FolderTarget.New(name))
        if (landed) onWritten()
        return landed
    }

    /** The user said no: the card goes now, the answer is written behind it. */
    fun skip() {
        cues.closePicker()
        val target = model.forget() ?: return
        backgroundScope.launch { model.markAnswered(target) }
    }

    /** GuideBar hook: wash the card for 1.2 s. */
    fun wash() = cues.wash()

    /** GuideBar hook: open "Choose another…". */
    fun openPicker() = cues.openPicker()

    private fun write(title: String?, folder: FolderTarget?) {
        scope.launch {
            if (model.apply(title, folder)) onWritten()
        }
    }
}
