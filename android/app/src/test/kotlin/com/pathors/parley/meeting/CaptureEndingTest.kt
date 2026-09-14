package com.pathors.parley.meeting

import com.pathors.parley.cloud.CloudClient
import com.pathors.parley.cloud.RecordingSource
import com.pathors.parley.cloud.TranscriptSegmentDto
import com.pathors.parley.upload.EnqueueRequest
import com.pathors.parley.upload.MeetingUploader
import com.pathors.parley.upload.PendingUploadQueue
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The keep-or-delete table, the terminal state that follows from it, and the
 * one thing that has to be true at the end of all of it: an interrupted
 * recording is still on the device, waiting to upload.
 */
class CaptureEndingTest {

    @get:Rule val temp = TemporaryFolder()

    // ── the table ───────────────────────────────────────────────────────────

    @Test
    fun onlyAnExplicitDiscardDeletesTheAudio() {
        val deleting = CaptureEnding.entries.filter { it.deletesAudio }
        assertEquals(listOf(CaptureEnding.DISCARDED), deleting)
    }

    @Test
    fun anInterruptionKeepsTheRecordingJustLikeAStopDoes() {
        // The entire bug in one assertion: losing the microphone, the encoder or
        // the host process must be indistinguishable from the user tapping Stop
        // as far as the file on disk is concerned.
        assertTrue(CaptureEnding.COMPLETED.savesAudio)
        assertTrue(CaptureEnding.INTERRUPTED.savesAudio)
        assertFalse(CaptureEnding.INTERRUPTED.deletesAudio)
    }

    @Test
    fun releasingASessionNeitherSavesNorDeletes() {
        // By the time the session is released the recording has already been
        // dealt with; a release that deletes is how a saved meeting vanishes a
        // second after it was saved.
        assertFalse(CaptureEnding.RELEASED.savesAudio)
        assertFalse(CaptureEnding.RELEASED.deletesAudio)
    }

    // ── the terminal state ──────────────────────────────────────────────────

    @Test
    fun anInterruptedRecordingFinishesAndSaysWhyItEnded() {
        val state = terminalStateFor(
            recordingId = "abc",
            pendingUpload = true,
            interruptedBy = MeetingFailure.MIC_UNAVAILABLE,
        )
        val finished = state as MeetingState.Finished
        assertEquals("abc", finished.recordingId)
        assertTrue(finished.pendingUpload)
        assertFalse(finished.dropped)
        assertEquals(MeetingFailure.MIC_UNAVAILABLE, finished.interruptedBy)
    }

    @Test
    fun anOrdinaryStopFinishesWithNothingToExplain() {
        val finished = terminalStateFor(
            recordingId = "abc",
            pendingUpload = false,
            interruptedBy = null,
        ) as MeetingState.Finished
        assertNull(finished.interruptedBy)
        assertFalse(finished.dropped)
    }

    @Test
    fun afailureWithNothingWorthSavingIsStillAFailure() {
        // Permission refused before the first chunk: there is no recording to
        // point the user at, so the reason is all they can be given.
        val failed = terminalStateFor(
            recordingId = null,
            pendingUpload = false,
            interruptedBy = MeetingFailure.MIC_PERMISSION,
            detail = "denied",
        ) as MeetingState.Failed
        assertEquals(MeetingFailure.MIC_PERMISSION, failed.reason)
        assertEquals("denied", failed.detail)
    }

    @Test
    fun aMisfireIsDroppedRatherThanReportedAsBroken() {
        val finished = terminalStateFor(
            recordingId = null,
            pendingUpload = false,
            interruptedBy = null,
        ) as MeetingState.Finished
        assertTrue(finished.dropped)
        assertNull(finished.recordingId)
    }

    // ── and the file actually survives ──────────────────────────────────────

    /**
     * What all of the above is for. A meeting cut short at forty minutes must
     * end up in the upload queue with its bytes intact — not deleted, and not
     * left behind in the cache where nothing will ever look for it.
     */
    @Test
    fun anInterruptedRecordingLandsInTheUploadQueueWithItsBytes() = runBlocking {
        val queue = PendingUploadQueue(temp.newFolder("PendingUploads"))
        val uploader = newUploader(queue)
        val audio = temp.newFile("meeting-1.ogg").apply { writeBytes(FAKE_OGG) }

        val id = uploader.enqueue(
            EnqueueRequest(
                audio = audio,
                title = "Meeting",
                durationMs = FORTY_MINUTES_MS,
                segments = listOf(finalSegment()),
                source = RecordingSource.LIVE,
            )
        )

        assertNotNull("a forty-minute recording must never be dropped", id)
        val queued = queue.audioFile(id!!)
        assertTrue("the blob must be in the queue", queued.isFile)
        assertArrayEqualsBytes(FAKE_OGG, queued.readBytes())
        assertFalse("enqueue moves the file; the source must not linger", audio.exists())
        assertEquals(1, queue.count())
        assertEquals(id, queue.list().single().id)
    }

    @Test
    fun atwoSecondMisfireIsStillThrownAway() = runBlocking {
        // Saving on interruption must not turn every stray tap into a recording.
        val queue = PendingUploadQueue(temp.newFolder("PendingUploads"))
        val audio = temp.newFile("meeting-2.ogg").apply { writeBytes(FAKE_OGG) }

        val id = newUploader(queue).enqueue(
            EnqueueRequest(
                audio = audio,
                title = "Meeting",
                durationMs = 900.0,
                source = RecordingSource.LIVE,
            )
        )

        assertNull(id)
        assertEquals(0, queue.count())
        assertFalse(audio.exists())
    }

    private fun newUploader(queue: PendingUploadQueue) =
        MeetingUploader(cloud = CloudClient(tokenProvider = { null }), queue = queue)

    private fun finalSegment() = TranscriptSegmentDto(
        id = "mix-0",
        source = "mix",
        speaker = 1,
        text = "Still here.",
        isFinal = true,
        startMs = 0,
        endMs = 400,
    )

    private fun assertArrayEqualsBytes(expected: ByteArray, actual: ByteArray) =
        assertEquals(expected.toList(), actual.toList())

    private companion object {
        val FAKE_OGG = "OggS-not-really-but-bytes-are-bytes".toByteArray()
        const val FORTY_MINUTES_MS = 40.0 * 60 * 1000
    }
}
