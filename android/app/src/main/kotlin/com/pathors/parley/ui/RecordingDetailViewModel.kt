package com.pathors.parley.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.pathors.parley.AppContainer
import com.pathors.parley.cloud.RecordingMeta
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
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

class RecordingDetailViewModel(
    private val container: AppContainer,
    private val recordingId: String,
) : ViewModel() {

    data class UiState(
        val loading: Boolean = true,
        val meta: RecordingMeta? = null,
        val findings: List<FindingRow> = emptyList(),
        val actionItems: List<ActionItemRow> = emptyList(),
        val failed: Boolean = false,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    init {
        load()
    }

    fun load() {
        viewModelScope.launch {
            _state.value = UiState(loading = true)
            val result = runCatching { container.cloud.recordingMeta(recordingId) }
            _state.value = result.fold(
                onSuccess = { meta ->
                    UiState(
                        loading = false,
                        meta = meta,
                        findings = readFindings(meta),
                        actionItems = readActionItems(meta),
                    )
                },
                onFailure = { UiState(loading = false, failed = true) },
            )
        }
    }

    companion object {
        fun factory(container: AppContainer, recordingId: String) = viewModelFactory {
            initializer { RecordingDetailViewModel(container, recordingId) }
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
