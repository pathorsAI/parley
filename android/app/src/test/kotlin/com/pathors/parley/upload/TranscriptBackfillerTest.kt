package com.pathors.parley.upload

import com.pathors.parley.cloud.CloudClient
import com.pathors.parley.cloud.CloudJson
import com.pathors.parley.cloud.RecordingMeta
import com.pathors.parley.cloud.RecordingSummary
import com.pathors.parley.cloud.TranscriptSegmentDto
import com.pathors.parley.kit.BatchJobStatus
import com.pathors.parley.kit.BatchToken
import com.pathors.parley.kit.BatchTranscriber
import com.pathors.parley.kit.BatchTranscriptResponse
import com.pathors.parley.kit.BatchTranscriptionService
import com.pathors.parley.playback.LocalAudioStore
import java.io.File
import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * A backfill run end to end: transcribe the whole file, push the metadata, and
 * decide what the audio and the retry ledger owe afterwards.
 *
 * The rule that costs real money if it breaks is the accounting one — a
 * hand-triggered run is charged only when a transcription actually completed. A
 * run that dies on a flat network has cost nobody anything and must stay queued
 * for free.
 */
class TranscriptBackfillerTest {

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

    private fun backfiller(
        queue: PendingBackfillQueue,
        ledger: ManualRetryLedger,
        service: BatchTranscriptionService,
        store: LocalAudioStore? = null,
        keep: Boolean = false,
    ) = TranscriptBackfiller(
        cloud = cloud(),
        queue = queue,
        ledger = ledger,
        transcriber = BatchTranscriber(service, pollIntervalMs = 1, maxPolls = 5),
        localAudio = store,
        keepsAudioOnPhone = { keep },
    )

    private fun queue(name: String) = PendingBackfillQueue(temporary.newFolder(name))

    private fun ledger(name: String) = ManualRetryLedger(File(temporary.newFolder(name), "m.json"))

    private fun audio(name: String) =
        temporary.newFile(name).apply { writeBytes(ByteArray(512) { it.toByte() }) }

    private fun pending(id: String) = PendingUpload(
        id = id,
        title = "Renewal terms",
        startedAtMs = 1_700_000_000_000,
        durationMs = 2_953_000.0,
        segments = listOf(
            TranscriptSegmentDto(id = "mix-0", text = "thin", startMs = 0, endMs = 60_000),
        ),
    )

    /** The full transcript the job comes back with. */
    private fun fullTranscript() = BatchTranscriptResponse(
        listOf(
            BatchToken("Every word of it.", 0, 1_400_000, 1),
            BatchToken("All of it.", 1_400_000, 2_953_000, 2),
        )
    )

    private fun pushAccepted() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"updatedAt":2}"""))
    }

    /** The `{ summary, meta }` body of the push the run made. */
    private fun pushedBody(): JsonObject =
        CloudJson.parseToJsonElement(server.takeRequest().body.readUtf8()) as JsonObject

    // ── the automatic path ───────────────────────────────────────────────────

    @Test
    fun `an automatic run rebuilds the entry from the new transcript`() = runBlocking {
        // Nothing to preserve: the recording was created seconds ago by the
        // upload that queued this.
        val queue = queue("auto")
        val ledger = ledger("auto-ledger")
        queue.enqueueMoving(BackfillRequest(pending = pending("rec-1")), audio("a.ogg"))
        pushAccepted()

        val result = backfiller(queue, ledger, FakeBatch(fullTranscript())).drain()

        assertEquals(1, result.repaired)
        assertNull(result.failure)
        assertEquals("the queue entry is spent", 0, queue.count())

        val body = pushedBody()
        val meta = RecordingMeta(body["meta"] as JsonObject)
        assertEquals(listOf("Every word of it.", "All of it."), meta.segments.map { it.text })
        assertEquals(2_953_000.0, meta.durationMs, 0.0)
        assertEquals("Renewal terms", meta.title)
    }

    @Test
    fun `a finished run retires the audio on the same terms as an upload`() = runBlocking {
        val queue = queue("retire")
        val store = LocalAudioStore(temporary.newFolder("Audio-retire"))
        queue.enqueueMoving(BackfillRequest(pending = pending("rec-1")), audio("a.ogg"))
        pushAccepted()

        backfiller(queue, ledger("retire-l"), FakeBatch(fullTranscript()), store, keep = true)
            .drain()

        assertTrue("the phone keeps its audio, so this is now playable", store.has("rec-1"))
        assertFalse(queue.audioFile("rec-1").exists())
    }

    @Test
    fun `a phone that does not keep audio deletes it once the run is over`() = runBlocking {
        val queue = queue("drop")
        queue.enqueueMoving(BackfillRequest(pending = pending("rec-1")), audio("a.ogg"))
        pushAccepted()

        backfiller(queue, ledger("drop-l"), FakeBatch(fullTranscript())).drain()

        assertEquals(0L, queue.bytesOnDisk())
    }

    @Test
    fun `a job that came back empty keeps the thin transcript rather than blanking it`() =
        runBlocking {
            // An empty result is not an improvement, and the audio has now been
            // paid for — so the entry leaves the queue without a push.
            val queue = queue("empty")
            queue.enqueueMoving(BackfillRequest(pending = pending("rec-1")), audio("a.ogg"))

            val result = backfiller(queue, ledger("empty-l"), FakeBatch(BatchTranscriptResponse()))
                .drain()

            assertEquals(1, result.repaired)
            assertEquals(0, queue.count())
            assertEquals("nothing was pushed over the transcript", 0, server.requestCount)
        }

    // ── a recording that has a life of its own ───────────────────────────────

    @Test
    fun `a manual run edits the transcript inside what is already there`() = runBlocking {
        // Speaker names somebody typed, a desktop analysis, a field the phone
        // has never heard of. Rebuilding the entry would be right about the
        // words and would silently throw all of that away.
        val queue = queue("loved")
        val ledger = ledger("loved-l")
        val existing = buildJsonObject {
            put("id", "rec-1")
            put("title", "Pricing call")
            put("source", "live")
            put("createdAt", 1_700_000_000_000)
            put("durationMs", 2_953_000)
            put("folderId", "folder-9")
            put("analyzed", true)
            putJsonObject("speakerNames") { put("mix-0", "Jack") }
            putJsonArray("findings") { addJsonObject { put("id", "f1") } }
            put("brief", "only the desktop writes this")
        }
        val summary = RecordingSummary(
            id = "rec-1",
            title = "Pricing call",
            source = "live",
            createdAt = 1_700_000_000_000.0,
            durationMs = 2_953_000.0,
            findingsCount = 4,
            actionItemsCount = 2,
            hasAudio = true,
            folderId = "folder-9",
        )
        queue.enqueueCopying(
            BackfillRequest(
                pending = pending("rec-1"),
                folderId = "folder-9",
                manualRetries = 1,
                existingMeta = existing,
                existingSummary = summary,
            ),
            audio("a.ogg"),
        )
        pushAccepted()

        backfiller(queue, ledger, FakeBatch(fullTranscript())).drain()

        val body = pushedBody()
        val meta = RecordingMeta(body["meta"] as JsonObject)
        val pushedSummary = CloudJson.decodeFromJsonElement(
            RecordingSummary.serializer(),
            body["summary"]!!,
        )

        assertEquals(listOf("Every word of it.", "All of it."), meta.segments.map { it.text })
        assertEquals(mapOf("mix-0" to "Jack"), meta.speakerNames)
        assertEquals(1, meta.findingsCount)
        assertTrue(meta.analyzed)
        assertEquals("only the desktop writes this", meta.raw["brief"]?.toString()?.trim('"'))
        assertEquals("folder-9", meta.folderId)
        // The analysis counts belong to the recording, not to the transcript.
        assertEquals(4, pushedSummary.findingsCount)
        assertEquals(2, pushedSummary.actionItemsCount)
        assertEquals(2, pushedSummary.speakerCount)
    }

    // ── the ledger ───────────────────────────────────────────────────────────

    @Test
    fun `a completed manual run is charged, and only then`() = runBlocking {
        val queue = queue("charge")
        val ledger = ledger("charge-l")
        queue.enqueueCopying(
            BackfillRequest(pending = pending("rec-1"), manualRetries = 1),
            audio("a.ogg"),
        )
        pushAccepted()

        backfiller(queue, ledger, FakeBatch(fullTranscript())).drain()

        assertEquals(1, ledger.read().spentCount("rec-1"))
        assertEquals(2, ledger.read().remaining("rec-1"))
    }

    @Test
    fun `a run that died on a flat network costs nothing and stays queued`() = runBlocking {
        // The cap exists to bound cost and to stop somebody re-rolling the same
        // audio hoping for a different answer — not to punish bad reception.
        val queue = queue("flat")
        val ledger = ledger("flat-l")
        queue.enqueueCopying(
            BackfillRequest(pending = pending("rec-1"), manualRetries = 1),
            audio("a.ogg"),
        )

        val result = backfiller(queue, ledger, FakeBatch(fullTranscript(), failStart = true))
            .drain()

        assertEquals(0, result.repaired)
        assertTrue("${result.failure}", result.failure is IOException)
        assertEquals("nothing spent", 0, ledger.read().spentCount("rec-1"))
        assertEquals("and still queued, with its audio", 1, queue.count())
        assertTrue(queue.audioFile("rec-1").isFile)
    }

    @Test
    fun `an automatic run is never charged to anybody`() = runBlocking {
        val queue = queue("free")
        val ledger = ledger("free-l")
        queue.enqueueMoving(BackfillRequest(pending = pending("rec-1")), audio("a.ogg"))
        pushAccepted()

        backfiller(queue, ledger, FakeBatch(fullTranscript())).drain()

        assertEquals(0, ledger.read().spentCount("rec-1"))
    }

    @Test
    fun `a job that came back empty is still charged, because it was paid for`() = runBlocking {
        val queue = queue("empty-charge")
        val ledger = ledger("empty-charge-l")
        queue.enqueueCopying(
            BackfillRequest(pending = pending("rec-1"), manualRetries = 1),
            audio("a.ogg"),
        )

        backfiller(queue, ledger, FakeBatch(BatchTranscriptResponse())).drain()

        assertEquals(1, ledger.read().spentCount("rec-1"))
    }

    // ── asking for one ───────────────────────────────────────────────────────

    @Test
    fun `a re-transcription copies the audio the player is reading`() = runBlocking {
        val queue = queue("ask")
        val ledger = ledger("ask-l")
        val stored = audio("in-the-store.ogg")
        val meta = RecordingMeta(
            buildJsonObject {
                put("id", "rec-1")
                put("title", "Pricing call")
                put("durationMs", 600_000)
                put("audio", "audio.ogg")
                put("folderId", "folder-9")
            }
        )

        backfiller(queue, ledger, FakeBatch(fullTranscript()))
            .requestRetranscription(meta, stored)

        assertTrue("moving it would stop playback mid-sentence", stored.isFile)
        val request = queue.request("rec-1")!!
        assertEquals(1, request.manualRetries)
        assertEquals("folder-9", request.folderId)
        assertEquals("rec-1", request.existingRecordingMeta()?.id)
        assertEquals("Pricing call", request.existingSummary?.title)
    }

    @Test
    fun `a spent budget is refused rather than quietly queued`() = runBlocking {
        val queue = queue("spent")
        val ledger = ledger("spent-l")
        repeat(3) { ledger.spend("rec-1") }
        val meta = RecordingMeta(buildJsonObject { put("id", "rec-1"); put("durationMs", 600_000) })

        val thrown = runCatching {
            backfiller(queue, ledger, FakeBatch(fullTranscript()))
                .requestRetranscription(meta, audio("a.ogg"))
        }.exceptionOrNull()

        assertTrue("$thrown", thrown is ManualRetryBudgetSpentException)
        assertEquals(0, queue.count())
    }

    @Test
    fun `asking again while one is queued raises the attempt instead of racing it`() =
        runBlocking {
            val queue = queue("again")
            val ledger = ledger("again-l")
            val meta = RecordingMeta(
                buildJsonObject { put("id", "rec-1"); put("durationMs", 600_000) }
            )
            val runner = backfiller(queue, ledger, FakeBatch(fullTranscript()))

            runner.requestRetranscription(meta, audio("a.ogg"))
            runner.requestRetranscription(meta, audio("b.ogg"))

            assertEquals(1, queue.count())
            assertEquals(2, queue.request("rec-1")?.manualRetries)
        }

    @Test
    fun `what a screen asks before offering the entry point`() = runBlocking {
        val queue = queue("screen")
        val ledger = ledger("screen-l")
        val runner = backfiller(queue, ledger, FakeBatch(fullTranscript()))

        assertEquals(3, runner.retriesRemaining("rec-1"))
        assertFalse(runner.isQueued("rec-1"))

        val meta = RecordingMeta(buildJsonObject { put("id", "rec-1"); put("durationMs", 1_000) })
        runner.requestRetranscription(meta, audio("a.ogg"))

        assertTrue(runner.isQueued("rec-1"))
        assertEquals(1, runner.pendingCount())
    }

    @Test
    fun `forgetting a recording takes its queue entry and its budget with it`() = runBlocking {
        // A deleted recording must not leave a row in a ledger it can never
        // spend, nor an Ogg in a queue that can never push it anywhere.
        val queue = queue("forget")
        val ledger = ledger("forget-l")
        ledger.spend("rec-1")
        queue.enqueueMoving(BackfillRequest(pending = pending("rec-1")), audio("a.ogg"))

        backfiller(queue, ledger, FakeBatch(fullTranscript())).forget("rec-1")

        assertEquals(0, queue.count())
        assertEquals(0L, queue.bytesOnDisk())
        assertEquals(3, ledger.read().remaining("rec-1"))
    }

    // ── the queue's own protections ──────────────────────────────────────────

    @Test
    fun `a manifest whose blob is gone is discarded instead of wedging the queue`() = runBlocking {
        val queue = queue("orphan")
        queue.enqueueMoving(BackfillRequest(pending = pending("rec-gone")), audio("a.ogg"))
        queue.audioFile("rec-gone").delete()
        queue.enqueueMoving(BackfillRequest(pending = pending("rec-ok")), audio("b.ogg"))
        pushAccepted()

        val result = backfiller(queue, ledger("orphan-l"), FakeBatch(fullTranscript())).drain()

        assertEquals("the good one still ran", 1, result.repaired)
        assertEquals(1, result.discarded)
        assertEquals(0, result.remaining)
    }

    @Test
    fun `one failure stops the pass, because the next would fail the same way`() = runBlocking {
        val queue = queue("stop")
        queue.enqueueMoving(BackfillRequest(pending = pending("rec-1")), audio("a.ogg"))
        queue.enqueueMoving(BackfillRequest(pending = pending("rec-2")), audio("b.ogg"))

        val result = backfiller(
            queue,
            ledger("stop-l"),
            FakeBatch(fullTranscript(), failStart = true),
        ).drain()

        assertEquals(0, result.repaired)
        assertEquals(2, result.remaining)
        assertTrue(result.failure is IOException)
    }

    // ── coverage, the thing that queues these in the first place ─────────────

    @Test
    fun `coverage reads a pending upload without needing anything else`() {
        val thin = pending("rec-1")
        val whole = thin.copy(
            segments = listOf(
                TranscriptSegmentDto(id = "mix-0", text = "x", startMs = 0, endMs = 2_953_000),
            )
        )

        assertTrue(TranscriptBackfiller.coverage(thin).needsBackfill())
        assertFalse(TranscriptBackfiller.coverage(whole).needsBackfill())
    }

    @Test
    fun `the tentative tail does not vouch for audio nobody transcribed`() {
        // It is filtered out of the upload for the same reason; a coverage check
        // that counted it would let one unfinished utterance cover an hour.
        val tailed = pending("rec-1").copy(
            segments = listOf(
                TranscriptSegmentDto(id = "mix-tail", text = "guess", startMs = 0, endMs = 2_953_000),
            )
        )

        assertTrue(TranscriptBackfiller.coverage(tailed).needsBackfill())
    }
}

/**
 * Stands in for the cloud's batch endpoints. The job settles on the first poll;
 * what varies is what comes back and whether the upload gets there at all.
 */
private class FakeBatch(
    private val transcript: BatchTranscriptResponse,
    private val failStart: Boolean = false,
) : BatchTranscriptionService {

    override suspend fun startBatchJob(
        audio: File,
        diarization: Boolean,
        languageHints: List<String>,
    ): String {
        if (failStart) throw IOException("no route to host")
        return "job-1"
    }

    override suspend fun batchJobStatus(id: String): BatchJobStatus =
        BatchJobStatus(status = "completed", durationMs = 2_953_000.0)

    override suspend fun batchTranscript(id: String): BatchTranscriptResponse = transcript

    override suspend fun deleteBatchJob(id: String) = Unit
}
