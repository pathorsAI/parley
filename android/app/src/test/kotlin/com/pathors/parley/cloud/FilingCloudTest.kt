package com.pathors.parley.cloud

import com.pathors.parley.kit.FilingFolder
import com.pathors.parley.kit.FilingFolderSuggestion
import com.pathors.parley.kit.FilingLanguage
import com.pathors.parley.kit.FilingSuggester
import com.pathors.parley.kit.FilingSuggestion
import com.pathors.parley.kit.TranscriptSegment
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The filing pass on the wire — `POST v1/chat/completions` through the
 * authenticated client, against a mock server only — and the `filingSuggested`
 * flag every answer writes back into the recording's meta.
 */
class FilingCloudTest {
    private val server = MockWebServer()

    private fun client(unauthorized: AtomicInteger = AtomicInteger()): CloudClient =
        CloudClient(
            baseUrl = server.url("/").toString(),
            tokenProvider = { "session-token" },
            onUnauthorized = { unauthorized.incrementAndGet() },
        )

    @After
    fun tearDown() {
        server.shutdown()
    }

    private val segments = listOf(
        TranscriptSegment("mix-0", "mix", 1, "Let's go over the Acme renewal.", true, 3_000, 5_000),
    )

    private fun suggest(cloud: CloudClient): FilingSuggestion? = runBlocking {
        FilingSuggester.suggest(
            segments = segments,
            speakerLabel = { "Speaker ${it.speaker}" },
            currentTitle = CLOCK_TITLE,
            folders = listOf(FilingFolder("f-acme", "Acme Corp")),
            chat = cloud,
            language = FilingLanguage.EN,
        )
    }

    @Test
    fun `the pass posts the fast-model request to the chat endpoint with the bearer token`() {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"choices":[{"message":{"role":"assistant","content":"{\"title\":\"Acme renewal\",\"folders\":[{\"name\":\"Acme Corp\",\"isNew\":false,\"reason\":\"customer\"}]}"}}]}""",
            ),
        )

        val suggestion = suggest(client())

        assertEquals(
            FilingSuggestion("Acme renewal", listOf(FilingFolderSuggestion("f-acme", "Acme Corp", "customer"))),
            suggestion,
        )
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/v1/chat/completions", request.path)
        assertEquals("Bearer session-token", request.getHeader("Authorization"))
        assertTrue(request.getHeader("Content-Type").orEmpty().startsWith("application/json"))
        val body = CloudJson.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals("parley-fast", body["model"]?.jsonPrimitive?.content)
        assertTrue(body.toString().contains("[0:03] [Speaker 1] Let's go over the Acme renewal."))
    }

    @Test
    fun `an HTTP failure throws, and a 401 still signs out`() {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"code":"UNAUTHORIZED"}"""))
        val unauthorized = AtomicInteger()

        val error = runCatching { suggest(client(unauthorized)) }.exceptionOrNull()

        assertTrue(error is CloudException && error.isAuthExpired)
        assertEquals(1, unauthorized.get())
    }

    @Test
    fun `a 200 the pass cannot read is no suggestion rather than an error`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"choices":[]}"""))
        assertEquals(null, suggest(client()))
    }

    // ── the flag the desktop reads ───────────────────────────────────────────

    @Test
    fun `filingSuggested round-trips through the raw meta`() {
        val meta = RecordingMeta(
            buildJsonObject {
                put("id", "r-1")
                put("title", CLOCK_TITLE)
                put("brief", "a desktop-only field")
            },
        )
        assertFalse("absent means the pass has not run", meta.filingSuggested)

        val answered = meta.withTitle("Acme renewal terms").withFilingSuggested()

        assertEquals("Acme renewal terms", answered.title)
        assertTrue(answered.filingSuggested)
        assertTrue(answered.raw.getValue(FLAG).jsonPrimitive.boolean)
        assertEquals("fields this app never heard of survive", JsonPrimitive("a desktop-only field"), answered.raw["brief"])
        assertEquals("the title keeps its place", listOf("id", "title", "brief", FLAG), answered.raw.keys.toList())
        assertFalse("the original is untouched", meta.filingSuggested)
    }

    @Test
    fun `a flag the desktop wrote is read back`() {
        val meta = RecordingMeta(JsonObject(mapOf(FLAG to JsonPrimitive(true))))
        assertTrue(meta.filingSuggested)
    }

    private companion object {
        const val CLOCK_TITLE = "Meeting Sep 7, 3:20 PM"
        const val FLAG = "filingSuggested"
    }
}
