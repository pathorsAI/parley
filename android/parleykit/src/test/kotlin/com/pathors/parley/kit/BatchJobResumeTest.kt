package com.pathors.parley.kit

import java.io.File
import java.io.IOException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * [BatchTranscriber] resuming a job it already uploaded instead of uploading the
 * same audio again — the fix for jobs abandoned when a run was cut short and
 * re-uploaded as brand-new ones on the next attempt.
 */
class BatchJobResumeTest {

    @get:Rule
    val temporary = TemporaryFolder()

    private val store = MemoryJobStore()
    private var clock = 1_000_000L

    private fun transcriber(service: BatchTranscriptionService, maxPolls: Int = 5) =
        BatchTranscriber(service, pollIntervalMs = 1, maxPolls = maxPolls, jobs = store, now = { clock })

    private fun audio(bytes: Int = 4): File =
        temporary.newFile().apply { writeBytes(ByteArray(bytes)) }

    @Test
    fun `the job id is remembered as soon as the upload succeeds`() = runBlocking {
        val service = ScriptedService(statusFor = { BatchJobStatus("processing") }, fail = { IOException("offline") })
        val file = audio()

        val thrown = runCatching { transcriber(service).transcribe(file, resumeKey = "rec-1") }.exceptionOrNull()

        assertTrue(thrown is BatchTranscriptionException.TimedOut)
        assertEquals(PersistedBatchJob("job-1", 4, clock), store.read("rec-1"))
    }

    @Test
    fun `a remembered job is polled instead of uploading again`() = runBlocking {
        store.write("rec-1", PersistedBatchJob("old-job", 4, clock - 60_000))
        val service = ScriptedService(statusFor = { BatchJobStatus("completed", durationMs = 2_000.0) })

        val result = transcriber(service).transcribe(audio(), resumeKey = "rec-1")

        assertEquals(0, service.uploads)
        assertEquals(listOf("old-job"), service.polledIds.distinct())
        assertEquals(listOf("old-job"), service.deletedIds)
        assertEquals("hello", result.segments.single().text)
    }

    @Test
    fun `a job that is gone is forgotten and the audio uploaded fresh`() = runBlocking {
        store.write("rec-1", PersistedBatchJob("old-job", 4, clock))
        val service = ScriptedService(
            statusFor = { id -> if (id == "old-job") throw NotFound() else BatchJobStatus("completed") },
        )

        transcriber(service).transcribe(audio(), resumeKey = "rec-1")

        assertEquals(1, service.uploads)
        assertEquals(listOf("job-1"), service.deletedIds)
        assertNull(store.read("rec-1"))
    }

    @Test
    fun `a job that errored is forgotten and the audio uploaded fresh`() = runBlocking {
        store.write("rec-1", PersistedBatchJob("old-job", 4, clock))
        val service = ScriptedService(
            statusFor = { id ->
                if (id == "old-job") BatchJobStatus("error", errorMessage = "boom") else BatchJobStatus("completed")
            },
        )

        transcriber(service).transcribe(audio(), resumeKey = "rec-1")

        assertEquals(1, service.uploads)
        assertNull(store.read("rec-1"))
    }

    @Test
    fun `a fresh job that errors is forgotten and the failure reported`() = runBlocking {
        val service = ScriptedService(statusFor = { BatchJobStatus("error", errorMessage = "too short") })

        val thrown = runCatching { transcriber(service).transcribe(audio(), resumeKey = "rec-1") }.exceptionOrNull()

        assertTrue(thrown is BatchTranscriptionException.JobFailed)
        assertNull(store.read("rec-1"))
    }

    @Test
    fun `the remembered job is cleared once the transcript is in hand`() = runBlocking {
        val service = ScriptedService(statusFor = { BatchJobStatus("completed") })

        transcriber(service).transcribe(audio(), resumeKey = "rec-1")

        assertNull(store.read("rec-1"))
        assertEquals(listOf("job-1"), service.deletedIds)
    }

    @Test
    fun `a network failure while resuming keeps the job for next time`() = runBlocking {
        store.write("rec-1", PersistedBatchJob("old-job", 4, clock))
        val service = ScriptedService(statusFor = { throw IOException("offline") })

        val thrown = runCatching { transcriber(service).transcribe(audio(), resumeKey = "rec-1") }.exceptionOrNull()

        assertTrue(thrown is IOException)
        assertEquals(0, service.uploads)
        assertNotNull(store.read("rec-1"))
    }

    @Test
    fun `a job older than the resume window is not resumed`() = runBlocking {
        store.write("rec-1", PersistedBatchJob("old-job", 4, clock - BatchTranscriber.MAX_RESUME_AGE_MS))
        val service = ScriptedService(statusFor = { BatchJobStatus("completed") })

        transcriber(service).transcribe(audio(), resumeKey = "rec-1")

        assertEquals(1, service.uploads)
        assertTrue("old-job" !in service.polledIds)
    }

    @Test
    fun `a job made from different audio is not resumed`() = runBlocking {
        store.write("rec-1", PersistedBatchJob("old-job", 999, clock))
        val service = ScriptedService(statusFor = { BatchJobStatus("completed") })

        transcriber(service).transcribe(audio(4), resumeKey = "rec-1")

        assertEquals(1, service.uploads)
        assertTrue("old-job" !in service.polledIds)
    }

    @Test
    fun `without a resume key nothing is remembered`() = runBlocking {
        val service = ScriptedService(statusFor = { BatchJobStatus("processing") })

        runCatching { transcriber(service).transcribe(audio()) }

        assertTrue(store.isEmpty())
    }

    @Test
    fun `the file store round-trips and clears`() {
        val files = FileBatchJobStore(temporary.newFolder("jobs"))
        val job = PersistedBatchJob("job-9", 123, 456)

        files.write("3f1c-uuid", job)
        assertEquals(job, files.read("3f1c-uuid"))

        files.clear("3f1c-uuid")
        assertNull(files.read("3f1c-uuid"))

        files.write("a/../b", job)
        assertEquals(job, files.read("a/../b"))
        files.clearAll()
        assertNull(files.read("a/../b"))
    }

    @Test
    fun `an unreadable file reads as nothing remembered`() {
        val dir = temporary.newFolder("jobs")
        File(dir, "rec-1.json").writeText("{not json")

        assertNull(FileBatchJobStore(dir).read("rec-1"))
    }
}

private class NotFound : IOException("404 not_found")

private class MemoryJobStore : BatchJobStore {
    private val jobs = mutableMapOf<String, PersistedBatchJob>()
    override fun read(key: String): PersistedBatchJob? = jobs[key]
    override fun write(key: String, job: PersistedBatchJob) {
        jobs[key] = job
    }
    override fun clear(key: String) {
        jobs.remove(key)
    }
    override fun clearAll() = jobs.clear()
    fun isEmpty() = jobs.isEmpty()
}

private class ScriptedService(
    private val statusFor: (String) -> BatchJobStatus,
    private val fail: (() -> Exception)? = null,
) : BatchTranscriptionService {
    var uploads = 0
        private set
    val polledIds = mutableListOf<String>()
    val deletedIds = mutableListOf<String>()

    override suspend fun startBatchJob(
        audio: File,
        diarization: Boolean,
        languageHints: List<String>,
        terms: List<String>,
    ): String {
        uploads++
        return "job-$uploads"
    }

    override suspend fun batchJobStatus(id: String): BatchJobStatus {
        polledIds += id
        return statusFor(id)
    }

    override suspend fun batchTranscript(id: String): BatchTranscriptResponse {
        fail?.let { throw it() }
        return BatchTranscriptResponse(listOf(BatchToken("hello", 0, 1_000, 0)))
    }

    override suspend fun deleteBatchJob(id: String) {
        deletedIds += id
    }

    override fun isJobNotFound(error: Throwable): Boolean = error is NotFound
}
