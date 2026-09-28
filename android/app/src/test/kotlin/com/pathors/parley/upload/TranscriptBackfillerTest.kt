package com.pathors.parley.upload

import com.pathors.parley.cloud.CloudClient
import com.pathors.parley.cloud.CloudException
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
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
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

    /**
     * What the cloud holds for each recording right now — what the automatic
     * path re-reads before it pushes. A recording with no entry here is served
     * as the upload that queued the run would have left it.
     */
    private val cloudMeta = mutableMapOf<String, JsonObject>()

    /** Recordings whose re-read fails, as it would on a flat network or a 5xx. */
    private val unreadable = mutableSetOf<String>()

    @Before
    fun serveCloud() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val parts = request.path.orEmpty().trim('/').split('/')
                val id = parts.getOrNull(1).orEmpty()
                return when {
                    request.method == "GET" && id in unreadable -> MockResponse().setResponseCode(503)
                    request.method == "GET" && parts.lastOrNull() == "meta" -> MockResponse()
                        .setResponseCode(200)
                        .setBody(cloudMeta.getOrPut(id) { MeetingUploader.buildMeta(pending(id)).raw }.toString())
                    request.method == "POST" -> MockResponse().setResponseCode(200).setBody("""{"updatedAt":2}""")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
    }

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
            BatchToken(FIRST_LINE, 0, 1_400_000, 1),
            BatchToken(SECOND_LINE, 1_400_000, 2_953_000, 2),
        )
    )

    /** The `{ summary, meta }` body of the push the run made, past any re-read before it. */
    private fun pushedBody(): JsonObject {
        var request = server.takeRequest()
        while (request.method != "POST") request = server.takeRequest()
        return CloudJson.parseToJsonElement(request.body.readUtf8()) as JsonObject
    }

    // ── the automatic path ───────────────────────────────────────────────────

    @Test
    fun `an automatic run puts the new transcript into the entry`() = runBlocking {
        val queue = queue("auto")
        val ledger = ledger("auto-ledger")
        queue.enqueueMoving(BackfillRequest(pending = pending("rec-1")), audio("a.ogg"))

        val result = backfiller(queue, ledger, FakeBatch(fullTranscript())).drain()

        assertEquals(1, result.repaired)
        assertNull(result.failure)
        assertEquals("the queue entry is spent", 0, queue.count())

        val body = pushedBody()
        val meta = RecordingMeta(body["meta"] as JsonObject)
        assertEquals(listOf(FIRST_LINE, SECOND_LINE), meta.segments.map { it.text })
        assertEquals(2_953_000.0, meta.durationMs, 0.0)
        assertEquals("Renewal terms", meta.title)
    }

    /**
     * The run happens minutes or a launch after the upload queued it, and in
     * between the recording may have been renamed from the filing card, moved,
     * and marked as filed. Rebuilding the entry from the queued request put the
     * clock name back over the one the user typed.
     */
    @Test
    fun `an automatic run keeps a rename, a move and the filing flag made since it was queued`() =
        runBlocking {
            val queue = queue("renamed")
            queue.enqueueMoving(BackfillRequest(pending = pending(RECORDING)), audio("a.ogg"))
            cloudMeta[RECORDING] = MeetingUploader.buildMeta(pending(RECORDING))
                .withTitle(RENAMED)
                .withFolderId(MOVED_TO)
                .withFilingSuggested()
                .raw

            val result = backfiller(queue, ledger("renamed-l"), FakeBatch(fullTranscript())).drain()

            assertEquals(1, result.repaired)
            val body = pushedBody()
            val meta = RecordingMeta(body["meta"] as JsonObject)
            val summary = CloudJson.decodeFromJsonElement(RecordingSummary.serializer(), body["summary"]!!)
            assertEquals(listOf(FIRST_LINE, SECOND_LINE), meta.segments.map { it.text })
            assertEquals(RENAMED, meta.title)
            assertEquals(MOVED_TO, meta.folderId)
            assertTrue(meta.filingSuggested)
            assertEquals("the library row says the same", RENAMED, summary.title)
            assertEquals(MOVED_TO, summary.folderId)
            assertEquals(2, summary.speakerCount)
            assertTrue(summary.hasAudio)
        }

    /**
     * What an open recording screen watches to re-read a transcript that
     * landed while it was up (iOS `backfillRevision`).
     */
    @Test
    fun `a landed run is announced, and a failed one is not`() = runBlocking {
        val queue = queue("landed")
        queue.enqueueMoving(BackfillRequest(pending = pending("rec-1")), audio("a.ogg"))
        val backfiller = backfiller(queue, ledger("landed-l"), FakeBatch(fullTranscript()))
        assertEquals(0, backfiller.landed.value)

        backfiller.drain()
        assertEquals(1, backfiller.landed.value)

        val stuck = queue("landed-stuck")
        stuck.enqueueMoving(BackfillRequest(pending = pending(RECORDING)), audio("b.ogg"))
        unreadable += RECORDING
        val failing = backfiller(stuck, ledger("landed-stuck-l"), FakeBatch(fullTranscript()))
        failing.drain()
        assertEquals(0, failing.landed.value)
    }

    /** Pushing the stale copy is the thing the re-read exists to stop. */
    @Test
    fun `an automatic run that cannot re-read the recording stays queued and pushes nothing`() =
        runBlocking {
            val queue = queue("unread")
            queue.enqueueMoving(BackfillRequest(pending = pending(RECORDING)), audio("a.ogg"))
            unreadable += RECORDING

            val result = backfiller(queue, ledger("unread-l"), FakeBatch(fullTranscript())).drain()

            assertEquals(0, result.repaired)
            assertTrue("${result.failure}", result.failure is CloudException)
            assertEquals(1, queue.count())
            assertEquals("the re-read, and no push", 1, server.requestCount)
        }

    @Test
    fun `a finished run retires the audio on the same terms as an upload`() = runBlocking {
        val queue = queue("retire")
        val store = LocalAudioStore(temporary.newFolder("Audio-retire"))
        queue.enqueueMoving(BackfillRequest(pending = pending("rec-1")), audio("a.ogg"))

        backfiller(queue, ledger("retire-l"), FakeBatch(fullTranscript()), store, keep = true)
            .drain()

        assertTrue("the phone keeps its audio, so this is now playable", store.has("rec-1"))
        assertFalse(queue.audioFile("rec-1").exists())
    }

    @Test
    fun `a phone that does not keep audio deletes it once the run is over`() = runBlocking {
        val queue = queue("drop")
        queue.enqueueMoving(BackfillRequest(pending = pending("rec-1")), audio("a.ogg"))

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

        backfiller(queue, ledger, FakeBatch(fullTranscript())).drain()

        val body = pushedBody()
        val meta = RecordingMeta(body["meta"] as JsonObject)
        val pushedSummary = CloudJson.decodeFromJsonElement(
            RecordingSummary.serializer(),
            body["summary"]!!,
        )

        assertEquals(listOf(FIRST_LINE, SECOND_LINE), meta.segments.map { it.text })
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

    // ── what a screen is told (iOS 1.14) ───────────────────────────────────────

    @Test
    fun `a queued request that never ran is waiting with no attempt`() = runBlocking {
        val queue = queue("status-fresh")
        val backfiller = backfiller(queue, ledger("status-fresh-l"), FakeBatch(fullTranscript()))
        assertEquals(BackfillStatus.None, backfiller.status(RECORDING))

        queue.enqueueMoving(BackfillRequest(pending = pending(RECORDING)), audio("a.ogg"))

        assertEquals(BackfillStatus.Queued(lastAttemptAtMs = null), backfiller.status(RECORDING))
    }

    /**
     * A run the system killed looks exactly like this from the next launch: a
     * manifest, nothing running it. What it leaves behind is when it started.
     */
    @Test
    fun `a run that did not land leaves its start time and is waiting, not running`() = runBlocking {
        val queue = queue("status-stuck")
        queue.enqueueMoving(BackfillRequest(pending = pending(RECORDING)), audio("a.ogg"))
        val backfiller = TranscriptBackfiller(
            cloud = cloud(),
            queue = queue,
            ledger = ledger("status-stuck-l"),
            transcriber = BatchTranscriber(FakeBatch(fullTranscript(), failStart = true), pollIntervalMs = 1),
            now = { ATTEMPT_AT },
        )

        backfiller.drain()

        assertEquals(BackfillStatus.Queued(lastAttemptAtMs = ATTEMPT_AT), backfiller.status(RECORDING))
        assertEquals(1, queue.request(RECORDING)?.attemptCount)
        assertTrue("nothing is running it any more", backfiller.running.value.isEmpty())
    }

    @Test
    fun `a run is reported as running exactly while it is alive`() = runBlocking {
        val queue = queue("status-running")
        queue.enqueueMoving(BackfillRequest(pending = pending(RECORDING)), audio("a.ogg"))
        val probe = RunningProbe()
        val backfiller = TranscriptBackfiller(
            cloud = cloud(),
            queue = queue,
            ledger = ledger("status-running-l"),
            transcriber = BatchTranscriber(probe, pollIntervalMs = 1),
        )
        probe.backfiller = backfiller

        backfiller.drain()

        assertEquals(BackfillStatus.Running, probe.seen)
        assertTrue(backfiller.running.value.isEmpty())
    }

    private companion object {
        const val ATTEMPT_AT = 1_700_000_123_000L
        const val RECORDING = "rec-renamed"
        const val RENAMED = "Acme renewal terms"
        const val MOVED_TO = "folder-3"

        /** The two runs the batch job comes back with. */
        const val FIRST_LINE = "Every word of it."
        const val SECOND_LINE = "All of it."
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

/** Records what the backfiller says about the recording while its run is under way. */
private class RunningProbe : BatchTranscriptionService {
    lateinit var backfiller: TranscriptBackfiller
    var seen: BackfillStatus? = null

    override suspend fun startBatchJob(
        audio: File,
        diarization: Boolean,
        languageHints: List<String>,
    ): String {
        seen = backfiller.status("rec-renamed")
        throw IOException("stop here")
    }

    override suspend fun batchJobStatus(id: String): BatchJobStatus =
        BatchJobStatus(status = "completed", durationMs = 0.0)

    override suspend fun batchTranscript(id: String): BatchTranscriptResponse = BatchTranscriptResponse(emptyList())

    override suspend fun deleteBatchJob(id: String) = Unit
}
