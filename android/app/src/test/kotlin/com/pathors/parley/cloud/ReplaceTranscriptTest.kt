package com.pathors.parley.cloud

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What a re-transcription is allowed to change about a recording, and — much
 * more importantly — what it is not. Ported from iOS `ReplaceTranscriptTests`.
 */
class ReplaceTranscriptTest {

    private fun seg(
        id: String,
        text: String,
        speaker: Int = 0,
        start: Long = 0,
        end: Long = 1_000,
    ) = TranscriptSegmentDto(
        id = id,
        source = "mix",
        speaker = speaker,
        text = text,
        isFinal = true,
        startMs = start,
        endMs = end,
    )

    /**
     * A recording somebody has lived with: names typed in, a desktop analysis on
     * it, meeting context filled out, filed in a folder.
     */
    private fun lovedRecording(): RecordingMeta = RecordingMeta(
        buildJsonObject {
            put("id", "rec-1")
            put("title", "Pricing call")
            put("source", "live")
            put("createdAt", 1_700_000_000_000)
            put("durationMs", 600_000)
            put("segments", RecordingMeta.encodeSegments(listOf(seg("mix-0", "thin"))))
            putJsonObject("speakerNames") {
                put("mix-0", "Jack")
                put("mix-1", "Ada")
            }
            putJsonArray("findings") {
                addJsonObject {
                    put("id", "f1")
                    put("atMs", 1_000)
                    put("title", "Asked for 20% off")
                    put("detail", "x")
                }
            }
            putJsonArray("actionItems") {
                addJsonObject {
                    put("id", "a1")
                    put("text", "Send the revised quote")
                }
            }
            put("meetingContext", "renewal")
            put("meetingBatna", "walk")
            put("folderId", "folder-9")
            put("analyzed", true)
            put("filingSuggested", true)
            // A field only the desktop writes. The phone must round-trip it
            // untouched — that is the whole point of keeping `raw`.
            putJsonObject("brief") { put("headline", "They will sign") }
        }
    )

    // ── meta ─────────────────────────────────────────────────────────────────

    @Test
    fun `the transcript is replaced and nothing else is`() {
        val meta = lovedRecording().replacingTranscript(
            listOf(
                seg("mix-0", "the whole call"),
                seg("mix-1", "every word of it", speaker = 1),
            ),
            durationMs = 612_000.0,
        )

        assertEquals(listOf("the whole call", "every word of it"), meta.segments.map { it.text })
        assertEquals(612_000.0, meta.durationMs, 0.0)

        assertEquals("Pricing call", meta.title)
        assertEquals(mapOf("mix-0" to "Jack", "mix-1" to "Ada"), meta.speakerNames)
        assertEquals(1, meta.findingsCount)
        assertEquals(1, meta.actionItemsCount)
        assertEquals("folder-9", meta.folderId)
        assertTrue(meta.analyzed)
        assertEquals(JsonPrimitive(true), meta.raw["filingSuggested"])
        assertEquals(JsonPrimitive("renewal"), meta.raw["meetingContext"])
        assertEquals(
            JsonPrimitive("They will sign"),
            (meta.raw["brief"] as JsonObject)["headline"],
        )
    }

    /**
     * A batch job's reported length can undershoot what the recording already
     * knew about itself, and a recording that suddenly got shorter would break
     * the player and the coverage arithmetic both.
     */
    @Test
    fun `a shorter reported duration does not shrink the recording`() {
        val meta = lovedRecording()
            .replacingTranscript(listOf(seg("mix-0", "x")), durationMs = 1_000.0)

        assertEquals(600_000.0, meta.durationMs, 0.0)
    }

    @Test
    fun `the encoded segments survive a read back`() {
        val segments = listOf(
            seg("mix-0", "first", speaker = 1, start = 0, end = 2_000),
            seg("mix-1", "second", speaker = 2, start = 2_000, end = 5_500),
        )
        val meta = RecordingMeta(JsonObject(emptyMap()))
            .replacingTranscript(segments, durationMs = 5_500.0)

        assertEquals(segments, meta.segments)
    }

    /**
     * The tentative tail is never persisted, so everything written back reads as
     * committed — including a segment that arrived claiming otherwise.
     */
    @Test
    fun `encoding always marks segments final`() {
        val tentative = TranscriptSegmentDto(
            id = "mix-tail",
            source = "mix",
            speaker = 0,
            text = "half a th",
            isFinal = false,
            startMs = 0,
            endMs = 500,
        )
        val encoded = RecordingMeta.encodeSegments(listOf(tentative))

        assertEquals(JsonPrimitive(true), (encoded[0] as JsonObject)["isFinal"])
    }

    @Test
    fun `a recording that is only a transcript still round-trips its other keys`() {
        // The key ordering changes (segments and durationMs are rewritten at the
        // end), which must not lose anything: a desktop reads this object into a
        // HistoryEntry and a dropped field is a dropped feature.
        val before = lovedRecording()
        val after = before.replacingTranscript(listOf(seg("mix-0", "x")), durationMs = 0.0)

        assertEquals(before.raw.keys, after.raw.keys)
    }

    // ── summary ──────────────────────────────────────────────────────────────

    @Test
    fun `only the facts the transcript speaks for move`() {
        val before = RecordingSummary(
            id = "rec-1",
            title = "Pricing call",
            source = "live",
            createdAt = 1_700_000_000_000.0,
            durationMs = 600_000.0,
            speakerCount = 1,
            findingsCount = 4,
            actionItemsCount = 2,
            hasAudio = true,
            snippet = "thin",
            folderId = "folder-9",
            updatedAt = 1_700_000_100_000.0,
        )

        val after = before.replacingTranscript(
            listOf(
                seg("mix-0", "Hello."),
                seg("mix-1", "Hi there.", speaker = 1),
                seg("mix-2", "Shall we start?", speaker = 2),
            ),
            durationMs = 612_000.0,
        )

        assertEquals(3, after.speakerCount)
        assertEquals("Hello. Hi there. Shall we start?", after.snippet)
        assertEquals(612_000.0, after.durationMs, 0.0)

        assertEquals(before.id, after.id)
        assertEquals(before.title, after.title)
        assertEquals(4, after.findingsCount)
        assertEquals(2, after.actionItemsCount)
        assertEquals("folder-9", after.folderId)
        assertEquals("live", after.source)
        assertEquals(before.createdAt, after.createdAt, 0.0)
        assertTrue(after.hasAudio)
    }

    @Test
    fun `a snippet is capped so a list request does not carry whole meetings`() {
        val long = "字".repeat(200)

        assertEquals(120, RecordingSummary.snippet(listOf(seg("mix-0", long))).length)
    }

    @Test
    fun `an unattributed transcript still has a speaker`() {
        assertEquals(0, RecordingSummary.speakerCount(emptyList()))
        assertEquals(
            1,
            RecordingSummary.speakerCount(listOf(seg("mix-0", "a"), seg("mix-1", "b"))),
        )
    }

    /**
     * The detail screen fetches only the meta, so a re-transcription asked for
     * there has to be able to build the library card the re-push replaces.
     */
    @Test
    fun `a summary can be derived from the meta alone`() {
        val summary = RecordingSummary.fromMeta(lovedRecording())

        assertEquals("rec-1", summary.id)
        assertEquals("Pricing call", summary.title)
        assertEquals("live", summary.source)
        assertEquals(600_000.0, summary.durationMs, 0.0)
        assertEquals("folder-9", summary.folderId)
        assertEquals(1, summary.findingsCount)
        assertEquals(1, summary.actionItemsCount)
        assertEquals("thin", summary.snippet)
        // `updatedAt` is the server's own write clock; inventing one would
        // reorder a last-writer-wins merge.
        assertEquals(null, summary.updatedAt)
    }

    @Test
    fun `a meta without an audio key is a summary without audio`() {
        val meta = RecordingMeta(buildJsonObject { put("id", "rec-2") })
        val summary = RecordingSummary.fromMeta(meta)

        assertEquals(false, summary.hasAudio)
        assertEquals(0, summary.speakerCount)
    }

    @Test
    fun `an empty findings array is zero, not a crash`() {
        val meta = RecordingMeta(
            buildJsonObject {
                put("id", "rec-3")
                put("findings", JsonArray(emptyList()))
                putJsonArray("actionItems") { add(JsonPrimitive("nonsense")) }
            }
        )

        assertEquals(0, meta.findingsCount)
        assertEquals(1, meta.actionItemsCount)
    }
}
