package com.pathors.parley.upload

import com.pathors.parley.cloud.CloudClient
import com.pathors.parley.cloud.CloudJson
import com.pathors.parley.library.SaveDestination
import java.io.File
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The default save location, as the upload path honours it.
 *
 * The ordering is the contract: audio, then the push, then — only for an
 * organization — the share, because the share copies what the push wrote. And
 * an organization choice files nothing personally: the upload lands at the
 * personal root and the folder goes to the org copy.
 */
class MeetingUploaderShareTest {

    @get:Rule
    val temporary = TemporaryFolder()

    private val server = MockWebServer()

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun uploader(
        queue: PendingUploadQueue,
        destination: SaveDestination,
    ) = MeetingUploader(
        cloud = CloudClient(baseUrl = server.url("/").toString(), tokenProvider = { "t" }),
        queue = queue,
        maxAttempts = 1,
        retryDelay = {},
        defaultDestination = { destination },
    )

    private fun audio(name: String): File =
        temporary.newFile("$name.ogg").apply { writeBytes(ByteArray(256) { it.toByte() }) }

    private fun request(id: String, folderId: String? = null) = EnqueueRequest(
        audio = audio(id),
        title = "Renewal terms",
        durationMs = 60_000.0,
        id = id,
        folderId = folderId,
    )

    private fun ok(body: String = "{}") =
        server.enqueue(MockResponse().setResponseCode(200).setBody(body))

    private fun json(request: RecordedRequest): JsonObject =
        CloudJson.parseToJsonElement(request.body.readUtf8()).jsonObject

    @Test
    fun `an org destination uploads, pushes, then shares — in that order`() = runBlocking {
        val queue = PendingUploadQueue(temporary.newFolder("q1"))
        val uploader = uploader(queue, SaveDestination(orgId = "o1", folderId = "of1"))
        ok()
        ok("""{"updatedAt":1}""")
        ok()

        uploader.enqueue(request("rec-org"))
        val result = uploader.drain()

        assertEquals(1, result.uploaded)
        assertEquals(0, result.remaining)
        val put = server.takeRequest()
        assertEquals("PUT", put.method)
        assertEquals("/recordings/rec-org/audio", put.path)
        val push = server.takeRequest()
        assertEquals("POST", push.method)
        assertEquals("/recordings/rec-org", push.path)
        val meta = json(push)["meta"]!!.jsonObject
        assertFalse("an org choice files nothing personally", meta.containsKey("folderId"))
        val share = server.takeRequest()
        assertEquals("POST", share.method)
        assertEquals("/recordings/rec-org/share", share.path)
        val body = json(share)
        assertEquals("o1", body["orgId"]!!.jsonPrimitive.content)
        assertEquals("of1", body["folderId"]!!.jsonPrimitive.content)
        assertEquals(3, server.requestCount)
    }

    @Test
    fun `a personal folder destination files the upload and shares nothing`() = runBlocking {
        val queue = PendingUploadQueue(temporary.newFolder("q2"))
        val uploader = uploader(queue, SaveDestination(folderId = "f1"))
        ok()
        ok("""{"updatedAt":1}""")

        uploader.enqueue(request("rec-personal"))
        uploader.drain()

        server.takeRequest()
        val push = json(server.takeRequest())
        assertEquals("f1", push["meta"]!!.jsonObject["folderId"]!!.jsonPrimitive.content)
        assertEquals("f1", push["summary"]!!.jsonObject["folderId"]!!.jsonPrimitive.content)
        assertEquals(2, server.requestCount)
    }

    /** A folder picked for this one recording beats the default, org or not. */
    @Test
    fun `an explicit folder wins over the default`() = runBlocking {
        val queue = PendingUploadQueue(temporary.newFolder("q3"))
        val uploader = uploader(queue, SaveDestination(orgId = "o1"))

        uploader.enqueue(request("rec-explicit", folderId = "picked"))

        val pending = queue.list().single()
        assertEquals("picked", pending.folderId)
        assertNull(pending.shareOrgId)
    }

    /**
     * The destination is captured at enqueue: a recording keeps the place it
     * was made for even if the setting changes while it waits for a network.
     */
    @Test
    fun `the destination is captured when the recording is queued`() = runBlocking {
        val queue = PendingUploadQueue(temporary.newFolder("q4"))
        var setting = SaveDestination(orgId = "o1")
        val uploader = MeetingUploader(
            cloud = CloudClient(baseUrl = server.url("/").toString(), tokenProvider = { "t" }),
            queue = queue,
            maxAttempts = 1,
            retryDelay = {},
            defaultDestination = { setting },
        )

        uploader.enqueue(request("rec-captured"))
        setting = SaveDestination.PERSONAL_ROOT

        assertEquals("o1", queue.list().single().shareOrgId)
    }

    /**
     * No longer a member: the recording is safely personal already, so the
     * queue moves on instead of parking an uploaded recording at its head.
     */
    @Test
    fun `a refused share leaves the recording personal and the queue moving`() = runBlocking {
        val queue = PendingUploadQueue(temporary.newFolder("q5"))
        val uploader = uploader(queue, SaveDestination(orgId = "gone"))
        ok()
        ok("""{"updatedAt":1}""")
        server.enqueue(MockResponse().setResponseCode(403).setBody("""{"error":"forbidden"}"""))

        uploader.enqueue(request("rec-refused"))
        val result = uploader.drain()

        assertEquals(1, result.uploaded)
        assertEquals(0, result.remaining)
        assertNull(result.failure)
    }

    /** A server hiccup on the share is retried with the whole upload, later. */
    @Test
    fun `a transient share failure keeps the recording queued`() = runBlocking {
        val queue = PendingUploadQueue(temporary.newFolder("q6"))
        val uploader = uploader(queue, SaveDestination(orgId = "o1"))
        ok()
        ok("""{"updatedAt":1}""")
        server.enqueue(MockResponse().setResponseCode(503).setBody("""{"error":"unavailable"}"""))

        uploader.enqueue(request("rec-transient"))
        val result = uploader.drain()

        assertEquals(0, result.uploaded)
        assertEquals(1, result.remaining)
        assertTrue(queue.audioFile("rec-transient").exists())
    }
}
