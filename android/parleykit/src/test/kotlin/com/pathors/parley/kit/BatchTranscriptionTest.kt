package com.pathors.parley.kit

import java.io.File
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * Semantics ported from `src-tauri/src/replay.rs` (`group_tokens` and
 * `parley_batch`) by way of iOS `BatchTranscriptionTests.swift`. These tests are
 * the contract: an imported file has to come back split into the same speakers
 * on Android as it does on the Mac, so if these diverge from the desktop's
 * behaviour the transcripts drift.
 *
 * Everything here runs against a fake [BatchTranscriptionService] — this module
 * stubs no URLs anywhere, and the polling loop is the interesting part
 * regardless of what carries the bytes.
 *
 * The three cases iOS keeps here about user-facing error wording live in the app
 * module instead (`cloud/BatchTranscriptionFailureTest.kt`): Android's display
 * copy is in `strings.xml`, which `:parleykit` cannot see.
 */
class BatchTranscriptionTest {

    @get:Rule
    val temporary = TemporaryFolder()

    // ── groupBatchTokens ─────────────────────────────────────────────────────

    @Test
    fun `a speaker change closes the run`() {
        val segments = groupBatchTokens(
            listOf(
                tok("Hi there.", 1, 0, 500),
                tok("Hello!", 2, 600, 900),
            ),
            source = "mix",
        )

        assertEquals(2, segments.size)
        assertEquals("mix-0", segments[0].id)
        assertEquals("mix", segments[0].source)
        assertEquals(1, segments[0].speaker)
        assertEquals("Hi there.", segments[0].text)
        assertEquals(0L, segments[0].startMs)
        assertEquals(500L, segments[0].endMs)
        assertTrue(segments[0].isFinal)
        // The trailing run is emitted too, rather than being left open.
        assertEquals("mix-1", segments[1].id)
        assertEquals(2, segments[1].speaker)
        assertEquals("Hello!", segments[1].text)
        assertEquals(600L, segments[1].startMs)
        assertEquals(900L, segments[1].endMs)
    }

    @Test
    fun `text is concatenated without a separator`() {
        // The provider's tokens carry their own spacing; inserting any would
        // double the spaces it already sent.
        val segments = groupBatchTokens(
            listOf(
                tok("Hello", 1, 0, 400),
                tok(" world", 1, 400, 800),
            ),
            source = "mix",
        )

        assertEquals(1, segments.size)
        assertEquals("Hello world", segments[0].text)
        assertEquals(800L, segments[0].endMs)
    }

    @Test
    fun `control tokens are skipped`() {
        // `<fin>` here claims speaker 2. If it were not skipped outright it
        // would close the run and invent a second speaker.
        val segments = groupBatchTokens(
            listOf(
                tok("Hello", 1, 0, 300),
                tok("<end>", null, 300, 300),
                tok("<fin>", 2, 300, 300),
                tok(" world", 1, 300, 600),
            ),
            source = "mix",
        )

        assertEquals(1, segments.size)
        assertEquals(1, segments[0].speaker)
        assertEquals("Hello world", segments[0].text)
        assertEquals(600L, segments[0].endMs)
    }

    @Test
    fun `a speakerless token stays in the current run`() {
        // Snapping a speakerless token to 0 would close speaker 1's run and
        // fragment one utterance into three segments.
        val segments = groupBatchTokens(
            listOf(
                tok("Hello", 1, 0, 400),
                tok(" ", null, 400, 410),
                tok("world", 1, 410, 800),
            ),
            source = "mix",
        )

        assertEquals(1, segments.size)
        assertEquals(1, segments[0].speaker)
        assertEquals("Hello world", segments[0].text)
    }

    @Test
    fun `a speakerless token belongs to the run it arrived in`() {
        // It joins the run that is open when it arrives, so the comma stays with
        // speaker 1 and the change to speaker 2 still splits.
        val segments = groupBatchTokens(
            listOf(
                tok("A", 1, 0, 100),
                tok(",", null, 100, 110),
                tok("B", 2, 200, 300),
            ),
            source = "mix",
        )

        assertEquals(2, segments.size)
        assertEquals("A,", segments[0].text)
        assertEquals(1, segments[0].speaker)
        assertEquals("B", segments[1].text)
        assertEquals(2, segments[1].speaker)
    }

    @Test
    fun `an entirely speakerless stream is one segment at speaker zero`() {
        // Non-diarizing output: nobody is identified, so it is all one speaker,
        // and the trailing emit clamps the -1 sentinel back to 0.
        val segments = groupBatchTokens(
            listOf(
                tok("Hello", null, 0, 300),
                tok(" there", null, 300, 700),
            ),
            source = "mix",
        )

        assertEquals(1, segments.size)
        assertEquals("mix-0", segments[0].id)
        assertEquals(0, segments[0].speaker)
        assertEquals("Hello there", segments[0].text)
        assertEquals(0L, segments[0].startMs)
        assertEquals(700L, segments[0].endMs)
    }

    @Test
    fun `a whitespace run is dropped and does not consume an index`() {
        // Speaker 2 says nothing but spaces. Dropping the run is not enough —
        // the segment index must not advance either, or the ids would gap and
        // the UI would upsert against slots that never arrive.
        val segments = groupBatchTokens(
            listOf(
                tok("Hello", 1, 0, 500),
                tok("   ", 2, 500, 600),
                tok("Hi", 3, 600, 900),
            ),
            source = "mix",
        )

        assertEquals(2, segments.size)
        assertEquals("mix-0", segments[0].id)
        assertEquals(1, segments[0].speaker)
        assertEquals("mix-1", segments[1].id)
        assertEquals(3, segments[1].speaker)
        assertEquals("Hi", segments[1].text)
    }

    @Test
    fun `a trailing whitespace-only run is not emitted`() {
        val segments = groupBatchTokens(
            listOf(
                tok("Hello", 1, 0, 500),
                tok("  ", 2, 500, 600),
            ),
            source = "mix",
        )

        assertEquals(1, segments.size)
        assertEquals("Hello", segments[0].text)
    }

    @Test
    fun `empty input produces no segments`() {
        assertTrue(groupBatchTokens(emptyList(), source = "mix").isEmpty())
    }

    @Test
    fun `ids carry the caller's source`() {
        val segments = groupBatchTokens(listOf(tok("x", 0, 0, 10)), source = "them")
        assertEquals("them-0", segments[0].id)
        assertEquals("them", segments[0].source)
    }

    // ── decoding ─────────────────────────────────────────────────────────────

    @Test
    fun `a token accepts a speaker as a number, a string, or absent`() {
        // The vendor sends all three shapes; a strict decoder would decode none.
        val decoded = json.decodeFromString(
            BatchTranscriptResponse.serializer(),
            """
            {"tokens":[
              {"text":"a","startMs":0,"endMs":100,"speaker":2},
              {"text":"b","startMs":100,"endMs":200,"speaker":"3"},
              {"text":"c","startMs":200,"endMs":300}
            ]}
            """.trimIndent(),
        )

        assertEquals(3, decoded.tokens.size)
        assertEquals(listOf(2, 3, null), decoded.tokens.map { it.speaker })
        assertEquals("b", decoded.tokens[1].text)
        assertEquals(300L, decoded.tokens[2].endMs)
    }

    @Test
    fun `a transcript without tokens decodes empty`() {
        val decoded = json.decodeFromString(BatchTranscriptResponse.serializer(), "{}")
        assertTrue(decoded.tokens.isEmpty())
    }

    @Test
    fun `a job status decodes without the optional halves`() {
        val job = json.decodeFromString(BatchJobStatus.serializer(), """{"status":"queued"}""")
        assertEquals("queued", job.status)
        assertNull(job.errorMessage)
        assertNull(job.durationMs)
    }

    // ── BatchTranscriber ─────────────────────────────────────────────────────

    @Test
    fun `polls through queued and processing to completed`() = runBlocking {
        val fake = FakeBatchService(
            statuses = listOf(
                BatchJobStatus(status = "queued"),
                BatchJobStatus(status = "processing"),
                BatchJobStatus(status = "completed", durationMs = 4_000.0),
            ),
            transcript = BatchTranscriptResponse(listOf(tok("Hello", 1, 0, 900))),
        )
        val transcriber = BatchTranscriber(fake, pollIntervalMs = 1, maxPolls = 10)

        val result = transcriber.transcribe(audio(2))

        assertEquals(3, fake.pollCount)
        assertEquals(1, result.segments.size)
        assertEquals("Hello", result.segments[0].text)
        assertEquals("the phone records one mixed stream", "mix-0", result.segments[0].id)
        assertEquals(4_000L, result.durationMs)
    }

    @Test
    fun `an unknown status keeps polling`() = runBlocking {
        // The cloud may grow a state we have never heard of; that has to read as
        // "still working", not as a failure.
        val fake = FakeBatchService(
            statuses = listOf(
                BatchJobStatus(status = "some_future_state"),
                BatchJobStatus(status = "completed", durationMs = 1_000.0),
            ),
        )
        val transcriber = BatchTranscriber(fake, pollIntervalMs = 1, maxPolls = 10)

        val result = transcriber.transcribe(audio(0))

        assertEquals(2, fake.pollCount)
        assertEquals(1_000L, result.durationMs)
    }

    @Test
    fun `the upload carries diarization and language hints`() = runBlocking {
        val fake = FakeBatchService(listOf(BatchJobStatus("completed", durationMs = 0.0)))
        val transcriber = BatchTranscriber(fake, pollIntervalMs = 1, maxPolls = 4)

        transcriber.transcribe(
            audio(7),
            diarization = false,
            languageHints = listOf("zh", "en"),
        )

        assertEquals(1, fake.starts.size)
        assertEquals(7L, fake.starts[0].byteCount)
        assertEquals(false, fake.starts[0].diarization)
        assertEquals(listOf("zh", "en"), fake.starts[0].languageHints)
    }

    @Test
    fun `a job error throws the server's message`() = runBlocking {
        val fake = FakeBatchService(
            listOf(BatchJobStatus("error", errorMessage = "audio too short")),
        )
        val transcriber = BatchTranscriber(fake, pollIntervalMs = 1, maxPolls = 10)

        val thrown = runCatching { transcriber.transcribe(audio(0)) }.exceptionOrNull()

        assertTrue("$thrown", thrown is BatchTranscriptionException.JobFailed)
        assertEquals("audio too short", (thrown as BatchTranscriptionException.JobFailed).reason)
        assertEquals("a failed job has no transcript to fetch", 0, fake.transcriptFetches)
    }

    @Test
    fun `a job error without a message still throws`() = runBlocking {
        val fake = FakeBatchService(listOf(BatchJobStatus("error")))
        val transcriber = BatchTranscriber(fake, pollIntervalMs = 1, maxPolls = 10)

        val thrown = runCatching { transcriber.transcribe(audio(0)) }.exceptionOrNull()

        assertTrue("$thrown", thrown is BatchTranscriptionException.JobFailed)
        assertEquals(
            BatchTranscriptionException.UNKNOWN_REASON,
            (thrown as BatchTranscriptionException.JobFailed).reason,
        )
    }

    @Test
    fun `an unsettled job times out rather than hanging`() = runBlocking {
        val fake = FakeBatchService(listOf(BatchJobStatus("processing")))
        val transcriber = BatchTranscriber(fake, pollIntervalMs = 1, maxPolls = 4)

        val thrown = runCatching { transcriber.transcribe(audio(0)) }.exceptionOrNull()

        assertTrue("$thrown", thrown is BatchTranscriptionException.TimedOut)
        assertEquals("the cap is a count of polls, not of anything else", 4, fake.pollCount)
    }

    @Test
    fun `success deletes the job`() = runBlocking {
        val fake = FakeBatchService(
            statuses = listOf(BatchJobStatus("completed", durationMs = 500.0)),
            transcript = BatchTranscriptResponse(listOf(tok("ok", 0, 0, 400))),
        )
        val transcriber = BatchTranscriber(fake, pollIntervalMs = 1, maxPolls = 4)

        transcriber.transcribe(audio(0))

        assertEquals(
            "the cloud must not be left holding the audio",
            listOf("job-1"),
            fake.deletedIds,
        )
    }

    @Test
    fun `a cleanup that does nothing does not fail the transcription`() = runBlocking {
        // `deleteBatchJob` swallows its own failures, so from here a cleanup
        // that silently did nothing is indistinguishable from one that threw —
        // and either way the transcript we already hold has to come back.
        val fake = FakeBatchService(
            statuses = listOf(BatchJobStatus("completed", durationMs = 500.0)),
            transcript = BatchTranscriptResponse(listOf(tok("ok", 0, 0, 400))),
            deletesSucceed = false,
        )
        val transcriber = BatchTranscriber(fake, pollIntervalMs = 1, maxPolls = 4)

        val result = transcriber.transcribe(audio(0))

        assertEquals(1, result.segments.size)
        assertEquals("ok", result.segments[0].text)
        assertTrue(fake.deletedIds.isEmpty())
    }

    @Test
    fun `the duration prefers the transcript when it runs longer`() = runBlocking {
        val fake = FakeBatchService(
            statuses = listOf(BatchJobStatus("completed", durationMs = 2_000.0)),
            transcript = BatchTranscriptResponse(
                listOf(tok("a", 1, 0, 1_000), tok("b", 1, 1_000, 9_000)),
            ),
        )
        val transcriber = BatchTranscriber(fake, pollIntervalMs = 1, maxPolls = 4)

        assertEquals(9_000L, transcriber.transcribe(audio(0)).durationMs)
    }

    @Test
    fun `the duration prefers the job when it runs longer`() = runBlocking {
        // Trailing silence: the file is longer than the last word in it.
        val fake = FakeBatchService(
            statuses = listOf(BatchJobStatus("completed", durationMs = 12_000.0)),
            transcript = BatchTranscriptResponse(listOf(tok("a", 1, 0, 3_000))),
        )
        val transcriber = BatchTranscriber(fake, pollIntervalMs = 1, maxPolls = 4)

        assertEquals(12_000L, transcriber.transcribe(audio(0)).durationMs)
    }

    @Test
    fun `the duration falls back to the transcript when the job reports none`() = runBlocking {
        val fake = FakeBatchService(
            statuses = listOf(BatchJobStatus("completed")),
            transcript = BatchTranscriptResponse(listOf(tok("a", 1, 0, 5_000))),
        )
        val transcriber = BatchTranscriber(fake, pollIntervalMs = 1, maxPolls = 4)

        assertEquals(5_000L, transcriber.transcribe(audio(0)).durationMs)
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private val json = Json { ignoreUnknownKeys = true }

    private fun audio(bytes: Int): File =
        temporary.newFile("audio-${counter++}.ogg").apply { writeBytes(ByteArray(bytes)) }

    private var counter = 0
}

private fun tok(text: String, speaker: Int?, startMs: Long = 0, endMs: Long = 0): BatchToken =
    BatchToken(text = text, startMs = startMs, endMs = endMs, speaker = speaker)

/**
 * Stands in for `CloudClient`. [statuses] is walked one entry per poll and the
 * last entry repeats forever, so a single `processing` is a job that never
 * settles — which is what the timeout test needs.
 */
private class FakeBatchService(
    private val statuses: List<BatchJobStatus>,
    private val transcript: BatchTranscriptResponse = BatchTranscriptResponse(),
    private val jobId: String = "job-1",
    private val deletesSucceed: Boolean = true,
) : BatchTranscriptionService {

    data class StartRecord(
        val byteCount: Long,
        val diarization: Boolean,
        val languageHints: List<String>,
    )

    val starts = mutableListOf<StartRecord>()
    var pollCount = 0
        private set
    var transcriptFetches = 0
        private set
    val deletedIds = mutableListOf<String>()

    private var cursor = 0

    init {
        require(statuses.isNotEmpty()) { "the fake needs at least one status to report" }
    }

    override suspend fun startBatchJob(
        audio: File,
        diarization: Boolean,
        languageHints: List<String>,
    ): String {
        starts += StartRecord(audio.length(), diarization, languageHints)
        return jobId
    }

    override suspend fun batchJobStatus(id: String): BatchJobStatus {
        pollCount++
        val status = statuses[minOf(cursor, statuses.size - 1)]
        cursor++
        return status
    }

    override suspend fun batchTranscript(id: String): BatchTranscriptResponse {
        transcriptFetches++
        return transcript
    }

    override suspend fun deleteBatchJob(id: String) {
        // A cleanup that quietly does nothing — the caller cannot tell it apart
        // from one that failed, and must not care either way.
        if (!deletesSucceed) return
        deletedIds += id
    }
}
