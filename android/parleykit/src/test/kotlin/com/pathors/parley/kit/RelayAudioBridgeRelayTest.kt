package com.pathors.parley.kit

import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
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
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [RelayAudioBridge] driving real [SttRelayClient]s across a reconnect, against
 * a MockWebServer standing in for the relay — the same sequence
 * `MeetingSession` runs: leg 0 attached before its socket is up, the server
 * drops it, the bridge holds while the meeting keeps talking, and leg 1 is
 * created from the bridge's offset and handed the gap before any live audio.
 *
 * What this proves that [RelayAudioBridgeTest] cannot: the client accepts audio
 * before `open()` without losing it (which is what lets the bridge flush into a
 * leg whose handshake has not happened yet), and the offset the bridge hands
 * out really does move the new leg's timestamps.
 */
class RelayAudioBridgeRelayTest {
    private val server = MockWebServer()
    private val clients = mutableListOf<SttRelayClient>()

    @After
    fun tearDown() {
        clients.forEach { it.cancel() }
        server.shutdown()
    }

    /** The server side of one relay connection. */
    private class ServerLeg {
        val socket = CompletableDeferred<WebSocket>()
        val text = LinkedBlockingQueue<String>()
        val binary = LinkedBlockingQueue<ByteString>()

        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                socket.complete(webSocket)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                this@ServerLeg.text.put(text)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                binary.put(bytes)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }
        }

        fun nextMarker(): Int {
            val frame = binary.poll(5, TimeUnit.SECONDS)
            assertNotNull("expected an audio frame within 5s", frame)
            val bytes = frame!!.toByteArray()
            return (bytes[0].toInt() and 0xFF) or ((bytes[1].toInt() and 0xFF) shl 8)
        }
    }

    private fun enqueueLeg(): ServerLeg {
        val leg = ServerLeg()
        server.enqueue(MockResponse().withWebSocketUpgrade(leg.listener))
        return leg
    }

    private fun newClient(leg: Int, timeOffsetMs: Long): SttRelayClient =
        SttRelayClient(
            SttRelayClient.Options(
                bearerToken = "cloud-token",
                relayUrl = server.url("/stt/stream").toString(),
                idPrefix = if (leg == 0) null else "${SttRelayClient.SOURCE}@$leg",
                timeOffsetMs = timeOffsetMs,
            )
        ).also { clients += it }

    @Test
    fun theGapReachesTheNextLegFirstAndIsStampedWhereItWasSaid(): Unit = runBlocking {
        val serverA = enqueueLeg()
        val serverB = enqueueLeg()
        val bridge = RelayAudioBridge()

        // Leg 0: attached before the socket is even opened, as the session does
        // so the microphone never waits on a handshake.
        val legA = newClient(leg = 0, timeOffsetMs = 0)
        bridge.attach(legA)
        repeat(20) { bridge.send(chunk(1)) } // two seconds
        legA.open()
        serverA.text.poll(5, TimeUnit.SECONDS) // config
        repeat(20) { assertEquals(1, serverA.nextMarker()) }

        // The relay drops the socket.
        serverA.socket.await().close(1001, "going away")
        val terminal = withTimeout(5_000) { legA.events.toList() }.last()
        assertTrue(terminal is SttRelayEvent.Closed)

        // The session's response to a terminal event: hold, and keep talking.
        bridge.hold()
        repeat(30) { bridge.send(chunk(2)) } // three seconds into the gap

        val legB = bridge.attach { offsetMs -> newClient(leg = 1, timeOffsetMs = offsetMs) }!!
        bridge.send(chunk(3)) // live again
        legB.open()
        serverB.text.poll(5, TimeUnit.SECONDS) // config

        repeat(30) { assertEquals("the gap goes out first", 2, serverB.nextMarker()) }
        assertEquals("then the audio that followed it", 3, serverB.nextMarker())

        // Soniox numbers the new session from zero; the leg's offset puts its
        // first word at the two-second mark, where the gap began.
        serverB.socket.await().send(
            """{"tokens":[{"text":"Still here.","is_final":true,"start_ms":0,"end_ms":600,"speaker":"1"}]}"""
        )
        val segment = (withTimeout(5_000) { legB.events.first() } as SttRelayEvent.Segment).segment
        assertEquals("mix@1-0", segment.id)
        assertEquals(2_000L, segment.startMs)
        assertEquals(2_600L, segment.endMs)
    }

    private fun chunk(marker: Int): ByteArray = ByteArray(3_200).also {
        it[0] = (marker and 0xFF).toByte()
        it[1] = ((marker shr 8) and 0xFF).toByte()
    }
}
