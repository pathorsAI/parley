package com.pathors.parley.cloud

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Test

/**
 * Two edits to one recording at once, against a fake cloud that behaves like
 * the worker: it hands out the whole meta and replaces it whole on a push,
 * with no version check. Each edit must read what the other wrote — the study's
 * action items and its delivery read finishing together must both survive.
 */
class RecordingMetaLocksTest {
    private val server = MockWebServer()

    /** The cloud's copy of the meta: what a GET returns, what a POST replaces. */
    @Volatile
    private var stored: JsonObject = buildJsonObject {
        put("id", "r1")
        put("title", "Renewal")
        put("createdAt", 1_700_000_000_000)
        put("source", "live")
    }

    /**
     * Held open until a second read arrives (or a short wait passes): without
     * the lock both edits read here before either pushes, which is the race.
     */
    private val bothRead = CountDownLatch(2)
    private val reads = AtomicInteger(0)

    /** Whether the first read was still in flight when the second one arrived. */
    private val firstReadOverlapped = AtomicBoolean(false)

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `two concurrent edits of one recording both survive`() = runBlocking {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.method) {
                "GET" -> {
                    val snapshot = stored
                    val first = reads.getAndIncrement() == 0
                    bothRead.countDown()
                    val sawOther = bothRead.await(READ_WAIT_MS, TimeUnit.MILLISECONDS)
                    if (first) firstReadOverlapped.set(sawOther)
                    MockResponse().setResponseCode(200).setBody(snapshot.toString())
                }
                else -> {
                    val body = CloudJson.parseToJsonElement(request.body.readUtf8()).jsonObject
                    stored = body.getValue("meta").jsonObject
                    MockResponse().setResponseCode(200).setBody("{}")
                }
            }
        }
        val client = CloudClient(baseUrl = server.url("/").toString(), tokenProvider = { "t" })

        listOf(
            async(Dispatchers.IO) { client.editRecordingIf("r1") { it.withBrief("The brief.") } },
            async(Dispatchers.IO) {
                client.editRecordingIf("r1") { it.withDeliveryAssessment(buildJsonObject { put("tone", "firm") }) }
            },
        ).awaitAll()

        val meta = RecordingMeta(stored)
        assertEquals("The brief.", meta.brief)
        assertNotNull("the delivery read was not erased by the brief", meta.deliveryAssessment)
        assertEquals("firm", meta.deliveryAssessment!!.jsonObject["tone"]!!.jsonPrimitive.content)
        assertEquals(4, server.requestCount)
        assertFalse("the two read-modify-writes overlapped", firstReadOverlapped.get())
    }

    private companion object {
        const val READ_WAIT_MS = 500L
    }
}
