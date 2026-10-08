package com.pathors.parley.kit

import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.toList
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
 * Session behavior against a MockWebServer standing in for
 * `wss://api.parley.tw/stt/v2/stream`. The Swift suite has no equivalent
 * (URLSession has no in-process WebSocket fake), so these cover the wire
 * contract: the bearer + `?feature=` handshake, the start frame, `ready` as
 * "connected", end-without-close, and the terminal event mapping.
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
                            // Accept the start frame the way the service does.
                            if (text.contains("\"type\":\"start\"")) {
                                webSocket.send("""{"type":"ready","session_id":"test-session"}""")
                            }
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
    fun handshakeCarriesBearerAndFeatureAndStartFrame(): Unit = runBlocking {
        enqueueUpgrade()
        val relay = newClient(feature = SttRelayClient.Feature.VOICE_TYPING, languageHints = listOf("zh", "en"))
        relay.connect()

        val request = server.takeRequest(5, TimeUnit.SECONDS)
        assertNotNull(request)
        // A v1-style URL is moved to the v2 path.
        assertEquals("/stt/v2/stream?feature=voice_typing", request!!.path)
        assertEquals("Bearer cloud-token", request.getHeader("Authorization"))

        val start = take(textFrames)
        assertTrue(start.startsWith("{\"type\":\"start\""))
        assertTrue(start.contains("\"audio\":{\"encoding\":\"pcm_s16le\",\"sample_rate\":16000,\"channels\":1}"))
        assertTrue(start.contains("\"languages\":[\"zh\",\"en\"]"))
        assertTrue(start.contains("\"diarization\":true"))
        assertTrue(start.contains("\"endpointing\":true"))
        assertFalse("no terms, no hints", start.contains("hints"))
    }

    @Test
    fun connectResolvesOnReady(): Unit = runBlocking {
        enqueueUpgrade()
        val relay = newClient()
        withTimeout(5_000) { relay.connect() }
        assertEquals("test-session", relay.sessionId)
        assertFalse(relay.isTerminated)
    }

    @Test
    fun tokenFramesSurfaceAsSegments(): Unit = runBlocking {
        enqueueUpgrade()
        val relay = newClient()
        relay.connect()
        take(textFrames) // start

        serverSocket.await().send(
            """{"type":"transcript","tokens":[{"text":"Deal.","final":true,"start_ms":0,"end_ms":400,"speaker":2}]}"""
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
        take(textFrames) // start

        relay.sendPcm(shortArrayOf(0x0102, -2))

        val frame = binaryFrames.poll(5, TimeUnit.SECONDS)
        assertNotNull(frame)
        assertEquals("0201feff", frame!!.hex())
    }

    @Test
    fun enqueuedPcmReachesTheWire(): Unit = runBlocking {
        enqueueUpgrade()
        val relay = newClient()
        relay.connect()
        take(textFrames) // start

        relay.enqueuePcm(shortArrayOf(0x0102, -2))

        val frame = binaryFrames.poll(5, TimeUnit.SECONDS)
        assertNotNull(frame)
        assertEquals("0201feff", frame!!.hex())
        assertEquals(0L, relay.droppedPcmChunks)
    }

    /**
     * The regression that cost recordings: `sendPcm` suspended until the socket
     * drained, the socket never drained, and because the live capture called it
     * from the same coroutine that fed the encoder, the microphone stopped being
     * read at all and the kernel dropped audio out of the .ogg file.
     *
     * A client that was never opened is exactly a socket that never drains —
     * nothing consumes the outbound queue — so this is the stall, reproduced.
     * The fix is that audio is dropped instead of the caller being held: the
     * loop must finish promptly, and the queue must stay bounded.
     */
    @Test(timeout = 60_000)
    fun enqueuePcmNeverWaitsForASocketThatIsNotDraining() {
        val relay = newClient() // deliberately never opened
        val chunk = ByteArray(3_200)
        val chunks = SttRelayClient.MAX_QUEUED_CHUNKS * 4

        val startedAt = System.nanoTime()
        repeat(chunks) { relay.enqueuePcm(chunk) }
        val elapsedMs = (System.nanoTime() - startedAt) / 1_000_000

        assertTrue("handing over $chunks chunks took ${elapsedMs}ms", elapsedMs < 5_000)
        assertTrue(
            "a queue that never drains must drop, not grow",
            relay.droppedPcmChunks > 0,
        )
    }

    @Test
    fun finishSendsEndAndLeavesTheSocketOpen(): Unit = runBlocking {
        enqueueUpgrade()
        val relay = newClient()
        relay.connect()
        take(textFrames) // start

        relay.finish()

        assertEquals(ParleyStreamProtocol.END_FRAME, take(textFrames))
        // The service must be free to flush the tail: closing here would
        // truncate the last utterance.
        Thread.sleep(200)
        assertFalse("end must not close the socket", serverSawClose.get())
        assertFalse(relay.isTerminated)
    }

    @Test
    fun requestFinalizeSendsFinalizeAndKeepsStreaming(): Unit = runBlocking {
        enqueueUpgrade()
        val relay = newClient()
        relay.connect()
        take(textFrames) // start

        relay.requestFinalize()
        assertEquals(ParleyStreamProtocol.FINALIZE_FRAME, take(textFrames))

        relay.enqueuePcm(shortArrayOf(1))
        assertNotNull("audio may continue after finalize", binaryFrames.poll(5, TimeUnit.SECONDS))
        assertFalse(relay.isTerminated)
    }

    @Test
    fun tailThenDoneEndsTheStream(): Unit = runBlocking {
        enqueueUpgrade()
        val relay = newClient()
        relay.connect()
        take(textFrames) // start
        relay.finish()
        take(textFrames) // end

        val socket = serverSocket.await()
        socket.send("""{"type":"transcript","tokens":[{"text":"Bye.","final":true,"start_ms":0,"end_ms":300,"speaker":1}]}""")
        socket.send("""{"type":"finalized"}""")
        socket.send("""{"type":"done"}""")

        val events = withTimeout(5_000) { relay.events.toList() }
        val committed = events.filterIsInstance<SttRelayEvent.Segment>().map { it.segment }.filter { it.isFinal }
        assertEquals("Bye.", committed.last().text)
        assertEquals(SttRelayEvent.Closed("finished"), events.last())
        assertTrue(relay.isTerminated)
    }

    @Test
    fun endYieldsFinalizedTwiceThenDoneAndTheFlowCompletes(): Unit = runBlocking {
        enqueueUpgrade()
        val relay = newClient()
        relay.connect()
        take(textFrames) // start
        relay.requestFinalize()
        take(textFrames) // finalize
        relay.finish()
        take(textFrames) // end

        val socket = serverSocket.await()
        socket.send("""{"type":"finalized"}""")
        socket.send("""{"type":"finalized"}""")
        socket.send("""{"type":"done"}""")
        socket.close(1000, "done")

        // A collector that joins (rather than polling isTerminated) must return.
        val events = withTimeout(5_000) { relay.events.toList() }
        assertEquals(listOf<SttRelayEvent>(SttRelayEvent.Closed("finished")), events)
    }

    @Test
    fun upstreamUnavailableRightAfterTheUpgradeIsAnErrorAndUnblocksConnect(): Unit = runBlocking {
        // The recognizer cannot be reached: the upgrade succeeds, no `ready`,
        // then an error frame and close 1011.
        server.enqueue(
            MockResponse().withWebSocketUpgrade(
                object : WebSocketListener() {
                    override fun onMessage(webSocket: WebSocket, text: String) {
                        webSocket.send(
                            """{"type":"error","code":"upstream_unavailable","message":"Transcription is unavailable."}"""
                        )
                        webSocket.close(1011, "upstream_unavailable")
                    }

                    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                        webSocket.close(1000, null)
                    }
                }
            )
        )
        val relay = newClient()
        withTimeout(5_000) { relay.connect() }

        val events = withTimeout(5_000) { relay.events.toList() }
        assertEquals(1, events.size)
        val error = events.single() as SttRelayEvent.Error
        assertEquals("relay error upstream_unavailable: Transcription is unavailable.", error.message)
        assertEquals(null, error.httpStatus)
        assertTrue(relay.isTerminated)
    }

    @Test
    fun rejectedUpgradeWith426IsAnErrorWithItsStatus(): Unit = runBlocking {
        server.enqueue(MockResponse().setResponseCode(426).setBody("Upgrade Required"))
        val relay = newClient()
        relay.connect()

        val event = withTimeout(5_000) { relay.events.first() }
        assertEquals(426, (event as SttRelayEvent.Error).httpStatus)
    }

    @Test
    fun serverCloseReportsCodeAndReason(): Unit = runBlocking {
        enqueueUpgrade()
        val relay = newClient()
        relay.connect()
        take(textFrames) // start

        serverSocket.await().close(1000, "drained")

        val closed = withTimeout(5_000) { relay.events.first { it is SttRelayEvent.Closed } }
        assertEquals("close code=1000 drained", (closed as SttRelayEvent.Closed).reason)
    }

    @Test
    fun inBandErrorFrameSurfacesQuotaExceeded(): Unit = runBlocking {
        enqueueUpgrade()
        val relay = newClient()
        relay.connect()
        take(textFrames) // start

        serverSocket.await().send("""{"type":"error","code":"quota_exceeded","message":"Quota exhausted."}""")

        val event = withTimeout(5_000) { relay.events.first() }
        assertTrue(event is SttRelayEvent.QuotaExceeded)
        assertEquals(
            "relay error quota_exceeded: Quota exhausted.",
            (event as SttRelayEvent.QuotaExceeded).message,
        )
    }

    @Test
    fun inBandErrorFrameSurfacesGenericError(): Unit = runBlocking {
        enqueueUpgrade()
        val relay = newClient()
        relay.connect()
        take(textFrames) // start

        serverSocket.await().send(
            """{"type":"error","code":"upstream_unavailable","message":"Transcription is unavailable."}"""
        )

        val event = withTimeout(5_000) { relay.events.first() }
        assertTrue(event is SttRelayEvent.Error)
        assertEquals(
            "relay error upstream_unavailable: Transcription is unavailable.",
            (event as SttRelayEvent.Error).message,
        )
        // A stream error is not a verdict on the caller's sign-in.
        assertEquals(null, event.httpStatus)
    }

    @Test
    fun quotaCloseWithoutAnErrorFrameStillReadsAsQuota(): Unit = runBlocking {
        enqueueUpgrade()
        val relay = newClient()
        relay.connect()
        take(textFrames) // start

        serverSocket.await().close(4402, "quota_exceeded")

        val event = withTimeout(5_000) { relay.events.first() }
        assertTrue(event is SttRelayEvent.QuotaExceeded)
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
        assertEquals(401, event.httpStatus)
        assertTrue(event.isUnauthorized)
    }

    @Test
    fun rejectedHandshakeCarriesItsStatus(): Unit = runBlocking {
        // 429 too_many_sessions: a wait, not a dead session.
        server.enqueue(MockResponse().setResponseCode(429).setBody("""{"error":"too_many_sessions"}"""))
        val relay = newClient()
        relay.connect()

        val event = withTimeout(5_000) { relay.events.first() }
        assertTrue(event is SttRelayEvent.Error)
        assertEquals(429, (event as SttRelayEvent.Error).httpStatus)
        assertFalse(event.isUnauthorized)
    }
}
