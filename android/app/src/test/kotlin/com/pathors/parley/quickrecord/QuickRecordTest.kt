package com.pathors.parley.quickrecord

import com.pathors.parley.meeting.MeetingFailure
import com.pathors.parley.meeting.MeetingState
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * One tap is one recording, and only soon after the tap: the freshness window,
 * the inbox that clears itself when taken, and when a fresh request is allowed
 * to touch the navigation at all.
 */
class QuickRecordTest {

    private val tappedAt = 1_000_000L

    // ── the link ────────────────────────────────────────────────────────────

    @Test
    fun recognisesOnlyTheRecordLink() {
        assertTrue(QuickRecord.isRequest("parley", "record"))
        assertFalse(QuickRecord.isRequest("parley", "auth-callback"))
        assertFalse(QuickRecord.isRequest("parley", "demo"))
        assertFalse(QuickRecord.isRequest("https", "record"))
        assertFalse(QuickRecord.isRequest(null, null))
    }

    // ── freshness ───────────────────────────────────────────────────────────

    @Test
    fun freshUpToAndIncludingTheWindow() {
        assertTrue(QuickRecord.isFresh(tappedAt, tappedAt))
        assertTrue(QuickRecord.isFresh(tappedAt, tappedAt + QuickRecord.FRESHNESS_MS))
    }

    @Test
    fun staleOnceTheWindowHasPassed() {
        assertFalse(QuickRecord.isFresh(tappedAt, tappedAt + QuickRecord.FRESHNESS_MS + 1))
    }

    @Test
    fun aRequestFromTheFutureIsNotFresh() {
        // A clock that went backwards must not make a request look new forever.
        assertFalse(QuickRecord.isFresh(tappedAt, tappedAt - 1))
    }

    // ── the inbox ───────────────────────────────────────────────────────────

    @Test
    fun emptyInboxHasNothingToTake() {
        assertFalse(QuickRecordInbox().take(tappedAt))
    }

    @Test
    fun aFreshRequestIsTakenExactlyOnce() {
        val inbox = QuickRecordInbox()
        inbox.post(tappedAt)

        assertTrue(inbox.take(tappedAt + 500))
        assertNull(inbox.requestedAt.value)
        assertFalse(inbox.take(tappedAt + 600))
    }

    @Test
    fun aStaleRequestIsDroppedAndCleared() {
        val inbox = QuickRecordInbox()
        inbox.post(tappedAt)

        assertFalse(inbox.take(tappedAt + QuickRecord.FRESHNESS_MS + 1))
        // Dropped, not kept: it cannot come back on a later take.
        assertNull(inbox.requestedAt.value)
    }

    @Test
    fun aSecondTapRestartsTheWindow() {
        val inbox = QuickRecordInbox()
        inbox.post(tappedAt)
        inbox.post(tappedAt + QuickRecord.FRESHNESS_MS)

        assertTrue(inbox.take(tappedAt + QuickRecord.FRESHNESS_MS + 1))
    }

    // ── where it may navigate ───────────────────────────────────────────────

    @Test
    fun offTheMeetingScreenAlwaysOpensIt() {
        assertTrue(QuickRecord.shouldOpenMeeting(onMeetingScreen = false, meeting = null))
        // A meeting in progress is adopted by the new screen, never restarted.
        assertTrue(QuickRecord.shouldOpenMeeting(onMeetingScreen = false, meeting = MeetingState.Recording))
    }

    @Test
    fun aLiveMeetingOnScreenIsLeftAlone() {
        listOf(
            MeetingState.Connecting,
            MeetingState.Recording,
            MeetingState.Paused,
            MeetingState.Finishing,
            MeetingState.Uploading,
        ).forEach { state ->
            assertFalse("$state", QuickRecord.shouldOpenMeeting(onMeetingScreen = true, meeting = state))
        }
    }

    @Test
    fun aMeetingScreenStillStartingIsLeftAlone() {
        // The screen has asked the service to start and not heard back yet:
        // replacing it here is how one tap would become two recordings.
        assertFalse(QuickRecord.shouldOpenMeeting(onMeetingScreen = true, meeting = null))
    }

    @Test
    fun aSettledMeetingOnScreenIsReplacedByANewRecording() {
        val finished = MeetingState.Finished(recordingId = "r1", pendingUpload = false, dropped = false)
        val failed = MeetingState.Failed(MeetingFailure.entries.first())

        assertTrue(QuickRecord.shouldOpenMeeting(onMeetingScreen = true, meeting = finished))
        assertTrue(QuickRecord.shouldOpenMeeting(onMeetingScreen = true, meeting = failed))
    }
}
