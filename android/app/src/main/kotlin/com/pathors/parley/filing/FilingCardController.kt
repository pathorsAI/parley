package com.pathors.parley.filing

import com.pathors.parley.cloud.CloudFolder
import com.pathors.parley.kit.FilingFolderSuggestion
import com.pathors.parley.kit.FilingMotion
import com.pathors.parley.library.FolderDirectory
import kotlinx.coroutines.CancellationException
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
 * The card is a form with one commit. A chip tap, Return in the name field,
 * and the picker's confirm only change what is selected; [save] is the one
 * write. A tester filed a meeting into the wrong customer when a single tap
 * on a chip used to be the whole answer.
 *
 * @param scope where the writes run: the owning ViewModel's.
 * @param backgroundScope where Skip's flag write runs — the app's, so a screen
 *   that leaves right after Skip does not cancel it.
 * @param onWritten told after every write that landed, so the owning screen
 *   can bring what it shows (the title, the folder, the folder list) into
 *   step with the model's state.
 * @param loadDirectory the organizations "Choose another…" offers beside the
 *   personal folders. Read the first time the picker opens; none by default.
 */
class FilingCardController(
    val model: FilingSuggestionModel,
    private val scope: CoroutineScope,
    private val backgroundScope: CoroutineScope,
    private val onWritten: () -> Unit = {},
    private val loadDirectory: suspend () -> FolderDirectory = { FolderDirectory() },
) {
    val state: StateFlow<FilingUiState> = model.state

    /** The guide's hooks: see [FilingCardCues]. */
    val cues: FilingCardCues = FilingCardCues(scope)

    private val _directory = MutableStateFlow(FolderDirectory())

    /** The organizations and their folders, once the picker has asked for them. */
    val directory: StateFlow<FolderDirectory> = _directory.asStateFlow()

    private var directoryLoad: Job? = null

    /** A chip: select it, or unselect it when it is the selected one. Writes nothing. */
    fun toggle(chip: FilingFolderSuggestion) = model.pick(state.value.toggled(chip))

    /** The picker's confirm: select that place. Writes nothing. */
    fun choose(target: FolderTarget, label: String) = model.pick(FolderPick.Chosen(target, label))

    /**
     * Save: the name as the field shows it (null = the proposed one) and the
     * selected folder, in one write.
     */
    fun save(title: String?) {
        val current = state.value
        val name = title?.trim()?.takeIf { it.isNotEmpty() } ?: current.proposedTitle
        scope.launch {
            if (model.save(name)) onWritten()
        }
    }

    /**
     * The picker's "New folder": make it, in the personal library, for the
     * picker to select. Throws when it could not be made, so the picker keeps
     * the name on screen with its error.
     */
    suspend fun createFolder(name: String): CloudFolder {
        val folder = model.createFolder(name)
        onWritten()
        return folder
    }

    /** The user said no: the card goes now, the answer is written behind it. */
    fun skip() {
        cues.closePicker()
        val target = model.forget() ?: return
        backgroundScope.launch { model.markAnswered(target) }
    }

    /** GuideBar hook: wash the card for 1.2 s. */
    fun wash() = cues.wash()

    /** GuideBar hook, and "Choose another…": open the picker, fetching the organizations once. */
    fun openPicker() {
        cues.openPicker()
        if (directoryLoad != null) return
        directoryLoad = scope.launch {
            try {
                _directory.value = loadDirectory()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                // Best-effort: the personal folders are still on offer without it.
            }
        }
    }

    fun closePicker() = cues.closePicker()
}
