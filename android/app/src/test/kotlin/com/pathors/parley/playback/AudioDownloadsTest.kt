package com.pathors.parley.playback

import com.pathors.parley.cloud.CloudClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.util.concurrent.TimeUnit

/**
 * The shared downloader behind the library row's menu, the player and
 * re-transcription. What has to hold is what iOS `AudioDownloadModel` learned:
 * a second caller joins the first download instead of racing it, a failure is a
 * state the row can show, and "on this phone" follows the store.
 */
class AudioDownloadsTest {

    @get:Rule
    val temporary = TemporaryFolder()

    private val server = MockWebServer()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @After
    fun tearDown() {
        scope.cancel()
        server.shutdown()
    }

    private fun downloads(store: LocalAudioStore): AudioDownloads = AudioDownloads(
        cloud = CloudClient(baseUrl = server.url("/").toString(), tokenProvider = { "token" }),
        store = store,
        scope = scope,
        logFailure = { _, _ -> },
    )

    private fun blob(size: Int): ByteArray = ByteArray(size) { (it % 251).toByte() }

    @Test
    fun `a finished download is on the phone and nothing is left in flight`() = runBlocking {
        server.enqueue(MockResponse().setBody(Buffer().write(blob(4_096))))
        val store = LocalAudioStore(temporary.newFolder("Audio"))
        val downloads = downloads(store)

        assertEquals(AudioDownloadState.Absent, downloads.state("rec-1"))
        assertEquals(AudioDownloadOutcome.Done, downloads.download("rec-1"))

        assertTrue(store.has("rec-1"))
        assertEquals(AudioDownloadState.Local, downloads.state("rec-1"))
        assertTrue(downloads.active.value.isEmpty())
    }

    @Test
    fun `a 404 is a failure the row keeps, and says there is no audio`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(404))
        val store = LocalAudioStore(temporary.newFolder("Audio"))
        val downloads = downloads(store)

        val outcome = downloads.download("rec-1")

        assertEquals(AudioDownloadOutcome.Failed(PlaybackFailure.DOWNLOAD_MISSING), outcome)
        assertEquals(
            AudioDownloadState.Failed(PlaybackFailure.DOWNLOAD_MISSING),
            downloads.state("rec-1"),
        )
        assertFalse(store.has("rec-1"))
    }

    @Test
    fun `a retry after a failure clears it`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(503))
        server.enqueue(MockResponse().setBody(Buffer().write(blob(64))))
        val downloads = downloads(LocalAudioStore(temporary.newFolder("Audio")))

        downloads.download("rec-1")
        assertTrue(downloads.state("rec-1") is AudioDownloadState.Failed)

        assertEquals(AudioDownloadOutcome.Done, downloads.download("rec-1"))
        assertEquals(AudioDownloadState.Local, downloads.state("rec-1"))
    }

    @Test
    fun `a second caller joins the running download instead of starting another`() = runBlocking {
        // Slow enough that the second request arrives while the first is running.
        server.enqueue(
            MockResponse()
                .setBody(Buffer().write(blob(64_000)))
                .throttleBody(16_000, 100, TimeUnit.MILLISECONDS),
        )
        val downloads = downloads(LocalAudioStore(temporary.newFolder("Audio")))

        downloads.requestDownload("rec-1")
        assertTrue(downloads.isDownloading("rec-1"))
        val second = async { downloads.download("rec-1") }

        assertEquals(AudioDownloadOutcome.Done, second.await())
        assertEquals(1, server.requestCount)
        assertEquals(AudioDownloadState.Local, downloads.state("rec-1"))
    }

    @Test
    fun `removing a download gives the bytes back and the row goes back to absent`() = runBlocking {
        server.enqueue(MockResponse().setBody(Buffer().write(blob(64))))
        val store = LocalAudioStore(temporary.newFolder("Audio"))
        val downloads = downloads(store)
        downloads.download("rec-1")

        downloads.removeDownload("rec-1")
        // The removal runs on the scope; wait for the store and the snapshot.
        repeat(50) {
            if (downloads.state("rec-1") == AudioDownloadState.Absent) return@repeat
            Thread.sleep(20)
        }

        assertFalse(store.has("rec-1"))
        assertEquals(AudioDownloadState.Absent, downloads.state("rec-1"))
    }

    @Test
    fun `remove all empties the store and forgets failures`() = runBlocking {
        server.enqueue(MockResponse().setBody(Buffer().write(blob(64))))
        server.enqueue(MockResponse().setResponseCode(503))
        val store = LocalAudioStore(temporary.newFolder("Audio"))
        val downloads = downloads(store)
        downloads.download("rec-1")
        downloads.download("rec-2")

        downloads.removeAll()

        assertEquals(0, store.count())
        assertEquals(AudioDownloadState.Absent, downloads.state("rec-1"))
        assertEquals(AudioDownloadState.Absent, downloads.state("rec-2"))
    }

    @Test
    fun `refresh finds audio that arrived without passing through the downloader`() = runBlocking {
        val store = LocalAudioStore(temporary.newFolder("Audio"))
        val downloads = downloads(store)
        // What the uploader does with a meeting it keeps on the phone.
        store.put("kept", temporary.newFile("kept.ogg").apply { writeBytes(blob(16)) })

        assertEquals(AudioDownloadState.Absent, downloads.state("kept"))
        downloads.refresh()
        assertEquals(AudioDownloadState.Local, downloads.state("kept"))
    }

    @Test
    fun `demo mode never reaches the network`() = runBlocking {
        val downloads = AudioDownloads(
            cloud = CloudClient(baseUrl = server.url("/").toString(), tokenProvider = { "token" }),
            store = LocalAudioStore(temporary.newFolder("Audio")),
            scope = scope,
            isDemo = { true },
        )

        downloads.requestDownload("rec-1")
        downloads.download("rec-1")

        assertEquals(0, server.requestCount)
        assertEquals(AudioDownloadState.Absent, downloads.state("rec-1"))
    }
}
