package com.pathors.parley.upload

import com.pathors.parley.cloud.CloudClient
import com.pathors.parley.cloud.CloudJson
import com.pathors.parley.cloud.RecordingMeta
import com.pathors.parley.cloud.TranscriptSegmentDto
import com.pathors.parley.library.SaveDestination
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * A queued upload tried again after its meta push may already have landed: it
 * must not overwrite what the cloud has learned about the recording since —
 * a rename, a folder, a filing suggestion — with the clock title it was queued
 * under.
 */
class MeetingUploaderRepushTest {

    @get:Rule
    val temporary = TemporaryFolder()

    private val server = MockWebServer()

    /** What the cloud holds for the recording; null = it does not have it. */
    @Volatile
    private var stored: JsonObject? = null

    /** Fail the share step this many more times (503). */
    @Volatile
    private var shareFailures = 0

    private val requests = CopyOnWriteArrayList<String>()

    @Before
    fun serveCloud() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                requests += "${request.method} $path"
                return when {
                    request.method == "PUT" -> ok("{}")
                    request.method == "GET" && path == "/recordings/$ID/meta" ->
                        stored?.let { ok(it.toString()) } ?: MockResponse().setResponseCode(404)
                    request.method == "POST" && path == "/recordings/$ID" -> {
                        val body = CloudJson.parseToJsonElement(request.body.readUtf8()).jsonObject
                        stored = body.getValue("meta").jsonObject
                        ok("""{"updatedAt":1}""")
                    }
                    request.method == "POST" && path == "/recordings/$ID/share" ->
                        if (shareFailures-- > 0) MockResponse().setResponseCode(503) else ok("{}")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun ok(body: String) = MockResponse().setResponseCode(200).setBody(body)

    private fun uploader(queue: PendingUploadQueue, destination: SaveDestination = SaveDestination.PERSONAL_ROOT) =
        MeetingUploader(
            cloud = CloudClient(baseUrl = server.url("/").toString(), tokenProvider = { "t" }),
            queue = queue,
            maxAttempts = 1,
            retryDelay = {},
            defaultDestination = { destination },
        )

    private fun pending(pushAttempted: Boolean) = PendingUpload(
        id = ID,
        title = CLOCK_TITLE,
        startedAtMs = 1_700_000_000_000,
        durationMs = 60_000.0,
        segments = listOf(TranscriptSegmentDto(id = "mix-0", text = SPOKEN, startMs = 0, endMs = 1_000)),
        folderId = "folder-q",
        pushAttempted = pushAttempted,
    )

    private fun queueWith(pending: PendingUpload): PendingUploadQueue {
        val queue = PendingUploadQueue(temporary.newFolder())
        val audio = temporary.newFile().apply { writeBytes(ByteArray(256) { 1 }) }
        queue.enqueue(pending, audio)
        return queue
    }

    /** The recording as the cloud holds it after the first push and a rename on the desktop. */
    private fun renamedInCloud() = buildJsonObject {
        MeetingUploader.buildMeta(pending(false)).raw.forEach { (key, value) ->
            if (key != "title" && key != "folderId") put(key, value)
        }
        put("title", RENAMED)
        put("folderId", JsonNull)
        put("filingSuggested", true)
        putJsonObject("filingSuggestion") {
            put("title", "Acme renewal")
            putJsonArray("folders") {}
        }
        put("brief", "desktop analysis")
    }

    @Test
    fun `a first attempt pushes the entry it built, without asking`() = runBlocking {
        val queue = queueWith(pending(pushAttempted = false))

        val result = uploader(queue).drain()

        assertEquals(1, result.uploaded)
        assertEquals(listOf("PUT /recordings/$ID/audio", "POST /recordings/$ID"), requests)
        assertEquals(CLOCK_TITLE, RecordingMeta(stored!!).title)
    }

    @Test
    fun `a retry after a push that landed keeps what the cloud has learned since`() = runBlocking {
        stored = renamedInCloud()
        val queue = queueWith(pending(pushAttempted = true))

        val result = uploader(queue).drain()

        assertEquals(1, result.uploaded)
        assertTrue("re-read first", requests.contains("GET /recordings/$ID/meta"))
        val meta = RecordingMeta(stored!!)
        assertEquals("not the clock title it was queued under", RENAMED, meta.title)
        assertTrue("the un-filing stays said", meta.raw["folderId"] is JsonNull)
        assertTrue(meta.filingSuggested)
        assertEquals("Acme renewal", meta.filingSuggestion?.title)
        assertEquals("desktop analysis", meta.raw.getValue("brief").jsonPrimitive.content)
        assertEquals(listOf(SPOKEN), meta.segments.map { it.text })
    }

    @Test
    fun `a retry finds a missing transcript and fills it in`() = runBlocking {
        stored = buildJsonObject {
            put("id", ID)
            put("title", RENAMED)
            putJsonArray("segments") {}
        }
        val queue = queueWith(pending(pushAttempted = true))

        uploader(queue).drain()

        val meta = RecordingMeta(stored!!)
        assertEquals(RENAMED, meta.title)
        assertEquals(listOf(SPOKEN), meta.segments.map { it.text })
        assertEquals("audio.ogg", meta.audio)
    }

    @Test
    fun `a retry for a recording the cloud does not have pushes it fresh`() = runBlocking {
        val queue = queueWith(pending(pushAttempted = true))

        val result = uploader(queue).drain()

        assertEquals(1, result.uploaded)
        assertEquals(CLOCK_TITLE, RecordingMeta(stored!!).title)
        assertEquals("folder-q", RecordingMeta(stored!!).folderId)
    }

    /** The share failed after the push landed; the user renamed it before the next drain. */
    @Test
    fun `the attempt is remembered across drains`() = runBlocking {
        shareFailures = 1
        val queue = PendingUploadQueue(temporary.newFolder())
        val uploader = uploader(queue, SaveDestination(orgId = "org-1"))
        uploader.enqueue(
            EnqueueRequest(
                audio = temporary.newFile().apply { writeBytes(ByteArray(256) { 1 }) },
                title = CLOCK_TITLE,
                durationMs = 60_000.0,
                id = ID,
            ),
        )

        val first = uploader.drain()
        assertEquals(0, first.uploaded)
        assertTrue("written down for the next process", queue.list().single().pushAttempted)

        stored = RecordingMeta(stored!!).withTitle(RENAMED).raw
        val second = uploader(queue, SaveDestination(orgId = "org-1")).drain()

        assertEquals(1, second.uploaded)
        assertEquals(RENAMED, RecordingMeta(stored!!).title)
        assertFalse(queue.manifestFile(ID).exists())
    }

    private companion object {
        const val ID = "rec-retry"
        const val CLOCK_TITLE = "Meeting Sep 7, 3:20 PM"
        const val RENAMED = "Acme renewal, final terms"
        const val SPOKEN = "Hello."
    }
}
