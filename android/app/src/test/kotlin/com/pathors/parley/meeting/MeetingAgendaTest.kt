package com.pathors.parley.meeting

import com.pathors.parley.kit.CloudDraftTodo
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The agenda of the draft a meeting started from is the meeting's to-do list:
 * the desktop's `toggleAgendaItem` rules (`src/lib/meeting/agenda.ts`), and
 * the draft's done state carried into the meeting as it was.
 */
class MeetingAgendaTest {

    @After
    fun reset() = MeetingDraft.clear()

    @Test
    fun `ticking is the user's, with no time point`() {
        val ticked = MeetingAgenda.toggle(AgendaItem(id = "a", text = "Pricing"))
        assertTrue(ticked.done)
        assertEquals(MeetingAgenda.BY_USER, ticked.doneBy)
        assertNull(ticked.doneAtMs)
        assertFalse(ticked.aiDismissed)
    }

    @Test
    fun `unticking the user's tick drops who ticked it`() {
        val item = AgendaItem(id = "a", text = "Pricing", done = true, doneBy = MeetingAgenda.BY_USER)
        assertEquals(AgendaItem(id = "a", text = "Pricing"), MeetingAgenda.toggle(item))
    }

    @Test
    fun `unticking the AI's tick dismisses it, and forgets where it was heard`() {
        val item = AgendaItem(id = "a", text = "Pricing", done = true, doneBy = MeetingAgenda.BY_AI, doneAtMs = 42_000)
        val unticked = MeetingAgenda.toggle(item)
        assertFalse(unticked.done)
        assertNull(unticked.doneBy)
        assertNull(unticked.doneAtMs)
        assertTrue(unticked.aiDismissed)
    }

    @Test
    fun `ticking a dismissed item again is the user's, and stays dismissed`() {
        val item = AgendaItem(id = "a", text = "Pricing", aiDismissed = true)
        val ticked = MeetingAgenda.toggle(item)
        assertTrue(ticked.done)
        assertEquals(MeetingAgenda.BY_USER, ticked.doneBy)
        assertTrue(ticked.aiDismissed)
    }

    @Test
    fun `a draft's tick unticks plainly`() {
        // A draft's done item carries no doneBy: unticking it is not dismissing an AI tick.
        val fromDraft = MeetingAgenda.fromDraft(listOf(CloudDraftTodo(id = "a", text = "Pricing", done = true))).single()
        assertEquals(AgendaItem(id = "a", text = "Pricing"), MeetingAgenda.toggle(fromDraft))
    }

    @Test
    fun `toggling by id changes that item only`() {
        val agenda = listOf(AgendaItem(id = "a", text = "One"), AgendaItem(id = "b", text = "Two"))
        val after = MeetingAgenda.toggle(agenda, "b")
        assertEquals(agenda[0], after[0])
        assertTrue(after[1].done)
        assertEquals(agenda, MeetingAgenda.toggle(agenda, "missing"))
    }

    @Test
    fun `the meeting starts with the draft's agenda as the draft had it`() {
        val agenda = MeetingAgenda.fromDraft(
            listOf(
                CloudDraftTodo(id = "a", text = "Renewal terms", done = true),
                CloudDraftTodo(id = "b", text = "Seats"),
            ),
        )
        assertEquals(
            listOf(
                AgendaItem(id = "a", text = "Renewal terms", done = true),
                AgendaItem(id = "b", text = "Seats"),
            ),
            agenda,
        )
    }

    @Test
    fun `a tick lands in the meeting's choices, and goes with them`() {
        MeetingDraft.takeDraft(
            MeetingChoices(
                title = "Acme renewal",
                draftId = "draft-1",
                agenda = listOf(AgendaItem(id = "a", text = "Pricing"), AgendaItem(id = "b", text = "Seats")),
            ),
        )
        MeetingDraft.toggleAgendaItem("a")
        val agenda = MeetingDraft.choices.value.agenda
        assertTrue(agenda[0].done)
        assertFalse(agenda[1].done)
        MeetingDraft.clear()
        assertTrue(MeetingDraft.choices.value.agenda.isEmpty())
    }
}
