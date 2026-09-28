package com.pathors.parley.ui

import com.pathors.parley.cloud.CloudException
import com.pathors.parley.cloud.RecordingMeta
import java.io.IOException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the summary page reads out of a recording — iOS
 * `RecordingMetaAnalysisTests`, case for case, plus how a failed load is told.
 */
class RecordingAnalysisTest {

    private fun meta(extra: String): RecordingMeta =
        RecordingMeta(Json.parseToJsonElement("""{ "id": "rec-1", "title": "T" $extra }""").jsonObject)

    private fun state(extra: String) = RecordingDetailViewModel.fromMeta(meta(extra))

    @Test
    fun `no analysis means nothing to summarise`() {
        val empty = state(""", "findings": [], "actionItems": [], "brief": "  " """)
        assertFalse(empty.hasAnalysis)
        assertEquals("", empty.brief)
        assertTrue(empty.actionItems.isEmpty())
    }

    @Test
    fun `any of the three counts as analysis`() {
        assertTrue(state(""", "brief": "Short." """).hasAnalysis)
        assertTrue(state(""", "findings": [{ "title": "A", "atMs": 1.0 }] """).hasAnalysis)
        assertTrue(state(""", "actionItems": [{ "id": "a", "text": "Do it", "done": false }] """).hasAnalysis)
    }

    @Test
    fun `action items read and tick`() {
        var m = meta(
            """, "actionItems": [
                { "id": "a", "text": "Send the quote", "done": false, "atMs": 12500.0, "severity": "warn" },
                { "id": "b", "text": "Book the demo", "done": true, "atMs": null },
                { "id": "c", "text": "   " }
            ]""",
        )
        assertEquals(
            listOf(
                ActionItemRow(id = "a", text = "Send the quote", done = false, atMs = 12_500),
                ActionItemRow(id = "b", text = "Book the demo", done = true, atMs = null),
            ),
            RecordingDetailViewModel.readActionItems(m),
        )
        m = m.withActionItem("a", done = true)
        assertEquals(listOf(true, true), RecordingDetailViewModel.readActionItems(m).map { it.done })
        // Fields the phone does not model survive the tick.
        val first = m.raw["actionItems"]!!.jsonArray.first().jsonObject
        assertEquals("warn", first["severity"]!!.jsonPrimitive.content)
    }

    @Test
    fun `an action item without an id is ticked by its position`() {
        val m = meta(""", "actionItems": [{ "text": "One" }, { "text": "Two" }]""")
        val items = RecordingDetailViewModel.readActionItems(m)
        assertEquals(listOf("action-0", "action-1"), items.map { it.id })
        val ticked = m.withActionItem("action-1", done = true)
        assertEquals(listOf(false, true), RecordingDetailViewModel.readActionItems(ticked).map { it.done })
    }

    @Test
    fun `a tick on an entry without action items changes nothing`() {
        val m = meta("")
        assertTrue(m.withActionItem("a", done = true).raw == m.raw)
    }

    @Test
    fun `findings come in timeline order and carry severity`() {
        val m = meta(""", "findings": [{ "title": "B", "atMs": 5.0, "severity": "critical" }, { "title": "A", "atMs": 1.0 }]""")
        val findings = RecordingDetailViewModel.readFindings(m)
        assertEquals(listOf("A", "B"), findings.map { it.title })
        assertEquals(listOf(null, "critical"), findings.map { it.severity })
    }

    @Test
    fun `a finding needs a title, and one without a moment sits at zero`() {
        val m = meta(""", "findings": [{ "detail": "no title" }, { "title": "Untimed" }]""")
        val findings = RecordingDetailViewModel.readFindings(m)
        assertEquals(listOf("Untimed"), findings.map { it.title })
        assertEquals(0L, findings.single().atMs)
        assertEquals("finding-1", findings.single().id)
    }

    @Test
    fun `the brief is read trimmed`() {
        assertEquals("**Call.** Pain [0:07].", state(""", "brief": "\n **Call.** Pain [0:07].\n" """).brief)
    }

    @Test
    fun `a failed load says why`() {
        val classify = RecordingDetailViewModel::classifyLoadFailure
        assertEquals(DetailLoadFailure.NETWORK, classify(IOException("offline")))
        assertEquals(DetailLoadFailure.NOT_FOUND, classify(CloudException(404, "gone")))
        assertEquals(DetailLoadFailure.FORBIDDEN, classify(CloudException(403, "no")))
        assertEquals(DetailLoadFailure.SIGNED_OUT, classify(CloudException(401, "expired")))
        assertEquals(DetailLoadFailure.SERVER, classify(CloudException(500, "boom")))
        assertEquals(DetailLoadFailure.NETWORK, classify(CloudException(408, "slow")))
    }

    @Test
    fun `every failure has its own words`() {
        assertEquals(
            DetailLoadFailure.entries.size,
            DetailLoadFailure.entries.map(::loadFailureRes).toSet().size,
        )
    }
}
