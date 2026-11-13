package com.pathors.parley.cloud

import com.pathors.parley.kit.CloudDictionaryEntry
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `GET` / `PUT /v1/dictionary` on the wire — the shapes iOS `CloudClient` and
 * the desktop's `dictionarySync.ts` already speak. A drift here is a term added
 * on the Mac that never reaches the phone.
 */
class CloudClientDictionaryTest {
    private val server = MockWebServer()

    private fun client() = CloudClient(baseUrl = server.url("/").toString(), tokenProvider = { "session-token" })

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `pulls everything, then from a cursor`() = runBlocking {
        val body = """{"entries":[{"id":"a","phrase":"Parley","variants":["怕理"],"source":"learned",""" +
            """"confirmed":true,"updatedAt":5,"deletedAt":null}],"now":9}"""
        server.enqueue(MockResponse().setBody(body))
        server.enqueue(MockResponse().setBody("""{"entries":[],"now":10}"""))

        val first = client().pullDictionary(null)
        client().pullDictionary(9)

        assertEquals("/v1/dictionary", server.takeRequest().path)
        assertEquals("/v1/dictionary?since=9", server.takeRequest().path)
        assertEquals(listOf("怕理"), first.entries.single().variants)
        assertEquals(9L, first.now)
    }

    @Test
    fun `pushes one batch as entries and reads the refusals`() = runBlocking {
        server.enqueue(
            MockResponse().setBody("""{"entries":[],"rejected":[{"index":1,"id":"b","error":"phrase_too_long"}]}"""),
        )

        val response = client().pushDictionary(
            listOf(
                CloudDictionaryEntry("a", "Parley", listOf("怕理"), "learned", updatedAt = 5),
                CloudDictionaryEntry("b", "Gone", emptyList(), "manual", updatedAt = 6, deletedAt = 6),
            ),
        )

        val request = server.takeRequest()
        assertEquals("PUT", request.method)
        assertEquals("/v1/dictionary", request.path)
        assertEquals("Bearer session-token", request.getHeader("Authorization"))
        val entries = CloudJson.parseToJsonElement(request.body.readUtf8()).jsonObject.getValue("entries").jsonArray
        assertFalse("a live entry omits deletedAt", entries[0].jsonObject.containsKey("deletedAt"))
        assertEquals("6", entries[1].jsonObject.getValue("deletedAt").jsonPrimitive.content)
        assertTrue(entries[0].jsonObject.getValue("confirmed").jsonPrimitive.content.toBoolean())
        assertEquals(1, response.rejected.single().index)
    }
}
