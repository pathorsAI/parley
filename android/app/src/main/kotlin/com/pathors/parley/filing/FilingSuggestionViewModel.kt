package com.pathors.parley.filing

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.pathors.parley.AppContainer
import com.pathors.parley.cloud.CloudFolder
import com.pathors.parley.kit.FilingSuggestion
import com.pathors.parley.kit.GettingStartedStep
import com.pathors.parley.kit.TranscriptSegment
import com.pathors.parley.library.SaveDestination
import com.pathors.parley.meeting.MeetingState
import com.pathors.parley.screenshot.DemoMode
import com.pathors.parley.ui.speakerLabel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * The meeting screen's handle on [FilingSuggestionModel]. Scoped to the meeting
 * destination, so a rotation keeps the offer and leaving the screen drops it —
 * the pass is best-effort, and an offer for a meeting nobody is looking at any
 * more is not worth holding.
 *
 * Skip's flag write is the one thing that outlives the screen: the screen
 * leaves a beat after Skip, and the write is launched on the app's scope so the
 * departure does not cancel it.
 */
class FilingSuggestionViewModel(
    private val model: FilingSuggestionModel,
    destination: Flow<SaveDestination>,
    private val backgroundScope: CoroutineScope,
) : ViewModel() {

    val state: StateFlow<FilingUiState> = model.state

    /**
     * The default save location, held warm so the skip rule can be read the
     * moment the meeting finishes rather than after a disk read.
     */
    private val destination: StateFlow<SaveDestination> =
        destination.stateIn(viewModelScope, SharingStarted.Eagerly, SaveDestination.PERSONAL_ROOT)

    /** Run the pass for a finished meeting, once. Safe to call on every recomposition. */
    fun consider(finished: MeetingState.Finished, segments: List<TranscriptSegment>) {
        val spoken = FilingSuggestionModel.spoken(segments)
        val skip = FilingSuggestionModel.skipReason(finished, destination.value, spoken, DemoMode.isActive)
        val id = finished.recordingId.orEmpty()
        if (model.claim(id, skip)) viewModelScope.launch { model.run(id, spoken) }
    }

    fun acceptSuggested() {
        viewModelScope.launch { model.acceptSuggested() }
    }

    /**
     * The Adjust sheet's Save. A failed push keeps the sheet up with the edits
     * intact ([onClosed] is not called); a push that landed retires the offer;
     * a Save that found nothing to change leaves through [skip], which still
     * lands `filingSuggested` for the desktop.
     */
    fun save(title: String, folder: FolderTarget?, onClosed: () -> Unit) {
        viewModelScope.launch {
            val pushed = model.apply(title, folder)
            if (model.state.value.writeFailed) return@launch
            if (pushed) model.forget() else skip()
            onClosed()
        }
    }

    /** The user said no: the offer goes now, the flag is written behind it. */
    fun skip() {
        val id = model.forget()?.takeIf { it.isNotEmpty() } ?: return
        backgroundScope.launch { model.markAnswered(id) }
    }

    fun seedDemo(
        recordingId: String,
        suggestion: FilingSuggestion,
        currentTitle: String,
        folders: List<CloudFolder>,
    ) = model.seedDemo(recordingId, suggestion, currentTitle, folders)

    companion object {
        fun factory(container: AppContainer, context: Context) = viewModelFactory {
            initializer {
                val app = context.applicationContext
                FilingSuggestionViewModel(
                    model = FilingSuggestionModel(
                        cloud = container.cloud,
                        speakerLabel = { speakerLabel(app, it.speaker) },
                        onFiled = { container.gettingStarted.mark(GettingStartedStep.FILED) },
                    ),
                    destination = container.saveLocation.destination,
                    backgroundScope = container.appScope,
                )
            }
        }
    }
}
