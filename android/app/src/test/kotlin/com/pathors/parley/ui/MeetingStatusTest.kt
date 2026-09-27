package com.pathors.parley.ui

import com.pathors.parley.R
import com.pathors.parley.audio.MicRecoveryState
import com.pathors.parley.kit.CaptureRecovery
import com.pathors.parley.meeting.MeetingFailure
import com.pathors.parley.meeting.MeetingState
import com.pathors.parley.meeting.TranscriptionIssue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The pure decisions behind the live meeting screen's status lines: which
 * microphone line wins, and which outcome a finished meeting shows.
 */
class MeetingStatusTest {

    private val taken = MicRecoveryState.Lost(CaptureRecovery.Loss.TakenBySystem)

    @Test
    fun `a lost microphone outranks silence and the back notice`() {
        val line = micLine(taken, silenced = true, back = true)
        assertEquals(MicLine.Lost(CaptureRecovery.Loss.TakenBySystem), line)
        assertTrue(line!!.alarming)
    }

    @Test
    fun `recovering outranks silence and the back notice`() {
        assertSame(MicLine.Recovering, micLine(MicRecoveryState.Recovering, silenced = true, back = true))
    }

    @Test
    fun `while holding, silence outranks the back notice`() {
        assertSame(MicLine.Silenced, micLine(MicRecoveryState.Holding, silenced = true, back = true))
    }

    @Test
    fun `the back notice is the only line that is not alarming`() {
        val line = micLine(MicRecoveryState.Holding, silenced = false, back = true)
        assertSame(MicLine.Back, line)
        assertFalse(line!!.alarming)
        assertTrue(MicLine.Recovering.alarming)
        assertTrue(MicLine.Silenced.alarming)
    }

    @Test
    fun `a healthy microphone shows no line`() {
        assertNull(micLine(MicRecoveryState.Holding, silenced = false, back = false))
    }

    @Test
    fun `only connecting and recording are live`() {
        assertTrue(isLive(MeetingState.Connecting))
        assertTrue(isLive(MeetingState.Recording))
        assertFalse(isLive(MeetingState.Idle))
        assertFalse(isLive(MeetingState.Finishing))
        assertFalse(isLive(MeetingState.Uploading))
        assertFalse(isLive(finished(interruptedBy = null)))
        assertFalse(isLive(MeetingState.Failed(MeetingFailure.UNKNOWN)))
    }

    @Test
    fun `only a meeting the user did not end counts as interrupted`() {
        val interrupted = finished(interruptedBy = MeetingFailure.MIC_UNAVAILABLE)
        assertSame(interrupted, interruptedFinish(interrupted))
        assertNull(interruptedFinish(finished(interruptedBy = null)))
        assertNull(interruptedFinish(MeetingState.Recording))
        assertNull(interruptedFinish(MeetingState.Failed(MeetingFailure.STORAGE_FULL)))
    }

    @Test
    fun `a finished meeting says whether its audio is queued or uploaded`() {
        assertEquals(R.string.meeting_queued, finishedOutcomeRes(finished(pendingUpload = true)))
        assertEquals(R.string.meeting_uploaded, finishedOutcomeRes(finished(pendingUpload = false)))
    }

    @Test
    fun `quota has its own banner and relay failures share one`() {
        assertEquals(R.string.meeting_issue_quota, transcriptionIssueRes(TranscriptionIssue.QUOTA_EXCEEDED))
        assertEquals(R.string.meeting_issue_error, transcriptionIssueRes(TranscriptionIssue.RELAY_ERROR))
        assertEquals(R.string.meeting_issue_error, transcriptionIssueRes(TranscriptionIssue.RELAY_CLOSED))
    }

    private fun finished(
        interruptedBy: MeetingFailure? = null,
        pendingUpload: Boolean = false,
    ) = MeetingState.Finished(
        recordingId = "rec",
        pendingUpload = pendingUpload,
        dropped = false,
        interruptedBy = interruptedBy,
    )
}
