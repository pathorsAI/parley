package com.pathors.parley.feedback

import com.pathors.parley.cloud.CloudException
import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The offline queue: idempotent by id, bounded at twenty, and a flush that
 * drops what the cloud will refuse forever but keeps what a later try can
 * deliver.
 */
class FeedbackQueueTest {

    @get:Rule
    val folder = TemporaryFolder()

    private val dropped = mutableListOf<String>()

    private fun queue() = FeedbackQueue(folder.root.resolve("FeedbackQueue")) { id, _ -> dropped += id }

    private fun payload(id: String, trigger: FeedbackTrigger = FeedbackTrigger.MANUAL, message: String? = null) =
        FeedbackPayload(
            id = id,
            trigger = trigger,
            message = message,
            diagnostics = JsonObject(mapOf("app" to JsonObject(mapOf("version" to JsonPrimitive("1.16"))))),
        )

    @Test
    fun `the payload is the shape the cloud expects, optional fields left out`() {
        val json = payload("r1").toJson()

        assertEquals(setOf("id", "trigger", "tags", "diagnostics"), json.keys)
        assertEquals("manual", json["trigger"]!!.jsonPrimitive.content)
        assertEquals(0, json["tags"]!!.jsonArray.size)

        val full = payload("r2", FeedbackTrigger.RETRANSCRIBE, "  ").copy(recordingId = "rec-1", tags = listOf("missing"))
            .toJson()
        assertEquals("rec-1", full["recordingId"]!!.jsonPrimitive.content)
        assertNull("a blank message is not a message", full["message"])
        assertEquals("missing", full["tags"]!!.jsonArray.single().jsonPrimitive.content)
    }

    @Test
    fun `enqueuing the same id twice keeps one report`() {
        val queue = queue()
        queue.enqueue(payload("same", message = "first"), nowMs = 1)
        queue.enqueue(payload("same", message = "second"), nowMs = 2)

        val all = queue.list()
        assertEquals(1, all.size)
        assertEquals("second", all.single().payload["message"]!!.jsonPrimitive.content)
    }

    @Test
    fun `past twenty the oldest reports go`() {
        val queue = queue()
        (1..25).forEach { queue.enqueue(payload("r$it"), nowMs = it.toLong()) }

        val ids = queue.list().map { it.id }
        assertEquals(FeedbackQueue.MAX_REPORTS, ids.size)
        assertEquals("r6", ids.first())
        assertEquals("r25", ids.last())
    }

    @Test
    fun `a screenshot is moved in with its report and sent with it`() = runBlocking {
        val queue = queue()
        val shot = folder.newFile("shot.jpg").apply { writeBytes(byteArrayOf(1, 2, 3)) }
        queue.enqueue(payload("r1"), shot, nowMs = 1)

        assertFalse("moved, not copied", shot.exists())
        val sent = mutableListOf<Pair<String, Int?>>()
        queue.flush { json, image -> sent += json to image?.readBytes()?.size }

        assertEquals(3, sent.single().second)
        assertEquals("r1", kotlinx.serialization.json.Json.parseToJsonElement(sent.single().first).jsonObject["id"]!!.jsonPrimitive.content)
        assertFalse(queue.screenshotFile("r1").exists())
    }

    @Test
    fun `a successful flush empties the queue, oldest first`() = runBlocking {
        val queue = queue()
        queue.enqueue(payload("b"), nowMs = 2)
        queue.enqueue(payload("a"), nowMs = 1)
        val order = mutableListOf<String>()

        val result = queue.flush { json, _ -> order += idOf(json) }

        assertEquals(listOf("a", "b"), order)
        assertEquals(FeedbackQueue.FlushResult(sent = 2, dropped = 0, remaining = 0), result)
    }

    @Test
    fun `a report the cloud refuses for good is dropped and the pass goes on`() = runBlocking {
        val queue = queue()
        queue.enqueue(payload("too-big"), nowMs = 1)
        queue.enqueue(payload("fine"), nowMs = 2)

        val result = queue.flush { json, _ ->
            if (idOf(json) == "too-big") throw CloudException(413, "payload_too_large")
        }

        assertEquals(FeedbackQueue.FlushResult(sent = 1, dropped = 1, remaining = 0), result)
        assertEquals(listOf("too-big"), dropped)
    }

    @Test
    fun `no network or a busy server stops the pass and keeps everything`() = runBlocking {
        listOf<Throwable>(IOException("offline"), CloudException(503, "down"), CloudException(429, "rate_limited"))
            .forEach { failure ->
                val queue = FeedbackQueue(folder.newFolder()) { _, _ -> }
                queue.enqueue(payload("a"), nowMs = 1)
                queue.enqueue(payload("b"), nowMs = 2)
                var attempts = 0

                val result = queue.flush { _, _ ->
                    attempts++
                    throw failure
                }

                assertEquals(failure.toString(), 1, attempts)
                assertEquals(2, result.remaining)
            }
    }

    @Test
    fun `resending after a lost answer is safe because the id does not change`() = runBlocking {
        val queue = queue()
        queue.enqueue(payload("r1"), nowMs = 1)
        val seen = mutableListOf<String>()

        queue.flush { json, _ ->
            seen += idOf(json)
            throw IOException("response lost")
        }
        queue.flush { json, _ -> seen += idOf(json) }

        assertEquals(listOf("r1", "r1"), seen)
        assertEquals(0, queue.count())
    }

    @Test
    fun `permanent means a 4xx retrying cannot fix`() {
        assertTrue(FeedbackQueue.isPermanent(CloudException(400, "bad_trigger")))
        assertTrue(FeedbackQueue.isPermanent(CloudException(413, "too_large")))
        assertFalse(FeedbackQueue.isPermanent(CloudException(429, "rate_limited")))
        assertFalse(FeedbackQueue.isPermanent(CloudException(408, "timeout")))
        assertFalse(FeedbackQueue.isPermanent(CloudException(500, "oops")))
        assertFalse(FeedbackQueue.isPermanent(IOException("offline")))
    }

    private fun idOf(json: String): String =
        kotlinx.serialization.json.Json.parseToJsonElement(json).jsonObject["id"]!!.jsonPrimitive.content
}
