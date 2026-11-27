package com.pathors.parley.meeting

import com.pathors.parley.kit.CloudDraftTodo
import kotlinx.serialization.Serializable

/**
 * One item of a meeting's agenda, as the meeting tracks it — the desktop's
 * `TodoItem`. A meeting started from a meeting draft takes the draft's agenda
 * (its `todos`) as a to-do list the user ticks while it runs; the ticks belong
 * to the meeting, never to the draft, and are saved into the recording's meta
 * as `agenda` ([com.pathors.parley.upload.MeetingUploader.buildMeta]).
 *
 * Serializable because it rides the pending-upload manifest
 * ([com.pathors.parley.upload.PendingUpload.agenda]) until the upload lands.
 */
@Serializable
data class AgendaItem(
    val id: String,
    val text: String,
    val done: Boolean = false,
    /**
     * Who ticked it: [MeetingAgenda.BY_USER] or [MeetingAgenda.BY_AI]. Null
     * while unticked, and on a tick the draft already carried (the desktop
     * leaves it absent on items saved before the field existed).
     */
    val doneBy: String? = null,
    /** Where in the recording the AI heard it covered (ms). Only on AI ticks; the phone never sets it. */
    val doneAtMs: Long? = null,
    /** The user unticked an item the AI had ticked, so the AI leaves it alone from then on. */
    val aiDismissed: Boolean = false,
)

/** The desktop's agenda rules (`src/lib/meeting/agenda.ts`), as pure functions. */
object MeetingAgenda {
    const val BY_USER = "user"
    const val BY_AI = "ai"

    /**
     * A draft's agenda as the meeting starts with it: every item, with the
     * done state the draft had — the desktop moves the draft's `todos` into
     * the meeting's as they are (`prepFromDraft`).
     */
    fun fromDraft(todos: List<CloudDraftTodo>): List<AgendaItem> =
        todos.map { AgendaItem(id = it.id, text = it.text, done = it.done) }

    /**
     * The user's tap on one item — the desktop's `toggleAgendaItem`. Ticking
     * is the user's (no time point); unticking drops who ticked it and where,
     * and unticking one the AI ticked marks it dismissed, so a later AI pass
     * leaves it alone.
     */
    fun toggle(item: AgendaItem): AgendaItem {
        val rest = item.copy(doneBy = null, doneAtMs = null)
        return when {
            !item.done -> rest.copy(done = true, doneBy = BY_USER)
            item.doneBy == BY_AI -> rest.copy(done = false, aiDismissed = true)
            else -> rest.copy(done = false)
        }
    }

    /** [toggle] applied to the item with [id]; the others, and a list without it, unchanged. */
    fun toggle(agenda: List<AgendaItem>, id: String): List<AgendaItem> =
        agenda.map { if (it.id == id) toggle(it) else it }
}
