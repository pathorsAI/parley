package com.pathors.parley.feedback

import java.io.File
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * Which previous crashes are reported: only exit records newer than the
 * watermark, never the history on the first launch that looks, one crash
 * reported once even though both the handler and the system recorded it.
 */
class CrashSelectionTest {

    @get:Rule
    val folder = TemporaryFolder()

    private fun exit(reason: String, at: Long) =
        ExitRecord(reason = reason, timestampMs = at, description = null, importance = 100)

    private fun uncaught(at: Long, file: File? = null) = PreviousCrash(
        timestampMs = at,
        block = JsonObject(mapOf("reason" to JsonPrimitive("uncaught_exception"), "timestamp" to JsonPrimitive(at))),
        file = file,
    )

    @Test
    fun `the first launch that looks reports no history but sets the watermark`() {
        val selection = CrashSelection.select(
            uncaught = emptyList(),
            exits = listOf(exit(ExitRecord.ANR, 1_000), exit(ExitRecord.CRASH_NATIVE, 5_000)),
            watermarkMs = null,
        )

        assertTrue(selection.crashes.isEmpty())
        assertEquals(5_000L, selection.watermarkMs)
    }

    @Test
    fun `only records newer than the watermark are reported`() {
        val selection = CrashSelection.select(
            uncaught = emptyList(),
            exits = listOf(exit(ExitRecord.ANR, 1_000), exit(ExitRecord.ANR, 5_000), exit(ExitRecord.CRASH_NATIVE, 9_000)),
            watermarkMs = 5_000,
        )

        assertEquals(listOf(9_000L), selection.crashes.map { it.timestampMs })
        assertEquals("crash_native", selection.crashes.single().block["reason"]!!.jsonPrimitive.content)
        assertEquals(9_000L, selection.watermarkMs)
    }

    @Test
    fun `nothing new leaves the watermark where it was`() {
        val selection = CrashSelection.select(uncaught = emptyList(), exits = listOf(exit(ExitRecord.ANR, 1_000)), watermarkMs = 7_000)

        assertTrue(selection.crashes.isEmpty())
        assertEquals(7_000L, selection.watermarkMs)
    }

    @Test
    fun `a Java crash the handler wrote is not reported a second time from the exit record`() {
        val file = folder.newFile("uncaught-10000.json")
        val selection = CrashSelection.select(
            uncaught = listOf(uncaught(10_000, file)),
            exits = listOf(exit(ExitRecord.CRASH, 10_400)),
            watermarkMs = 0,
        )

        assertEquals(1, selection.crashes.size)
        assertEquals("uncaught_exception", selection.crashes.single().block["reason"]!!.jsonPrimitive.content)
        assertEquals("the duplicate still moves the watermark", 10_400L, selection.watermarkMs)
        assertEquals(listOf(file), selection.handledFiles)
    }

    @Test
    fun `an exit crash far from any handler file is its own crash`() {
        val selection = CrashSelection.select(
            uncaught = listOf(uncaught(10_000)),
            exits = listOf(exit(ExitRecord.CRASH, 10_000 + CrashSelection.SAME_CRASH_MS + 1)),
            watermarkMs = 0,
        )

        assertEquals(2, selection.crashes.size)
    }

    @Test
    fun `an ANR next to a handler file is still reported — it is a different death`() {
        val selection = CrashSelection.select(
            uncaught = listOf(uncaught(10_000)),
            exits = listOf(exit(ExitRecord.ANR, 10_100)),
            watermarkMs = 0,
        )

        assertEquals(2, selection.crashes.size)
    }

    @Test
    fun `a crash loop is reported as its newest three`() {
        val selection = CrashSelection.select(
            uncaught = emptyList(),
            exits = (1..10).map { exit(ExitRecord.CRASH_NATIVE, it * 100_000L) },
            watermarkMs = 0,
        )

        assertEquals(listOf(800_000L, 900_000L, 1_000_000L), selection.crashes.map { it.timestampMs })
    }

    @Test
    fun `the handler writes the spec's shape and reads it back`() {
        val recorder = UncaughtCrashRecorder(folder.root.resolve("crashes"))
        val error = IllegalStateException("bad state for owner@example.com")

        recorder.write("main", error, nowMs = 42)
        val pending = recorder.pending().single()

        assertEquals(42L, pending.timestampMs)
        val block = pending.block
        assertEquals("uncaught_exception", block["reason"]!!.jsonPrimitive.content)
        assertEquals("main", block["thread"]!!.jsonPrimitive.content)
        assertEquals("java.lang.IllegalStateException: bad state for <email>", block["exception"]!!.jsonPrimitive.content)
        assertTrue(block["stacktrace"]!!.jsonPrimitive.content.contains("CrashSelectionTest"))
        assertFalse(block["stacktrace"]!!.jsonPrimitive.content.contains("owner@example.com"))
    }

    @Test
    fun `the handler's stack is cut to 48 KB`() {
        val deep = RuntimeException("x").apply {
            stackTrace = Array(5_000) { StackTraceElement("com.example.Deep", "frame$it", "Deep.kt", it) }
        }

        val block = UncaughtCrashRecorder.blockFor("main", deep, nowMs = 1)

        assertTrue(block["stacktrace"]!!.jsonPrimitive.content.toByteArray().size <= DiagnosticsBuilder.CRASH_TRACE_MAX_BYTES)
    }
}
