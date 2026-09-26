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

/**
 * What one failed upload does to the rest of the queue — iOS
 * `MeetingUploader.syncPending` / `isTerminal`, except that a 402 is kept
 * (iOS drops it, contradicting its own "will sync once the quota resets").
 *
 * Before this, any failure stopped the pass. A recording the server will refuse
 * forever (too large, malformed) therefore sat at the head of an oldest-first
 * queue and every meeting recorded after it waited behind it for good.
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
    fun `every other 4xx drops the recording`() {
        listOf(400, 404, 409, 410, 413, 415, 422, 499).forEach { status ->
            assertEquals(
                "HTTP $status",
                UploadFailureDisposition.DROP,
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

    private fun uploader(queue: PendingUploadQueue) = MeetingUploader(
        cloud = CloudClient(baseUrl = server.url("/").toString(), tokenProvider = { "token" }),
        queue = queue,
        retryDelay = {},
    )

    private fun respond(status: Int, body: String = "{}") {
        server.enqueue(MockResponse().setResponseCode(status).setBody(body))
    }

    private fun respondUploaded() {
        respond(200) // PUT audio
        respond(200, """{"updatedAt":1}""") // POST summary + meta
    }

    @Test
    fun `a recording the server refuses for good is dropped and the pass carries on`() = runBlocking {
        val queue = queue("too-big", "next")
        respond(413, """{"error":"payload_too_large"}""")
        respondUploaded()

        val result = uploader(queue).drain()

        assertEquals(1, result.uploaded)
        assertEquals(1, result.discarded)
        assertEquals(0, result.remaining)
        assertEquals(setOf("too-big"), result.refused.keys)
        assertEquals(413, (result.refused.getValue("too-big") as CloudException).status)
        assertEquals("the refusal is still reported", 413, (result.failure as CloudException).status)
        assertFalse("its audio goes with it", queue.audioFile("too-big").exists())
        assertFalse(queue.manifestFile("too-big").exists())
    }

    @Test
    fun `a dead session stops the pass and keeps everything`() = runBlocking {
        val queue = queue("first", "second")
        respond(401, """{"error":"unauthorized"}""")

        val result = uploader(queue).drain()

        assertEquals(0, result.uploaded)
        assertEquals(2, result.remaining)
        assertTrue(result.signedOut)
        assertTrue(result.refused.isEmpty())
        assertTrue(queue.audioFile("first").exists())
        // Stopped at the head: the second recording was never tried.
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `out of quota keeps the recording and stops after one request`() = runBlocking {
        // iOS drops a 402'd recording while telling the user it "will sync once
        // the quota resets". Android keeps the promise: a quota reset is a wait.
        val queue = queue("first", "second")
        respond(402, """{"error":"quota_exhausted"}""")

        val result = uploader(queue).drain()

        assertEquals(0, result.uploaded)
        assertEquals(0, result.discarded)
        assertEquals(2, result.remaining)
        assertTrue(result.quotaExhausted)
        assertTrue("not a refusal", result.refused.isEmpty())
        assertTrue(queue.audioFile("first").exists())
        assertTrue(queue.manifestFile("first").exists())
        assertEquals("no retries, and the second recording is not tried", 1, server.requestCount)
    }

    @Test
    fun `rate limiting stops the pass once its retries are spent`() = runBlocking {
        val queue = queue("first", "second")
        repeat(3) { respond(429, """{"error":"too_many_requests"}""") }

        val result = uploader(queue).drain()

        assertEquals(0, result.uploaded)
        assertEquals(2, result.remaining)
        assertEquals(0, result.discarded)
        assertEquals("three attempts on the head, none on the next", 3, server.requestCount)
    }

    @Test
    fun `425 too early waits rather than drops`() = runBlocking {
        val queue = queue("first")
        respond(425)

        val result = uploader(queue).drain()

        assertEquals(1, result.remaining)
        assertEquals(0, result.discarded)
    }

    @Test
    fun `a server fault stops the pass and keeps the queue in order`() = runBlocking {
        val queue = queue("first", "second")
        repeat(3) { respond(503) }

        val result = uploader(queue).drain()

        assertEquals(2, result.remaining)
        assertEquals(0, result.discarded)
        assertTrue(queue.audioFile("first").exists())
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
