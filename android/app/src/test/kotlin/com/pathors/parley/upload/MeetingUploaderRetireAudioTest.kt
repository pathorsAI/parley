package com.pathors.parley.upload

import com.pathors.parley.cloud.CloudClient
import com.pathors.parley.playback.LocalAudioStore
import java.io.File
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
 * What happens to a finished meeting's Ogg once the cloud has it.
 *
 * Before playback existed the answer was always "deleted", which is why nothing
 * recorded on the phone could be played back on the phone. Now it is a setting,
 * and these are the two ends of it plus the case that has to keep working when
 * the store refuses the file.
 */
class MeetingUploaderRetireAudioTest {

    @get:Rule
    val temporary = TemporaryFolder()

    private val server = MockWebServer()

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun cloud(): CloudClient = CloudClient(
        baseUrl = server.url("/").toString(),
        tokenProvider = { "session-token" },
    )

    /** A 200 for the audio PUT and a 200 for the meta POST. */
    private fun enqueueSuccessfulUpload() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"updatedAt":1}"""))
    }

    private fun queueWith(id: String): Pair<PendingUploadQueue, File> {
        val queue = PendingUploadQueue(temporary.newFolder("PendingUploads-$id"))
        val incoming = temporary.newFile("$id-source.ogg").apply {
            writeBytes(ByteArray(512) { it.toByte() })
        }
        queue.enqueue(
            PendingUpload(
                id = id,
                title = "Renewal terms",
                startedAtMs = 1_700_000_000_000,
                durationMs = 61_000.0,
            ),
            incoming,
        )
        return queue to queue.audioFile(id)
    }

    private fun uploader(
        queue: PendingUploadQueue,
        store: LocalAudioStore?,
        keep: Boolean,
    ) = MeetingUploader(
        cloud = cloud(),
        queue = queue,
        localAudio = store,
        keepsAudioOnPhone = { keep },
    )

    @Test
    fun `keeping audio moves the Ogg into the local store`() = runBlocking {
        val (queue, audio) = queueWith("rec-keep")
        val store = LocalAudioStore(temporary.newFolder("Audio-keep"))
        enqueueSuccessfulUpload()

        val result = uploader(queue, store, keep = true).drain()

        assertEquals(1, result.uploaded)
        assertEquals(0, result.remaining)
        assertTrue("the recording should be playable here", store.has("rec-keep"))
        assertEquals(512L, store.audioFile("rec-keep").length())
        assertFalse("the queue's copy must not survive", audio.exists())
    }

    @Test
    fun `not keeping audio deletes the Ogg, as it always did`() = runBlocking {
        val (queue, audio) = queueWith("rec-drop")
        val store = LocalAudioStore(temporary.newFolder("Audio-drop"))
        enqueueSuccessfulUpload()

        val result = uploader(queue, store, keep = false).drain()

        assertEquals(1, result.uploaded)
        assertFalse(store.has("rec-drop"))
        assertFalse(audio.exists())
        assertEquals(0L, store.totalBytes())
    }

    @Test
    fun `an uploader with nowhere to keep audio deletes it`() = runBlocking {
        val (queue, audio) = queueWith("rec-nostore")
        enqueueSuccessfulUpload()

        uploader(queue, store = null, keep = true).drain()

        assertFalse(audio.exists())
    }

    @Test
    fun `a failed upload keeps the recording queued and its audio where it is`() = runBlocking {
        val (queue, audio) = queueWith("rec-offline")
        val store = LocalAudioStore(temporary.newFolder("Audio-offline"))
        // 401: not retried within the pass, and not a refusal that drops the
        // recording either (signing in again clears it), so the pass stops with
        // the queue untouched. A 400 used to serve here; it is now dropped, as
        // on iOS — see MeetingUploaderDrainTest.
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"unauthorized"}"""))

        val result = uploader(queue, store, keep = true).drain()

        assertEquals(0, result.uploaded)
        assertEquals(1, result.remaining)
        assertTrue("the only copy must not be retired before it has synced", audio.exists())
        assertFalse(store.has("rec-offline"))
    }

    @Test
    fun `the manifest is dropped either way`() = runBlocking {
        val (queue, _) = queueWith("rec-manifest")
        val store = LocalAudioStore(temporary.newFolder("Audio-manifest"))
        enqueueSuccessfulUpload()

        uploader(queue, store, keep = true).drain()

        assertEquals(0, queue.count())
        assertFalse(queue.manifestFile("rec-manifest").exists())
    }

    @Test
    fun `a misfire shorter than two seconds is never kept`() = runBlocking {
        val store = LocalAudioStore(temporary.newFolder("Audio-short"))
        val queue = PendingUploadQueue(temporary.newFolder("PendingUploads-short"))
        val incoming = temporary.newFile("short.ogg").apply { writeBytes(ByteArray(16)) }

        val id = uploader(queue, store, keep = true).enqueue(
            EnqueueRequest(
                audio = incoming,
                title = "Tapped by accident",
                durationMs = 900.0,
            )
        )

        assertEquals(null, id)
        assertFalse(incoming.exists())
        // A two-second tap of the record button was never a recording, so it
        // must not show up in the storage total the account sheet reports.
        assertEquals(0L, store.totalBytes())
    }

    @Test
    fun `an imported file is kept even when it is short`() = runBlocking {
        val store = LocalAudioStore(temporary.newFolder("Audio-import"))
        val queue = PendingUploadQueue(temporary.newFolder("PendingUploads-import"))
        val incoming = temporary.newFile("clip.ogg").apply { writeBytes(ByteArray(64)) }
        enqueueSuccessfulUpload()

        val uploader = uploader(queue, store, keep = true)
        uploader.enqueue(
            EnqueueRequest(
                audio = incoming,
                title = "clip.ogg",
                durationMs = 900.0,
                source = com.pathors.parley.cloud.RecordingSource.UPLOAD,
                id = "rec-import",
            )
        )
        uploader.drain()

        assertTrue(store.has("rec-import"))
    }
}
