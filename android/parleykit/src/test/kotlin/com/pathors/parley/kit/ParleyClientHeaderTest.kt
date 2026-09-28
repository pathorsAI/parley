package com.pathors.parley.kit

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `X-Parley-Client` — the value's shape, and that both the REST path and the
 * relay's WebSocket upgrade carry it.
 *
 * The shape tests run every value through the cloud's own parser regex: a
 * header the cloud cannot parse is stored as unknown, which is the failure
 * this header exists to prevent, and it would fail silently.
 */
class ParleyClientHeaderTest {
    private val server = MockWebServer()

    @After
    fun tearDown() {
        ParleyClientHeader.reset()
        server.shutdown()
    }

    @Test
    fun `formats platform, version and build the way the cloud parses them`() {
        val value = ParleyClientHeader.format("android", "1.14", "7")

        assertEquals("android/1.14 (7)", value)
        val match = CLOUD_PATTERN.matchEntire(value)
        assertNotNull(match)
        assertEquals("android", match!!.groupValues[1])
        assertEquals("1.14", match.groupValues[2])
        assertEquals("7", match.groupValues[3])
    }

    @Test
    fun `a version with spaces or parentheses still parses`() {
        val value = ParleyClientHeader.format("android", "1.16 (beta)", "9")

        assertEquals("android/1.16beta (9)", value)
        assertTrue(CLOUD_PATTERN.matches(value))
    }

    @Test
    fun `an over-long version is cut to what the cloud accepts`() {
        val value = ParleyClientHeader.format("android", "1.".padEnd(60, '9'), "9")

        assertTrue(value, CLOUD_PATTERN.matches(value))
    }

    @Test
    fun `a build that is not a number is dropped rather than sent broken`() {
        assertEquals("android/1.16", ParleyClientHeader.format("android", "1.16", "nine"))
        assertEquals("android/1.16", ParleyClientHeader.format("android", "1.16", ""))
        assertEquals("android/1.16", ParleyClientHeader.format("android", "1.16", "12345678901"))
        assertTrue(CLOUD_PATTERN.matches(ParleyClientHeader.format("android", "1.16", "")))
    }

    @Test
    fun `nothing is added before a value is installed`() {
        server.enqueue(MockResponse())
        OkHttpClient.Builder().addInterceptor(ParleyClientHeader.interceptor).build()
            .newCall(Request.Builder().url(server.url("/me")).build())
            .execute()
            .close()

        assertNull(server.takeRequest().getHeader(ParleyClientHeader.NAME))
    }

    @Test
    fun `an HTTP request through the interceptor carries the installed value`() {
        ParleyClientHeader.install("android", "1.16", "9")
        server.enqueue(MockResponse())
        OkHttpClient.Builder().addInterceptor(ParleyClientHeader.interceptor).build()
            .newCall(Request.Builder().url(server.url("/recordings")).build())
            .execute()
            .close()

        assertEquals("android/1.16 (9)", server.takeRequest().getHeader(ParleyClientHeader.NAME))
    }

    @Test
    fun `the relay's WebSocket upgrade carries it too`(): Unit = runBlocking {
        ParleyClientHeader.install("android", "1.16", "9")
        server.enqueue(
            MockResponse().withWebSocketUpgrade(
                object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) = Unit
                },
            ),
        )
        val relay = SttRelayClient(
            SttRelayClient.Options(
                bearerToken = "cloud-token",
                relayUrl = server.url("/stt/stream").toString(),
            ),
        )
        try {
            relay.connect()
            val upgrade = server.takeRequest(5, TimeUnit.SECONDS)
            assertNotNull(upgrade)
            assertEquals("android/1.16 (9)", upgrade!!.getHeader(ParleyClientHeader.NAME))
            assertEquals("Bearer cloud-token", upgrade.getHeader("Authorization"))
        } finally {
            relay.cancel()
        }
    }

    private companion object {
        /** The cloud's parser, verbatim from the shared spec (§1). */
        val CLOUD_PATTERN = Regex("""^(ios|android|macos|windows|linux)/([^\s()]{1,32})(?:\s\((\d{1,10})\))?$""")
    }
}
