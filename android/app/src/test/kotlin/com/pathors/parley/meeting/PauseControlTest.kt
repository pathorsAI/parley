package com.pathors.parley.meeting

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PauseControlTest {

    private val finished = MeetingState.Finished(recordingId = "r1", pendingUpload = false, dropped = false)

    @Test
    fun `pausing a recording pauses it`() {
        assertEquals(MeetingState.Paused, MeetingState.Recording.after(PauseToggle.PAUSE))
    }

    @Test
    fun `resuming a paused meeting records again`() {
        assertEquals(MeetingState.Recording, MeetingState.Paused.after(PauseToggle.RESUME))
    }

    @Test
    fun `resuming a recording does not apply`() {
        assertNull(MeetingState.Recording.after(PauseToggle.RESUME))
    }

    @Test
    fun `pausing a paused meeting does not apply`() {
        assertNull(MeetingState.Paused.after(PauseToggle.PAUSE))
    }

    @Test
    fun `pausing while connecting does not apply`() {
        assertNull(MeetingState.Connecting.after(PauseToggle.PAUSE))
    }

    @Test
    fun `nothing toggles after stop`() {
        for (toggle in PauseToggle.entries) {
            assertNull(MeetingState.Finishing.after(toggle))
            assertNull(finished.after(toggle))
        }
    }

    @Test
    fun `connecting, recording and paused are in progress`() {
        assertTrue(MeetingState.Connecting.isInProgress)
        assertTrue(MeetingState.Recording.isInProgress)
        assertTrue(MeetingState.Paused.isInProgress)
    }

    @Test
    fun `idle and every ending are not in progress`() {
        assertFalse(MeetingState.Idle.isInProgress)
        assertFalse(MeetingState.Finishing.isInProgress)
        assertFalse(MeetingState.Uploading.isInProgress)
        assertFalse(finished.isInProgress)
        assertFalse(MeetingState.Failed(MeetingFailure.UNKNOWN).isInProgress)
    }
}
