package com.pathors.parley.upload

import com.pathors.parley.cloud.CloudClient
import com.pathors.parley.cloud.TranscriptSegmentDto
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
 * What the uploader does with a finished meeting's Ogg once the cloud has it,
 * now that "delete it" is not always the answer.
 *
 * Before this, a recording whose relay died silently was thin forever: the
 * transcript went up as it was and the only copy of the audio that could have
 * fixed it was deleted in the same breath. The decision now has three outcomes
 * and they are all here.
 */
class MeetingUploaderBackfillTest {

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

    /** One 60-second span of transcript, for a recording of [durationMs]. */
    private fun thin(durationMs: Double) = listOf(
        TranscriptSegmentDto(id = "mix-0", text = "hello", startMs = 0, endMs = 60_000),
    ).let { it to durationMs }

    private fun queueWith(
        id: String,
        durationMs: Double,
        segments: List<TranscriptSegmentDto>,
    ): PendingUploadQueue {
        val queue = PendingUploadQueue(temporary.newFolder("PendingUploads-$id"))
        val incoming = temporary.newFile("$id-source.ogg").apply {
            writeBytes(ByteArray(512) { it.toByte() })
        }
        queue.enqueue(
            PendingUpload(
                id = id,
                title = "Renewal terms",
                startedAtMs = 1_700_000_000_000,
                durationMs = durationMs,
                segments = segments,
            ),
            incoming,
        )
        return queue
    }

    private fun uploader(
        queue: PendingUploadQueue,
        backfills: PendingBackfillQueue? = null,
        store: LocalAudioStore? = null,
        keep: Boolean = false,
    ) = MeetingUploader(
        cloud = cloud(),
        queue = queue,
        backfills = backfills,
        localAudio = store,
        keepsAudioOnPhone = { keep },
    )

    @Test
    fun `a transcript that covers the recording retires the audio as before`() = runBlocking {
        val segments = (0L until 10L).map {
            TranscriptSegmentDto(
                id = "mix-$it",
                text = "x",
                startMs = it * 60_000,
                endMs = (it + 1) * 60_000,
            )
        }
        val queue = queueWith("rec-whole", durationMs = 600_000.0, segments = segments)
        val backfills = PendingBackfillQueue(temporary.newFolder("Backfills-whole"))
        enqueueSuccessfulUpload()

        val result = uploader(queue, backfills).drain()

        assertEquals(1, result.uploaded)
        assertEquals(0, backfills.count())
        assertFalse(queue.audioFile("rec-whole").exists())
    }

    @Test
    fun `a transcript that came up short hands the Ogg to the backfill queue`() = runBlocking {
        // 60 seconds of transcript for 49 minutes of audio: the reported
        // failure. The Ogg is the only thing that can still fix it, so it must
        // not be deleted with the queue entry.
        val (segments, durationMs) = thin(2_953_000.0)
        val queue = queueWith("rec-thin", durationMs, segments)
        val backfills = PendingBackfillQueue(temporary.newFolder("Backfills-thin"))
        enqueueSuccessfulUpload()

        val result = uploader(queue, backfills).drain()

        assertEquals(1, result.uploaded)
        assertEquals("the upload queue is done with it", 0, queue.count())
        assertEquals(1, backfills.count())
        assertEquals(512L, backfills.audioFile("rec-thin").length())
        val request = backfills.request("rec-thin")!!
        assertFalse("an automatic backfill is not charged to anybody", request.isManual)
        assertEquals("the transcript it is replacing travels with it", segments, request.pending.segments)
    }

    @Test
    fun `keeping audio on the phone does not rob the backfill of its only copy`() = runBlocking {
        // The retention setting decides what happens *after* a run, not instead
        // of one — a recording moved into the local store would leave the
        // backfill queue holding a manifest with no audio.
        val (segments, durationMs) = thin(2_953_000.0)
        val queue = queueWith("rec-keep", durationMs, segments)
        val backfills = PendingBackfillQueue(temporary.newFolder("Backfills-keep"))
        val store = LocalAudioStore(temporary.newFolder("Audio-keep"))
        enqueueSuccessfulUpload()

        uploader(queue, backfills, store, keep = true).drain()

        assertEquals(1, backfills.count())
        assertTrue(backfills.audioFile("rec-keep").isFile)
        assertFalse("not yet — the run has not happened", store.has("rec-keep"))
    }

    @Test
    fun `an uploader with no backfill queue behaves exactly as it used to`() = runBlocking {
        // The default. A test asking about upload retries should not have to
        // hand over a safety net it is not testing.
        val (segments, durationMs) = thin(2_953_000.0)
        val queue = queueWith("rec-none", durationMs, segments)
        enqueueSuccessfulUpload()

        val result = uploader(queue, backfills = null).drain()

        assertEquals(1, result.uploaded)
        assertFalse(queue.audioFile("rec-none").exists())
    }

    @Test
    fun `a manifest whose blob is gone is still discarded, not retried forever`() = runBlocking {
        // The protection that keeps one broken entry from wedging the queue
        // head. Adding a backfill branch after the upload must not lose it.
        val (segments, durationMs) = thin(2_953_000.0)
        val queue = queueWith("rec-orphan", durationMs, segments)
        val backfills = PendingBackfillQueue(temporary.newFolder("Backfills-orphan"))
        queue.audioFile("rec-orphan").delete()

        val result = uploader(queue, backfills).drain()

        assertEquals(1, result.discarded)
        assertEquals(0, result.uploaded)
        assertEquals(0, queue.count())
        assertEquals("a recording with no audio has nothing to backfill", 0, backfills.count())
        assertEquals("and nothing was sent", 0, server.requestCount)
    }

    @Test
    fun `a backfill queue that cannot take the file does not fail the upload`() = runBlocking {
        // The recording is safely in the cloud by the time this runs. Failing to
        // queue a backfill costs quality, not the meeting.
        val (segments, durationMs) = thin(2_953_000.0)
        val queue = queueWith("rec-stuck", durationMs, segments)
        // A file where the queue wants its directory: every write below it
        // fails, which is the closest a unit test gets to a full disk.
        val blocked = File(temporary.root, "blocked").apply { writeText("not a directory") }
        enqueueSuccessfulUpload()

        val result = uploader(queue, PendingBackfillQueue(blocked)).drain()

        assertEquals(1, result.uploaded)
        assertEquals(null, result.failure)
        assertEquals(0, queue.count())
    }
}
