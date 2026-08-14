package com.pathors.parley.kit

import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.ByteString
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Relay session behavior against a MockWebServer standing in for
 * `wss://api.parley.tw/stt/stream`. The Swift suite has no equivalent (URLSession
 * has no in-process WebSocket fake), so these cover the wire contract the Swift
 * client only documented: the bearer + `?feature=` handshake, the keyless config
 * frame, finalize-without-close, and the terminal event mapping.
 */
class SttRelayClientTest {
    private val server = MockWebServer()
    private val textFrames = LinkedBlockingQueue<String>()
    private val binaryFrames = LinkedBlockingQueue<ByteString>()
    private val serverSocket = CompletableDeferred<WebSocket>()
    private val serverSawClose = AtomicBoolean(false)
    private var client: SttRelayClient? = null

    @After
    fun tearDown() {
        client?.cancel()
        server.shutdown()
    }

    /** Queue a successful upgrade whose server side records everything it sees. */
    private fun enqueueUpgrade() {
        server.enqueue(
            MockResponse()
                .withWebSocketUpgrade(
                    object : WebSocketListener() {
                        override fun onOpen(webSocket: WebSocket, response: Response) {
                            serverSocket.complete(webSocket)
                        }

                        override fun onMessage(webSocket: WebSocket, text: String) {
                            textFrames.put(text)
                        }

                        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                            binaryFrames.put(bytes)
                        }

                        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                            serverSawClose.set(true)
                            // Complete the handshake so MockWebServer.shutdown()
                            // is not left waiting on a half-closed socket.
                            webSocket.close(1000, null)
                        }
                    }
                )
        )
    }

    private fun newClient(
        feature: String = SttRelayClient.Feature.MEETING,
        languageHints: List<String>? = null,
    ): SttRelayClient {
        val created =
            SttRelayClient(
                SttRelayClient.Options(
                    bearerToken = "cloud-token",
                    relayUrl = server.url("/stt/stream").toString(),
                    languageHints = languageHints,
                    feature = feature,
                )
            )
        client = created
        return created
    }

    private fun take(queue: LinkedBlockingQueue<String>): String {
        val frame = queue.poll(5, TimeUnit.SECONDS)
        assertNotNull("expected a frame within 5s", frame)
        return frame!!
    }

    @Test
    fun handshakeCarriesBearerAndFeatureAndKeylessConfig(): Unit = runBlocking {
        enqueueUpgrade()
        val relay = newClient(feature = SttRelayClient.Feature.VOICE_TYPING, languageHints = listOf("zh", "en"))
        relay.connect()

        val request = server.takeRequest(5, TimeUnit.SECONDS)
        assertNotNull(request)
        assertEquals("/stt/stream?feature=voice_typing", request!!.path)
        assertEquals("Bearer cloud-token", request.getHeader("Authorization"))

        val config = take(textFrames)
        assertFalse("relay mode must not send a vendor key field", config.contains("api_key"))
        assertTrue(config.contains("\"audio_format\":\"pcm_s16le\""))
        assertTrue(config.contains("\"language_hints\":[\"zh\",\"en\"]"))
    }

    @Test
    fun tokenFramesSurfaceAsSegments(): Unit = runBlocking {
        enqueueUpgrade()
        val relay = newClient()
        relay.connect()
        take(textFrames) // config

        serverSocket.await().send(
            """{"tokens":[{"text":"Deal.","is_final":true,"start_ms":0,"end_ms":400,"speaker":"2"}]}"""
        )

        val event = withTimeout(5_000) { relay.events.first() }
        assertTrue(event is SttRelayEvent.Segment)
        val segment = (event as SttRelayEvent.Segment).segment
        assertEquals("mix-0", segment.id)
        assertEquals("Deal.", segment.text)
        assertEquals(2, segment.speaker)
    }

    @Test
    fun pcmIsSentAsLittleEndianBinaryFrames(): Unit = runBlocking {
        enqueueUpgrade()
        val relay = newClient()
        relay.connect()
        take(textFrames) // config

        relay.sendPcm(shortArrayOf(0x0102, -2))

        val frame = binaryFrames.poll(5, TimeUnit.SECONDS)
        assertNotNull(frame)
        assertEquals("0201feff", frame!!.hex())
    }

    @Test
    fun finishSendsFinalizeAndLeavesTheSocketOpen(): Unit = runBlocking {
        enqueueUpgrade()
        val relay = newClient()
        relay.connect()
        take(textFrames) // config

        relay.finish()

        assertEquals(SonioxProtocol.FINALIZE_FRAME, take(textFrames))
        // The relay must be free to flush the tail: closing here would truncate
        // the last utterance.
        Thread.sleep(200)
        assertFalse("finalize must not close the socket", serverSawClose.get())
        assertFalse(relay.isTerminated)
    }

    @Test
    fun finishedMarkerEndsTheStream(): Unit = runBlocking {
        enqueueUpgrade()
        val relay = newClient()
        relay.connect()
        take(textFrames) // config

        serverSocket.await().send("""{"tokens":[{"text":"<fin>","is_final":true}],"finished":true}""")

        val closed = withTimeout(5_000) { relay.events.first { it is SttRelayEvent.Closed } }
        assertEquals("finished", (closed as SttRelayEvent.Closed).reason)
    }

    @Test
    fun serverCloseReportsCodeAndReason(): Unit = runBlocking {
        enqueueUpgrade()
        val relay = newClient()
        relay.connect()
        take(textFrames) // config

        serverSocket.await().close(1000, "drained")

        val closed = withTimeout(5_000) { relay.events.first { it is SttRelayEvent.Closed } }
        assertEquals("close code=1000 drained", (closed as SttRelayEvent.Closed).reason)
    }

    @Test
    fun inBandErrorFrameSurfacesQuotaExceeded(): Unit = runBlocking {
        enqueueUpgrade()
        val relay = newClient()
        relay.connect()
        take(textFrames) // config

        serverSocket.await().send("""{"error_code":402,"error_message":"quota_exhausted"}""")

        val event = withTimeout(5_000) { relay.events.first() }
        assertTrue(event is SttRelayEvent.QuotaExceeded)
        assertEquals("relay error 402: quota_exhausted", (event as SttRelayEvent.QuotaExceeded).message)
    }

    @Test
    fun inBandErrorFrameSurfacesGenericError(): Unit = runBlocking {
        enqueueUpgrade()
        val relay = newClient()
        relay.connect()
        take(textFrames) // config

        serverSocket.await().send("""{"error_code":500,"error_message":"upstream exploded"}""")

        val event = withTimeout(5_000) { relay.events.first() }
        assertTrue(event is SttRelayEvent.Error)
        assertEquals("relay error 500: upstream exploded", (event as SttRelayEvent.Error).message)
    }

    @Test
    fun rejectedHandshakeSurfacesQuotaExceeded(): Unit = runBlocking {
        // The relay refuses the upgrade with 402 when the account is out of
        // hosted STT seconds (`{"error":"quota_exhausted"}`).
        server.enqueue(MockResponse().setResponseCode(402).setBody("""{"error":"quota_exhausted"}"""))
        val relay = newClient()
        relay.connect()

        val event = withTimeout(5_000) { relay.events.first() }
        assertTrue(event is SttRelayEvent.QuotaExceeded)
        assertTrue((event as SttRelayEvent.QuotaExceeded).message.contains("402"))
    }

    @Test
    fun rejectedHandshakeSurfacesError(): Unit = runBlocking {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"unauthorized"}"""))
        val relay = newClient()
        relay.connect()

        val event = withTimeout(5_000) { relay.events.first() }
        assertTrue(event is SttRelayEvent.Error)
        assertTrue((event as SttRelayEvent.Error).message.contains("401"))
    }
}
