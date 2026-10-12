package com.pathors.parley.kit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The study pipeline's topology and what the chip says about it — the
 * desktop's `studyPipeline.test.ts`, case for case where the phone has the
 * same facts (no live mode, wizard or diarization here).
 */
class StudyPipelineTest {

    private fun facts(
        findings: StageStatus = StageStatus.IDLE,
        actions: StageStatus = StageStatus.IDLE,
        brief: StageStatus = StageStatus.IDLE,
        delivery: StageStatus = StageStatus.IDLE,
        hasTranscript: Boolean = true,
        canSpend: Boolean = true,
        autoAnalyze: Boolean = true,
    ) = StudyFacts(
        hasTranscript = hasTranscript,
        canSpend = canSpend,
        autoAnalyze = autoAnalyze,
        statuses = mapOf(
            StudyArtifact.FINDINGS to findings,
            StudyArtifact.ACTIONS to actions,
            StudyArtifact.BRIEF to brief,
            StudyArtifact.DELIVERY to delivery,
        ),
    )

    private val done = StageStatus.DONE

    @Test
    fun `a fresh recording starts with the findings pass only`() {
        assertEquals(listOf(StudyArtifact.FINDINGS), StudyPipeline.evaluateStages(facts()))
    }

    @Test
    fun `finished findings fan out to action items and delivery, the brief still waits`() {
        assertEquals(
            listOf(StudyArtifact.ACTIONS, StudyArtifact.DELIVERY),
            StudyPipeline.evaluateStages(facts(findings = done)),
        )
    }

    @Test
    fun `the brief starts once action items settle, done or error alike`() {
        for (actions in listOf(StageStatus.DONE, StageStatus.ERROR)) {
            assertEquals(
                listOf(StudyArtifact.BRIEF),
                StudyPipeline.evaluateStages(facts(findings = done, actions = actions, delivery = done)),
            )
        }
    }

    @Test
    fun `a failed findings pass stops the chain`() {
        assertEquals(emptyList<StudyArtifact>(), StudyPipeline.evaluateStages(facts(findings = StageStatus.ERROR)))
    }

    @Test
    fun `nothing runs without the hosted model or without a transcript`() {
        assertTrue(StudyPipeline.evaluateStages(facts(canSpend = false)).isEmpty())
        assertTrue(StudyPipeline.evaluateStages(facts(hasTranscript = false)).isEmpty())
    }

    @Test
    fun `auto-analysis off stops every stage, mid-chain too`() {
        assertTrue(StudyPipeline.evaluateStages(facts(autoAnalyze = false)).isEmpty())
        assertTrue(StudyPipeline.evaluateStages(facts(autoAnalyze = false, findings = done)).isEmpty())
    }

    @Test
    fun `a running stage is never dispatched twice`() {
        assertTrue(StudyPipeline.evaluateStages(facts(findings = StageStatus.RUNNING)).isEmpty())
        assertEquals(
            listOf(StudyArtifact.DELIVERY),
            StudyPipeline.evaluateStages(facts(findings = done, actions = StageStatus.RUNNING)),
        )
    }

    @Test
    fun `a fresh recording reads fully queued, never a silent blank`() {
        val p = StudyPipeline.progress(facts())
        assertTrue(p.displays.values.all { it == ArtifactDisplay.QUEUED })
        assertTrue(p.active)
        assertEquals(0, p.done)
    }

    @Test
    fun `the brief reads queued for the whole findings to action-items window`() {
        val p = StudyPipeline.progress(facts(findings = done, actions = StageStatus.RUNNING))
        assertEquals(ArtifactDisplay.QUEUED, p.displays[StudyArtifact.BRIEF])
        assertEquals(ArtifactDisplay.RUNNING, p.displays[StudyArtifact.ACTIONS])
        assertTrue(p.active)
    }

    @Test
    fun `without the hosted model nothing is queued`() {
        val p = StudyPipeline.progress(facts(canSpend = false))
        assertTrue(p.displays.values.all { it == ArtifactDisplay.IDLE })
        assertFalse(p.active)
    }

    @Test
    fun `a failed findings pass shows the error upstream and idle downstream`() {
        val p = StudyPipeline.progress(facts(findings = StageStatus.ERROR))
        assertEquals(ArtifactDisplay.ERROR, p.displays[StudyArtifact.FINDINGS])
        assertEquals(ArtifactDisplay.IDLE, p.displays[StudyArtifact.ACTIONS])
        assertEquals(ArtifactDisplay.IDLE, p.displays[StudyArtifact.BRIEF])
        assertEquals(1, p.errors)
        assertFalse(p.active)
    }

    @Test
    fun `a fully restored recording counts four of four with no activity`() {
        val p = StudyPipeline.progress(facts(findings = done, actions = done, brief = done, delivery = done))
        assertEquals(4, p.total)
        assertEquals(4, p.done)
        assertFalse(p.active)
    }

    @Test
    fun `auto-analysis off reads idle, not queued`() {
        val p = StudyPipeline.progress(facts(autoAnalyze = false))
        assertTrue(p.displays.values.all { it == ArtifactDisplay.IDLE })
        assertFalse(p.active)
    }

    @Test
    fun `the chip lists the four artifacts in the desktop's order`() {
        assertEquals(
            listOf(StudyArtifact.FINDINGS, StudyArtifact.ACTIONS, StudyArtifact.BRIEF, StudyArtifact.DELIVERY),
            StudyPipeline.progress(facts()).displays.keys.toList(),
        )
    }

    // ── restoring from the meta (store.ts restoredStudyStatuses) ─────────────

    @Test
    fun `analyzed marks even an empty result as done`() {
        val s = StudyPipeline.restoredStatuses(
            analyzed = true, findingsCount = 0, actionItemsCount = 0,
            hasDelivery = false, hasBrief = false, briefFailed = false,
        )
        assertEquals(StageStatus.DONE, s[StudyArtifact.FINDINGS])
        assertEquals(StageStatus.DONE, s[StudyArtifact.ACTIONS])
        assertEquals(StageStatus.IDLE, s[StudyArtifact.BRIEF])
        assertEquals(StageStatus.IDLE, s[StudyArtifact.DELIVERY])
    }

    @Test
    fun `findings without action items still owe their action items`() {
        val s = StudyPipeline.restoredStatuses(
            analyzed = false, findingsCount = 3, actionItemsCount = 0,
            hasDelivery = true, hasBrief = false, briefFailed = false,
        )
        assertEquals(StageStatus.DONE, s[StudyArtifact.FINDINGS])
        assertEquals(StageStatus.IDLE, s[StudyArtifact.ACTIONS])
        assertEquals(StageStatus.DONE, s[StudyArtifact.DELIVERY])
    }

    @Test
    fun `a brief that failed last time restores as an error, and a saved one wins`() {
        val failed = StudyPipeline.restoredStatuses(false, 0, 0, false, hasBrief = false, briefFailed = true)
        assertEquals(StageStatus.ERROR, failed[StudyArtifact.BRIEF])
        val saved = StudyPipeline.restoredStatuses(false, 0, 0, false, hasBrief = true, briefFailed = true)
        assertEquals(StageStatus.DONE, saved[StudyArtifact.BRIEF])
    }
}
