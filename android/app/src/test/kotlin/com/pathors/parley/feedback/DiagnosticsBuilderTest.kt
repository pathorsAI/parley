package com.pathors.parley.feedback

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The `diagnostics` shape of spec §5, the size budget the cloud enforces, and
 * the narrower crash report the settings footnote promises.
 */
class DiagnosticsBuilderTest {

    private val base = DiagnosticsInput(
        appVersion = "1.16",
        appBuild = "9",
        osVersion = "14",
        sdkInt = 34,
        deviceModel = "Google Pixel 8",
        locale = "zh-TW",
        timezone = "Asia/Taipei",
    )

    private fun entry(level: Char, message: String, at: Long = 1_759_030_000_000L) =
        LogRing.Entry(atMs = at, level = level, tag = "MeetingSession", message = message)

    @Test
    fun `the shared shape, with absent fields left out`() {
        val json = DiagnosticsBuilder.build(
            base.copy(
                recording = RecordingContext(recordingId = "rec-1", recordingDurationMs = 1_440_000, transcriptSegments = 0),
                micPermission = "granted",
                signedIn = true,
            ),
        )

        assertEquals("1.16", json.str("app", "version"))
        assertEquals("9", json.str("app", "build"))
        assertEquals("Android", json.str("os", "name"))
        assertEquals("14", json.str("os", "version"))
        assertEquals("Google Pixel 8", json.str("device", "model"))
        assertEquals("zh-TW", json.str("device", "locale"))
        assertEquals("Asia/Taipei", json.str("device", "timezone"))
        val context = json["context"]!!.jsonObject
        assertEquals("rec-1", context["recordingId"]!!.jsonPrimitive.content)
        assertEquals(0, context["transcriptSegments"]!!.jsonPrimitive.int)
        assertEquals("granted", context["micPermission"]!!.jsonPrimitive.content)
        // Not known, so not sent — not sent as zero or null.
        assertNull(context["lastSegmentEndMs"])
        assertNull(context["audioRoute"])
        assertNull(context["syncPendingCount"])
        assertNull("no log, no log field", json["log"])
        assertNull(json["recentErrors"])
        assertNull(json["crash"])
    }

    @Test
    fun `recent errors are the warnings and errors, newest twenty`() {
        val log = (1..30).map { entry(if (it % 2 == 0) 'W' else 'I', "line $it", at = it.toLong()) }
        val json = DiagnosticsBuilder.build(base.copy(log = log))

        val errors = json["recentErrors"]!!.jsonArray
        assertEquals(15, errors.size)
        assertEquals("MeetingSession", errors.last().jsonObject["code"]!!.jsonPrimitive.content)
        assertEquals("line 30", errors.last().jsonObject["message"]!!.jsonPrimitive.content)
        assertTrue(json["log"]!!.jsonPrimitive.content.contains("I/MeetingSession: line 1"))
    }

    @Test
    fun `a logged exception names its class in the error code`() {
        val log = listOf(entry('E', "upload failed").copy(error = "SocketTimeoutException: timeout"))
        val json = DiagnosticsBuilder.build(base.copy(log = log))

        assertEquals(
            "MeetingSession:SocketTimeoutException",
            json["recentErrors"]!!.jsonArray.single().jsonObject["code"]!!.jsonPrimitive.content,
        )
    }

    @Test
    fun `the log is held to its own budget, keeping the newest lines`() {
        val log = (1..2_000).map { entry('I', "line $it ".padEnd(80, 'x'), at = it.toLong()) }
        val json = DiagnosticsBuilder.build(base.copy(log = log))

        val text = json["log"]!!.jsonPrimitive.content
        assertTrue(text.toByteArray().size <= DiagnosticsBuilder.LOG_MAX_BYTES)
        assertTrue("the end of the log is where the problem is", text.contains("line 2000 "))
        assertFalse(text.contains("line 1 "))
    }

    @Test
    fun `the whole report stays under the cloud's limit even with a big crash block`() {
        val log = (1..2_000).map { entry('W', "line $it ".padEnd(200, 'y'), at = it.toLong()) }
        val crash = buildJsonObject { put("trace", "t".repeat(DiagnosticsBuilder.CRASH_TRACE_MAX_BYTES)) }
        val json = DiagnosticsBuilder.build(base.copy(log = log, crash = crash))

        assertTrue(DiagnosticsBuilder.utf8Size(json) <= DiagnosticsBuilder.MAX_BYTES)
        assertTrue("the crash is never what gets cut", json["crash"] != null)
    }

    @Test
    fun `a crash report carries only version, device, OS and the crash`() {
        val crash = buildJsonObject { put("reason", "uncaught_exception") }
        val json = DiagnosticsBuilder.forCrash(
            base.copy(
                recording = RecordingContext(recordingId = "rec-1"),
                signedIn = true,
                log = listOf(entry('E', "boom")),
                crash = crash,
            ),
        )

        assertEquals(setOf("app", "os", "device", "crash"), json.keys)
        assertEquals(setOf("model"), json["device"]!!.jsonObject.keys)
        assertEquals("uncaught_exception", json.str("crash", "reason"))
    }

    @Test
    fun `truncation never splits a character`() {
        val text = "逐字稿".repeat(10)
        val cut = DiagnosticsBuilder.truncateUtf8(text, 10)

        assertEquals("逐字稿", cut)
    }

    private fun JsonObject.str(outer: String, inner: String): String =
        this[outer]!!.jsonObject[inner]!!.jsonPrimitive.content
}
