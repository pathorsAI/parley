package com.pathors.parley.meeting

import com.pathors.parley.cloud.CloudException
import com.pathors.parley.upload.DrainResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private const val THIS_ONE = "this-one"
private const val OLDER = "older"

/**
 * What the finished screen is told about the recording it just saved.
 *
 * The bug: `save` read "the queue is empty" as "synced". A refusal used to
 * delete the recording, which emptied the queue — so a meeting that was gone
 * was announced as safely in the cloud.
 */
class UploadOutcomeTest {

    private val refusal = CloudException(400, "bad_request")

    @Test
    fun `uploaded means in the cloud`() {
        val result = DrainResult(uploaded = 1, remaining = 0, uploadedIds = setOf(THIS_ONE))
        assertEquals(UploadOutcome(pending = false, refused = false), UploadOutcome.of(THIS_ONE, result))
    }

    @Test
    fun `an empty queue without this recording uploaded is not synced`() {
        val result = DrainResult(uploaded = 0, remaining = 0)
        assertTrue(UploadOutcome.of(THIS_ONE, result).pending)
    }

    @Test
    fun `a refused recording is reported as refused and still pending`() {
        val result = DrainResult(
            uploaded = 0,
            remaining = 1,
            failure = refusal,
            refused = mapOf(THIS_ONE to refusal),
            parked = 1,
        )
        assertEquals(UploadOutcome(pending = true, refused = true), UploadOutcome.of(THIS_ONE, result))
    }

    @Test
    fun `an older parked recording does not make this one look pending`() {
        val result = DrainResult(
            uploaded = 1,
            remaining = 1,
            refused = mapOf(OLDER to refusal),
            uploadedIds = setOf(THIS_ONE),
            parked = 1,
        )
        assertEquals(UploadOutcome(pending = false, refused = false), UploadOutcome.of(THIS_ONE, result))
    }

    @Test
    fun `a drain that threw leaves the recording waiting`() {
        assertEquals(UploadOutcome(pending = true, refused = false), UploadOutcome.of(THIS_ONE, null))
    }

    @Test
    fun `no recording, nothing pending`() {
        assertFalse(UploadOutcome.of(null, null).pending)
    }

    @Test
    fun `the finished state carries a refusal only while the upload is pending`() {
        val waiting = terminalStateFor(recordingId = THIS_ONE, pendingUpload = true, interruptedBy = null)
        val refused = withUploadRefused(waiting, refused = true) as MeetingState.Finished
        assertTrue(refused.uploadRefused)

        val synced = terminalStateFor(recordingId = THIS_ONE, pendingUpload = false, interruptedBy = null)
        val uploaded = withUploadRefused(synced, refused = true) as MeetingState.Finished
        assertFalse(uploaded.uploadRefused)

        val failed = MeetingState.Failed(MeetingFailure.UNKNOWN)
        assertEquals(failed, withUploadRefused(failed, refused = true))
    }
}
