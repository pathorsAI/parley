package com.pathors.parley.cloud

import com.pathors.parley.kit.CloudChat
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The hosted-LLM proxy refusing a burst: a `429 rate_limited` with
 * `Retry-After` is waited out and sent again, and a 4xx is not.
 */
class CloudClientChatRetryTest {

    private val server = MockWebServer()

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun client(): CloudClient = CloudClient(
        baseUrl = server.url("/").toString(),
        tokenProvider = { "session-token" },
    )

    @Test
    fun `a 429 carries its Retry-After`() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(429).setHeader("Retry-After", "7")
                .setBody("""{"error":"rate_limited"}"""),
        )

        val thrown = runCatching { client().me() }.exceptionOrNull() as CloudException

        assertEquals(429, thrown.httpStatus)
        assertEquals("rate_limited", thrown.code)
        assertEquals(7_000L, thrown.retryAfterMs)
    }

    @Test
    fun `a rate-limited chat call is sent again after the wait`() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(429).setHeader("Retry-After", "0")
                .setBody("""{"error":"rate_limited"}"""),
        )
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"choices":[]}"""))

        val body = client().chatCompletion("{}", CloudChat.Feature.MEETING)

        assertEquals("""{"choices":[]}""", body)
        assertEquals(2, server.requestCount)
    }

    @Test
    fun `a client error is not retried`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"bad_request"}"""))

        val thrown = runCatching { client().chatCompletion("{}", CloudChat.Feature.MEETING) }.exceptionOrNull()

        assertTrue(thrown is CloudException)
        assertEquals(1, server.requestCount)
    }
}
