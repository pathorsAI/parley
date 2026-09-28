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
 * departure does not cancel it (see [FilingCardController]).
 */
class FilingSuggestionViewModel(
    private val model: FilingSuggestionModel,
    destination: Flow<SaveDestination>,
    backgroundScope: CoroutineScope,
) : ViewModel() {

    /** What the card does — accept, rename, file, pick, skip — and the guide's hooks. */
    val card = FilingCardController(model, viewModelScope, backgroundScope)

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
