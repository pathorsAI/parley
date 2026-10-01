package com.pathors.parley.ui

import com.pathors.parley.R
import com.pathors.parley.audio.MicRecoveryState
import com.pathors.parley.kit.CaptureRecovery
import com.pathors.parley.kit.TranscriptSegment
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
    fun `a finished meeting says where its audio went, in iOS's words`() {
        assertEquals(FinishedOutcome.Synced, finishedOutcome(finished()))
        assertEquals(R.string.meeting_uploaded, finishedOutcomeRes(FinishedOutcome.Synced))
        assertEquals(FinishedOutcome.Queued, finishedOutcome(finished(pendingUpload = true)))
        assertEquals(R.string.meeting_sync_failed, finishedOutcomeRes(FinishedOutcome.Queued))
        assertEquals(FinishedOutcome.TooShort, finishedOutcome(finished().copy(dropped = true)))
        assertEquals(R.string.meeting_dropped, finishedOutcomeRes(FinishedOutcome.TooShort))
    }

    @Test
    fun `a 402 says it waits for the quota, not the network`() {
        val waiting = finished(pendingUpload = true).copy(waitingForQuota = true)
        assertEquals(FinishedOutcome.WaitingForQuota, finishedOutcome(waiting))
        assertEquals(R.string.meeting_queued_quota, finishedOutcomeRes(FinishedOutcome.WaitingForQuota))
    }

    @Test
    fun `a recording copied into an org says so`() {
        val shared = finished().copy(sharedToOrgName = "Pathors")
        assertEquals(FinishedOutcome.SharedTo("Pathors"), finishedOutcome(shared))
        assertEquals(R.string.meeting_shared_to, finishedOutcomeRes(FinishedOutcome.SharedTo("Pathors")))
    }

    @Test
    fun `a reconnect is a pause, and only a terminal issue says stopped`() {
        assertEquals(NoticeTone.RECONNECTING, transcriptionIssueTone(TranscriptionIssue.RECONNECTING))
        assertEquals(R.string.meeting_issue_reconnecting, transcriptionIssueRes(TranscriptionIssue.RECONNECTING))
        for (terminal in listOf(
            TranscriptionIssue.QUOTA_EXCEEDED,
            TranscriptionIssue.STOPPED,
            TranscriptionIssue.SIGNED_OUT,
        )) {
            assertTrue(terminal.isTerminal)
            assertEquals(NoticeTone.TRANSCRIPT_STOPPED, transcriptionIssueTone(terminal))
        }
        assertFalse(TranscriptionIssue.RECONNECTING.isTerminal)
        assertEquals(R.string.meeting_issue_quota, transcriptionIssueRes(TranscriptionIssue.QUOTA_EXCEEDED))
        assertEquals(R.string.meeting_issue_stopped, transcriptionIssueRes(TranscriptionIssue.STOPPED))
        assertEquals(R.string.meeting_issue_signed_out, transcriptionIssueRes(TranscriptionIssue.SIGNED_OUT))
    }

    @Test
    fun `every tone but news keeps a mark when the panel collapses`() {
        assertFalse(NoticeTone.INFO.needsAttention)
        assertTrue(NoticeTone.RECONNECTING.needsAttention)
        assertTrue(NoticeTone.TRANSCRIPT_STOPPED.needsAttention)
        assertTrue(NoticeTone.ALARM.needsAttention)
    }

    @Test
    fun `the empty transcript invites a recording until the microphone is open`() {
        assertEquals(R.string.meeting_idle_hint, emptyTranscriptRes(MeetingState.Idle))
        assertEquals(R.string.meeting_idle_hint, emptyTranscriptRes(MeetingState.Connecting))
        assertEquals(R.string.meeting_transcript_empty, emptyTranscriptRes(MeetingState.Recording))
    }

    @Test
    fun `only the newest unsettled turn is the one being spoken`() {
        val segments = listOf(
            segment("mix-0", isFinal = true),
            segment("mix-1", isFinal = false),
            segment("mix-2", isFinal = true),
            segment("mix-tail", isFinal = false),
        )
        assertEquals("mix-tail", currentSpeakingId(segments))
        assertNull(currentSpeakingId(segments.filter { it.isFinal }))
    }

    @Test
    fun `only a finished or failed meeting is settled`() {
        assertTrue(isSettled(finished()))
        assertTrue(isSettled(MeetingState.Failed(MeetingFailure.UNKNOWN)))
        assertFalse(isSettled(MeetingState.Recording))
        assertFalse(isSettled(MeetingState.Uploading))
    }

    private fun segment(id: String, isFinal: Boolean) = TranscriptSegment(
        id = id,
        source = "mix",
        speaker = 1,
        text = "words",
        isFinal = isFinal,
        startMs = 0,
        endMs = 0,
    )

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
