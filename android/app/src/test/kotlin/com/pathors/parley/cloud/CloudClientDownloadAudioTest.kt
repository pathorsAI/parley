package com.pathors.parley.cloud

import java.io.File
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * `GET /recordings/{id}/audio` writing to disk.
 *
 * The endpoint has existed since the cloud client was written and had no
 * caller at all, so this is its first exercise. What has to hold is the promise
 * the `.part` file is there to make: **an interrupted download never leaves
 * something that looks playable.** A truncated Ogg that opened and then stopped
 * halfway through a meeting would be worse than no audio, because nothing on
 * the screen would say what happened.
 */
class CloudClientDownloadAudioTest {

    @get:Rule
    val temporary = TemporaryFolder()

    private val server = MockWebServer()

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun client(): CloudClient = CloudClient(
        baseUrl = server.url("/").toString(),
        tokenProvider = { "session-token" },
    )

    private fun blob(size: Int): ByteArray = ByteArray(size) { (it % 251).toByte() }

    @Test
    fun `streams the blob to the destination and authenticates`() = runBlocking {
        val body = blob(200_000)
        server.enqueue(MockResponse().setResponseCode(200).setBody(Buffer().write(body)))
        val destination = File(temporary.newFolder("Audio"), "rec-1.ogg")

        client().downloadAudio("rec-1", destination)

        assertArrayEquals(body, destination.readBytes())
        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/recordings/rec-1/audio", request.path)
        assertEquals("Bearer session-token", request.getHeader("Authorization"))
    }

    @Test
    fun `creates the directory it was pointed at`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody(Buffer().write(blob(64))))
        val destination = File(temporary.root, "not/made/yet/rec-1.ogg")

        client().downloadAudio("rec-1", destination)

        assertTrue(destination.isFile)
    }

    @Test
    fun `progress runs from zero to the full declared length`() = runBlocking {
        val body = blob(300_000)
        server.enqueue(MockResponse().setResponseCode(200).setBody(Buffer().write(body)))
        val destination = File(temporary.newFolder("Audio"), "rec-1.ogg")
        val reports = mutableListOf<Pair<Long, Long>>()

        client().downloadAudio("rec-1", destination) { read, total -> reports += read to total }

        assertTrue("expected more than one report, got ${reports.size}", reports.size > 2)
        assertEquals(0L to 300_000L, reports.first())
        assertEquals(300_000L to 300_000L, reports.last())
        // Monotonic, and never claiming more than arrived.
        reports.zipWithNext { earlier, later -> assertTrue(earlier.first <= later.first) }
        assertTrue(reports.all { (read, total) -> read <= total })
    }

    @Test
    fun `a response with no declared length reports minus one as the total`() = runBlocking {
        val body = blob(70_000)
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setChunkedBody(Buffer().write(body), 8_192)
        )
        val destination = File(temporary.newFolder("Audio"), "rec-1.ogg")
        val totals = mutableListOf<Long>()

        client().downloadAudio("rec-1", destination) { _, total -> totals += total }

        // Chunked: the length is unknown until the last byte, and the UI needs
        // to be told that rather than shown a bar stuck at zero.
        assertTrue(totals.dropLast(1).all { it == -1L })
        // The final call always reports a real total, so a bar finishes at 1.
        assertEquals(70_000L, totals.last())
        assertEquals(70_000, destination.length().toInt())
    }

    @Test
    fun `a 404 leaves nothing on disk, not even a part file`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not_found"}"""))
        val directory = temporary.newFolder("Audio")
        val destination = File(directory, "rec-1.ogg")

        val error = runCatching { client().downloadAudio("rec-1", destination) }.exceptionOrNull()

        assertTrue(error is CloudException)
        assertTrue((error as CloudException).isNotFound)
        assertFalse(destination.exists())
        assertEquals(0, directory.listFiles()!!.size)
    }

    @Test
    fun `a broken connection mid-body leaves no playable-looking file`() = runBlocking {
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody(Buffer().write(blob(500_000)))
                .setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY)
        )
        val directory = temporary.newFolder("Audio")
        val destination = File(directory, "rec-1.ogg")

        runCatching { client().downloadAudio("rec-1", destination) }

        assertFalse("a half file that opens is the whole hazard", destination.exists())
        assertEquals(
            "the .part file has to go too",
            0,
            directory.listFiles()!!.size,
        )
    }

    @Test
    fun `a failed re-download does not destroy the copy already on the phone`() = runBlocking {
        val directory = temporary.newFolder("Audio")
        val destination = File(directory, "rec-1.ogg")
        val existing = blob(1_000)
        destination.writeBytes(existing)

        server.enqueue(MockResponse().setResponseCode(500).setBody("boom"))
        runCatching { client().downloadAudio("rec-1", destination) }

        assertArrayEquals(existing, destination.readBytes())
    }

    @Test
    fun `a successful re-download replaces the old file`() = runBlocking {
        val directory = temporary.newFolder("Audio")
        val destination = File(directory, "rec-1.ogg")
        destination.writeBytes(blob(10))

        val body = blob(4_096)
        server.enqueue(MockResponse().setResponseCode(200).setBody(Buffer().write(body)))
        client().downloadAudio("rec-1", destination)

        assertArrayEquals(body, destination.readBytes())
        assertEquals(1, directory.listFiles()!!.size)
    }
}
