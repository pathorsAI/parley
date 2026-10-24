package com.pathors.parley.upload

import com.pathors.parley.cloud.CloudClient
import com.pathors.parley.cloud.CloudException
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** A recording the server refuses (413). */
private const val TOO_BIG = "too-big"

/** A recording whose upload body was cut off, which the server answers with 400. */
private const val TRUNCATED = "truncated"

private const val NEXT = "next"
private const val FIRST = "first"
private const val SECOND = "second"

private const val TOO_LARGE_BODY = """{"error":"payload_too_large"}"""
private const val BAD_REQUEST_BODY = """{"error":"bad_request"}"""

/** Where the injected wall clock starts. */
private const val T0 = 1_800_000_000_000L
private const val HOUR_MS = 60L * 60L * 1_000L

/**
 * What one failed upload does to the rest of the queue.
 *
 * Two bugs shaped this. First, any failure stopped the pass, so a recording the
 * server refused sat at the head of an oldest-first queue and every meeting
 * after it waited behind it for good. The fix for that *dropped* refused
 * recordings — audio and all — which was the second bug: the server answers 400
 * to an upload body cut off mid-transfer, so a flaky network deleted a
 * three-hour meeting (Android 1.20). A refusal now parks the recording: kept,
 * out of the way of the queue, retried on a long schedule or by hand.
 */
class MeetingUploaderDrainTest {

    @get:Rule
    val temporary = TemporaryFolder()

    private val server = MockWebServer()

    @After
    fun tearDown() {
        server.shutdown()
    }

    // ── the classification itself ────────────────────────────────────────────

    @Test
    fun `the 4xx that a later action clears stop the pass`() {
        listOf(401, 402, 403, 408, 425, 429).forEach { status ->
            assertEquals(
                "HTTP $status",
                UploadFailureDisposition.STOP_PASS,
                MeetingUploader.dispositionOf(CloudException(status, "x")),
            )
        }
    }

    @Test
    fun `every other 4xx parks the recording`() {
        listOf(400, 404, 409, 410, 413, 415, 422, 499).forEach { status ->
            assertEquals(
                "HTTP $status",
                UploadFailureDisposition.PARK,
                MeetingUploader.dispositionOf(CloudException(status, "x")),
            )
        }
    }

    @Test
    fun `server faults and failures that never reached HTTP stop the pass`() {
        listOf(0, 500, 502, 503, 504).forEach { status ->
            assertEquals(
                "HTTP $status",
                UploadFailureDisposition.STOP_PASS,
                MeetingUploader.dispositionOf(CloudException(status, "x")),
            )
        }
        assertEquals(
            UploadFailureDisposition.STOP_PASS,
            MeetingUploader.dispositionOf(IOException("Unable to resolve host")),
        )
        assertEquals(
            UploadFailureDisposition.STOP_PASS,
            MeetingUploader.dispositionOf(IllegalStateException("?")),
        )
    }

    // ── what the queue looks like afterwards ─────────────────────────────────

    private fun queue(vararg ids: String): PendingUploadQueue {
        val queue = PendingUploadQueue(temporary.newFolder("PendingUploads"))
        ids.forEachIndexed { index, id ->
            val source = temporary.newFile("$id.ogg").apply { writeBytes(ByteArray(256) { 1 }) }
            queue.enqueue(
                PendingUpload(
                    id = id,
                    title = id,
                    // Oldest first: the order they are listed in.
                    startedAtMs = 1_700_000_000_000 + index,
                    durationMs = 60_000.0,
                ),
                source,
            )
        }
        return queue
    }

    /** The injected wall clock; tests move it forward to make parked uploads due. */
    private var nowMs = T0

    private fun uploader(queue: PendingUploadQueue) = MeetingUploader(
        cloud = CloudClient(baseUrl = server.url("/").toString(), tokenProvider = { "token" }),
        queue = queue,
        retryDelay = {},
        now = { nowMs },
    )

    private fun parkedOf(queue: PendingUploadQueue, id: String): ParkedUpload? =
        queue.list().single { it.id == id }.parked

    private fun respond(status: Int, body: String = "{}") {
        server.enqueue(MockResponse().setResponseCode(status).setBody(body))
    }

    private fun respondUploaded() {
        respond(200) // PUT audio
        respond(200, """{"updatedAt":1}""") // POST summary + meta
    }

    @Test
    fun `a refused recording is parked, not deleted, and the pass carries on`() = runBlocking {
        val queue = queue(TOO_BIG, NEXT)
        respond(413, TOO_LARGE_BODY)
        respondUploaded()

        val result = uploader(queue).drain()

        assertEquals(1, result.uploaded)
        assertEquals(setOf(NEXT), result.uploadedIds)
        assertEquals("a refusal is not a discard", 0, result.discarded)
        assertEquals(1, result.remaining)
        assertEquals(1, result.parked)
        assertEquals(setOf(TOO_BIG), result.refused.keys)
        assertEquals(413, (result.refused.getValue(TOO_BIG) as CloudException).status)
        assertEquals("the refusal is still reported", 413, (result.failure as CloudException).status)
        assertTrue("its audio is the only copy of the meeting", queue.audioFile(TOO_BIG).exists())
        assertTrue(queue.manifestFile(TOO_BIG).exists())
        assertEquals(ParkedUpload(413, firstRefusedAtMs = T0, lastRefusedAtMs = T0), parkedOf(queue, TOO_BIG))
    }

    @Test
    fun `a 400 from a body cut off mid-upload parks the meeting`() = runBlocking {
        // The lost three-hour meeting: a flaky network, a truncated PUT, a 400.
        val queue = queue(TRUNCATED)
        respond(400, BAD_REQUEST_BODY)

        val result = uploader(queue).drain()

        assertTrue(result.uploadedIds.isEmpty())
        assertEquals(1, result.remaining)
        assertEquals(400, parkedOf(queue, TRUNCATED)?.httpStatus)
        assertEquals(256L, queue.audioFile(TRUNCATED).length())
    }

    @Test
    fun `a parked recording is not retried before it is due`() = runBlocking {
        val queue = queue(TRUNCATED)
        val uploader = uploader(queue)
        respond(400, BAD_REQUEST_BODY)
        uploader.drain()

        nowMs = T0 + HOUR_MS - 1
        val result = uploader.drain()

        assertEquals("one request in all: the second pass skipped it", 1, server.requestCount)
        assertEquals(1, result.remaining)
        assertTrue(result.refused.isEmpty())
    }

    @Test
    fun `a parked recording that is due uploads and only then leaves the queue`() = runBlocking {
        val queue = queue(TRUNCATED)
        val uploader = uploader(queue)
        respond(400, BAD_REQUEST_BODY)
        uploader.drain()

        nowMs = T0 + HOUR_MS
        respondUploaded()
        val result = uploader.drain()

        assertEquals(setOf(TRUNCATED), result.uploadedIds)
        assertEquals(0, result.remaining)
        assertFalse(queue.audioFile(TRUNCATED).exists())
    }

    @Test
    fun `a parked recording refused again climbs the schedule and keeps its first refusal`() = runBlocking {
        val queue = queue(TRUNCATED)
        val uploader = uploader(queue)
        respond(400, BAD_REQUEST_BODY)
        uploader.drain()

        nowMs = T0 + HOUR_MS
        respond(413, TOO_LARGE_BODY)
        uploader.drain()

        val parked = parkedOf(queue, TRUNCATED)
        assertEquals(
            ParkedUpload(413, firstRefusedAtMs = T0, lastRefusedAtMs = T0 + HOUR_MS, refusals = 2),
            parked,
        )
        assertEquals(T0 + 7 * HOUR_MS, ParkedRetrySchedule.nextRetryAtMs(parked!!))
        assertTrue(queue.audioFile(TRUNCATED).exists())
    }

    @Test
    fun `retrying by hand tries a parked recording whatever the schedule says`() = runBlocking {
        val queue = queue(TRUNCATED)
        val uploader = uploader(queue)
        respond(400, BAD_REQUEST_BODY)
        uploader.drain()

        respondUploaded()
        val result = uploader.retryNow(TRUNCATED)

        assertEquals(setOf(TRUNCATED), result.uploadedIds)
        assertEquals(0, result.remaining)
    }

    @Test
    fun `deleting a parked recording by hand is the one way its audio goes unuploaded`() = runBlocking {
        val queue = queue(TOO_BIG)
        val uploader = uploader(queue)
        respond(413, TOO_LARGE_BODY)
        uploader.drain()
        assertTrue("the audio can be handed to the share sheet", uploader.pendingAudio(TOO_BIG) != null)

        uploader.deletePending(TOO_BIG)

        assertEquals(0, queue.count())
        assertFalse(queue.audioFile(TOO_BIG).exists())
        assertNull(uploader.pendingAudio(TOO_BIG))
    }

    @Test
    fun `parked recordings wait while the ordinary queue is stuck`() = runBlocking {
        // A parked head must never jam the queue — and a queue stopped by the
        // network must not then spend requests on parked recordings either.
        val queue = queue(TRUNCATED, FIRST)
        val uploader = uploader(queue)
        respond(400, BAD_REQUEST_BODY)
        respond(503)
        respond(503)
        respond(503)
        uploader.drain()

        nowMs = T0 + HOUR_MS
        repeat(3) { respond(503) }
        val result = uploader.drain()

        assertEquals("1 refusal + 3 + 3 on the ordinary head, none on the parked one", 7, server.requestCount)
        assertEquals(2, result.remaining)
        assertEquals(1, result.parked)
    }

    @Test
    fun `a dead session stops the pass and keeps everything`() = runBlocking {
        val queue = queue(FIRST, SECOND)
        respond(401, """{"error":"unauthorized"}""")

        val result = uploader(queue).drain()

        assertEquals(0, result.uploaded)
        assertEquals(2, result.remaining)
        assertTrue(result.signedOut)
        assertTrue(result.refused.isEmpty())
        assertTrue(queue.audioFile(FIRST).exists())
        // Stopped at the head: the second recording was never tried.
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `out of quota keeps the recording and stops after one request`() = runBlocking {
        // iOS drops a 402'd recording while telling the user it "will sync once
        // the quota resets". Android keeps the promise: a quota reset is a wait.
        val queue = queue(FIRST, SECOND)
        respond(402, """{"error":"quota_exhausted"}""")

        val result = uploader(queue).drain()

        assertEquals(0, result.uploaded)
        assertEquals(0, result.discarded)
        assertEquals(2, result.remaining)
        assertTrue(result.quotaExhausted)
        assertTrue("not a refusal", result.refused.isEmpty())
        assertTrue(queue.audioFile(FIRST).exists())
        assertTrue(queue.manifestFile(FIRST).exists())
        assertEquals("no retries, and the second recording is not tried", 1, server.requestCount)
    }

    @Test
    fun `rate limiting stops the pass once its retries are spent`() = runBlocking {
        val queue = queue(FIRST, SECOND)
        repeat(3) { respond(429, """{"error":"too_many_requests"}""") }

        val result = uploader(queue).drain()

        assertEquals(0, result.uploaded)
        assertEquals(2, result.remaining)
        assertEquals(0, result.discarded)
        assertEquals("three attempts on the head, none on the next", 3, server.requestCount)
    }

    @Test
    fun `425 too early waits rather than drops`() = runBlocking {
        val queue = queue(FIRST)
        respond(425)

        val result = uploader(queue).drain()

        assertEquals(1, result.remaining)
        assertEquals(0, result.discarded)
    }

    @Test
    fun `a server fault stops the pass and keeps the queue in order`() = runBlocking {
        val queue = queue(FIRST, SECOND)
        repeat(3) { respond(503) }

        val result = uploader(queue).drain()

        assertEquals(2, result.remaining)
        assertEquals(0, result.discarded)
        assertTrue(queue.audioFile(FIRST).exists())
    }

    @Test
    fun `a missing or empty audio file is dropped without a request`() = runBlocking {
        val queue = queue("gone", "empty", "fine")
        queue.audioFile("gone").delete()
        queue.audioFile("empty").writeBytes(ByteArray(0))
        respondUploaded()

        val result = uploader(queue).drain()

        assertEquals(1, result.uploaded)
        assertEquals(2, result.discarded)
        assertEquals(0, result.remaining)
        assertTrue("not a server refusal", result.refused.isEmpty())
        assertNull(result.failure)
        assertEquals(2, server.requestCount)
        val first = server.takeRequest(1, TimeUnit.SECONDS)!!
        assertTrue(first.path!!.contains("fine"))
    }
}
