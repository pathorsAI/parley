package com.pathors.parley.meeting

import com.pathors.parley.library.SaveDestination
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * A meeting draft's 開始 loads the draft into the next meeting's choices, as
 * the desktop's `takeDraft` loads it into the prep; a start that does not
 * happen lets them go again, and leaves choices typed on the record screen
 * alone.
 */
class MeetingDraftTest {

    private val fromDraft = MeetingChoices(
        title = "Acme renewal",
        folder = ChosenFolder(SaveDestination(folderId = "f-acme"), "Acme"),
        meetingContext = "They want a discount.",
        draftId = "draft-1",
    )

    @After
    fun reset() = MeetingDraft.clear()

    @Test
    fun `taking a draft makes its name, folder and context the next meeting's`() {
        MeetingDraft.takeDraft(fromDraft)
        val choices = MeetingDraft.choices.value
        assertEquals("Acme renewal", choices.typedTitle)
        assertEquals("f-acme", choices.folder?.destination?.folderId)
        assertEquals("They want a discount.", choices.meetingContext)
        assertEquals("draft-1", choices.draftId)
    }

    @Test
    fun `a draft's start that did not happen lets the draft go`() {
        MeetingDraft.takeDraft(fromDraft)
        MeetingDraft.dropDraft()
        assertEquals(MeetingChoices(), MeetingDraft.choices.value)
    }

    @Test
    fun `dropping a draft leaves a name typed on the record screen`() {
        MeetingDraft.setTitle("Standup")
        MeetingDraft.dropDraft()
        assertEquals("Standup", MeetingDraft.choices.value.title)
        assertNull(MeetingDraft.choices.value.draftId)
    }
}
