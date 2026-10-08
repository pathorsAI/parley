package com.pathors.parley.ui

import com.pathors.parley.cloud.RecordingMeta
import com.pathors.parley.kit.ArtifactDisplay
import com.pathors.parley.kit.StageStatus
import com.pathors.parley.kit.StudyArtifact
import com.pathors.parley.study.RecordingStudy
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Which sections the report draws, and what each says — see [ReportLayout]. */
class ReportLayoutTest {

    private fun state(extra: String = "") = RecordingDetailViewModel.fromMeta(
        RecordingMeta(Json.parseToJsonElement("""{ "id": "rec-1", "title": "T" $extra }""").jsonObject),
    )

    private fun study(
        statuses: Map<StudyArtifact, StageStatus> = emptyMap(),
        auto: Boolean = true,
        canSpend: Boolean = true,
    ) = RecordingStudy(
        statuses = StudyArtifact.entries.associateWith { statuses[it] ?: StageStatus.IDLE },
        hasTranscript = true,
        autoAnalysis = auto,
        canSpend = canSpend,
    )

    @Test
    fun `without the pipeline, only sections with content are drawn`() {
        val layout = ReportLayout.of(state(""", "brief": "B" """), study = null)
        assertEquals(ArtifactDisplay.DONE, layout.brief)
        assertNull(layout.actions)
        assertNull(layout.timeline)
        assertNull(layout.delivery)
        assertTrue(ReportLayout.of(state(), study = null).empty)
    }

    @Test
    fun `a fresh recording shows every section queued, never a blank page`() {
        val layout = ReportLayout.of(state(), study())
        assertEquals(ArtifactDisplay.QUEUED, layout.brief)
        assertEquals(ArtifactDisplay.QUEUED, layout.actions)
        assertEquals(ArtifactDisplay.QUEUED, layout.timeline)
        assertEquals(ArtifactDisplay.QUEUED, layout.delivery)
        assertFalse(layout.empty)
    }

    @Test
    fun `a finished empty stage still says it finished`() {
        val layout = ReportLayout.of(
            state(""", "findings": [], "actionItems": [], "analyzed": true """),
            study(mapOf(StudyArtifact.FINDINGS to StageStatus.DONE, StudyArtifact.ACTIONS to StageStatus.DONE)),
        )
        assertEquals(ArtifactDisplay.DONE, layout.timeline)
        assertEquals(ArtifactDisplay.DONE, layout.actions)
    }

    @Test
    fun `with auto-analysis off an unanalysed recording is the empty state`() {
        assertTrue(ReportLayout.of(state(), study(auto = false)).empty)
    }

    @Test
    fun `a failure is drawn as one`() {
        val layout = ReportLayout.of(state(), study(mapOf(StudyArtifact.FINDINGS to StageStatus.ERROR)))
        assertEquals(ArtifactDisplay.ERROR, layout.timeline)
        // The chain is dead: downstream is neither queued nor drawn.
        assertNull(layout.actions)
    }

    @Test
    fun `the report reads the delivery read and the lens fields of a finding`() {
        val s = state(
            """, "deliveryAssessment": { "tone": "firm", "toneEvidence": "", "fillers": { "level": "ok", "examples": [], "note": "" }, "summary": "S" },
                "findings": [
                  { "id": "f1", "title": "A", "atMs": 1.0, "side": "them", "severity": "warn", "resolved": true, "resolution": "Traded." },
                  { "id": "f2", "title": "B", "atMs": 2.0, "category": "open", "resolved": true }
                ]""",
        )
        assertEquals("firm", s.delivery!!.tone)
        assertTrue(s.hasAnalysis)
        val (a, b) = s.findings
        assertEquals("them", a.side)
        assertTrue(a.resolved)
        assertEquals("Traded.", a.resolution)
        assertEquals("open", b.category)
        // "Resolved" with no "how" is not shown as resolved.
        assertFalse(b.resolved)
    }
}
