package com.pathors.parley.cloud

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The four `/stt/batch` calls on the wire.
 *
 * `BatchTranscriber`'s own behaviour is covered in `:parleykit` against a fake
 * service; what is left to get wrong is here — the paths, the query parameters
 * that decide whether the cloud diarizes, and the fact that a failed cleanup
 * must not throw at a caller holding a finished transcript.
 */
class CloudClientBatchTest {

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

    @Test
    fun `starting a job posts the audio with diarization and hints`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"id":"job-42"}"""))
        val audio = temporary.newFile("meeting.ogg").apply { writeBytes(ByteArray(64) { 7 }) }

        val id = client().startBatchJob(audio, diarization = true, languageHints = listOf("zh", "en"))

        assertEquals("job-42", id)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/stt/batch?diarization=1&language_hints=zh%2Cen", request.path)
        assertEquals("Bearer session-token", request.getHeader("Authorization"))
        assertEquals("application/octet-stream", request.getHeader("Content-Type"))
        assertEquals(64L, request.bodySize)
    }

    @Test
    fun `no language hints means no parameter, so the cloud auto-detects`() = runBlocking {
        // An empty list handed to the cloud is a different statement from an
        // absent one, and the desktop sends nothing.
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"id":"job-1"}"""))
        val audio = temporary.newFile("plain.ogg").apply { writeBytes(ByteArray(8)) }

        client().startBatchJob(audio, diarization = false, languageHints = emptyList())

        assertEquals("/stt/batch?diarization=0", server.takeRequest().path)
    }

    @Test
    fun `a status decodes what the cloud reports and tolerates what it omits`() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"status":"completed","durationMs":612000,"somethingNew":true}""",
            ),
        )

        val status = client().batchJobStatus("job-42")

        assertEquals("/stt/batch/job-42", server.takeRequest().path)
        assertEquals("completed", status.status)
        assertEquals(612_000L, status.durationMsOrZero)
        assertNull(status.errorMessage)
    }

    @Test
    fun `a transcript comes back with its tokens`() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"tokens":[{"text":"Hi","startMs":0,"endMs":400,"speaker":"1"}]}""",
            ),
        )

        val transcript = client().batchTranscript("job-42")

        assertEquals("/stt/batch/job-42/transcript", server.takeRequest().path)
        assertEquals(1, transcript.tokens.size)
        assertEquals(1, transcript.tokens[0].speaker)
    }

    @Test
    fun `deleting a job that is already gone is not an error`() = runBlocking {
        // The transcript is in hand by the time this runs; a cleanup that fails
        // must not turn a successful transcription into a failed one.
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not_found"}"""))

        client().deleteBatchJob("job-42")

        val request = server.takeRequest()
        assertEquals("DELETE", request.method)
        assertEquals("/stt/batch/job-42", request.path)
    }

    @Test
    fun `a refused job surfaces its status so the wording can be specific`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(413).setBody("""{"error":"too_large"}"""))
        val audio = temporary.newFile("huge.ogg").apply { writeBytes(ByteArray(16)) }

        val thrown = runCatching {
            client().startBatchJob(audio, diarization = true, languageHints = emptyList())
        }.exceptionOrNull()

        assertTrue("$thrown", thrown is CloudException)
        assertEquals(413, (thrown as CloudException).status)
        assertEquals(
            BatchTranscriptionFailure.TOO_LARGE,
            thrown.asBatchTranscriptionProblem().failure,
        )
    }
}
