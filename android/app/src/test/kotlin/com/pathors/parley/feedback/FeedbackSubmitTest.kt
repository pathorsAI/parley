package com.pathors.parley.feedback

import com.pathors.parley.cloud.CloudClient
import com.pathors.parley.cloud.CloudException
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * `POST /feedback` on the wire: the multipart body of spec §3, the optional
 * screenshot part, and a 401 that must not sign anybody out.
 */
class FeedbackSubmitTest {

    @get:Rule
    val folder = TemporaryFolder()

    private val server = MockWebServer()
    private val unauthorized = AtomicInteger()

    private fun client(token: String? = "session-token") = CloudClient(
        baseUrl = server.url("/").toString(),
        tokenProvider = { token },
        onUnauthorized = { unauthorized.incrementAndGet() },
    )

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `payload and screenshot go as multipart form fields`() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"id":"r1"}"""))
        val shot = folder.newFile("r1.jpg").apply { writeBytes(byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 1, 2)) }
        val payload = """{"id":"r1","trigger":"screenshot","tags":[],"diagnostics":{}}"""

        val id = client().submitFeedback(FeedbackMultipart.build(payload, shot))

        assertEquals("r1", id)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/feedback", request.path)
        assertEquals("Bearer session-token", request.getHeader("Authorization"))
        val contentType = request.getHeader("Content-Type").orEmpty()
        assertTrue(contentType, contentType.startsWith("multipart/form-data; boundary="))
        val body = request.body.readUtf8()
        assertTrue(body, body.contains("Content-Disposition: form-data; name=\"payload\""))
        assertTrue(body, body.contains(payload))
        assertTrue(body, body.contains("Content-Disposition: form-data; name=\"screenshot\"; filename=\"screenshot.jpg\""))
        assertTrue(body, body.contains("Content-Type: image/jpeg"))
    }

    @Test
    fun `without a screenshot there is no screenshot part`() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"id":"r2"}"""))

        client().submitFeedback(FeedbackMultipart.build("""{"id":"r2"}""", null))

        val body = server.takeRequest().body.readUtf8()
        assertTrue(body.contains("name=\"payload\""))
        assertFalse(body.contains("name=\"screenshot\""))
    }

    @Test
    fun `signed out, the report goes without an Authorization header`() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"id":"r3"}"""))

        client(token = null).submitFeedback(FeedbackMultipart.build("""{"id":"r3"}""", null))

        assertEquals(null, server.takeRequest().getHeader("Authorization"))
    }

    @Test
    fun `a 401 fails the send but never clears the session`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"unauthorized"}"""))

        val error = runCatching { client().submitFeedback(FeedbackMultipart.build("{}", null)) }.exceptionOrNull()

        assertEquals(401, (error as CloudException).status)
        assertEquals(0, unauthorized.get())
    }

    @Test
    fun `a 413 surfaces as a refusal the queue drops`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(413).setBody("""{"error":"payload_too_large"}"""))

        val error = runCatching { client().submitFeedback(FeedbackMultipart.build("{}", null)) }.exceptionOrNull()!!

        assertTrue(FeedbackQueue.isPermanent(error))
    }
}
