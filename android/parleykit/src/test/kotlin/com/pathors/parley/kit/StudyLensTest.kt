package com.pathors.parley.kit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The desktop's `lens.test.ts` and `presets.test.ts`, on the phone's port. */
class StudyLensTest {

    @Test
    fun `every kind maps to a lens and its own template`() {
        assertEquals(AnalysisLens.DECISION, MeetingKind.INTERNAL.lens)
        assertEquals(AnalysisLens.OPPORTUNITY, MeetingKind.SALES.lens)
        assertEquals(AnalysisLens.ADVERSARIAL, MeetingKind.PRICING.lens)
        assertEquals(AnalysisLens.ADVERSARIAL, MeetingKind.RIVALRY.lens)
        assertEquals(MeetingKind.entries.size, MeetingKind.entries.map { it.template }.toSet().size)
    }

    @Test
    fun `an unknown kind reads as the decision lens`() {
        assertEquals(AnalysisLens.DECISION, AnalysisLens.of(null))
        assertNull(MeetingKind.fromWire("negotiation"))
        assertNull(MeetingKind.fromWire(null))
    }

    @Test
    fun `pricing and rivalry share an output shape but not their watchers`() {
        assertEquals(MeetingKind.PRICING.lens, MeetingKind.RIVALRY.lens)
        assertNotEquals(MeetingKind.PRICING.template, MeetingKind.RIVALRY.template)
    }

    @Test
    fun `the lens predicates`() {
        assertFalse(AnalysisLens.DECISION.hasSides)
        assertFalse(AnalysisLens.DECISION.hasResolution)
        assertTrue(AnalysisLens.DECISION.hasCategories)
        assertTrue(AnalysisLens.OPPORTUNITY.hasSides)
        assertFalse(AnalysisLens.OPPORTUNITY.hasResolution)
        assertTrue(AnalysisLens.ADVERSARIAL.hasSides)
        assertTrue(AnalysisLens.ADVERSARIAL.hasResolution)
        assertFalse(AnalysisLens.ADVERSARIAL.hasCategories)
    }

    @Test
    fun `each lens's field guide asks for the fields its predicates advertise`() {
        for (lens in AnalysisLens.entries) {
            val guide = StudyPrompts.TIMELINE_FIELD_GUIDE.getValue(lens.wire)
            assertEquals(lens.hasSides, guide.contains("- side:"))
            assertEquals(lens.hasCategories, guide.contains("- category:"))
        }
    }

    @Test
    fun `meeting notes are not graded`() {
        val notes = StudyPrompts.BRIEF_SECTIONS.getValue("decision")
        assertFalse(notes.contains("What fell short"))
        assertTrue(notes.contains("## Decisions"))
        assertTrue(StudyPrompts.BRIEF_SECTIONS.getValue("adversarial").contains("## What fell short"))
    }

    @Test
    fun `every built-in evaluation has a unique id, a prompt and both names`() {
        val ids = StudyPrompts.EVALS.map { it.id }
        assertEquals(ids.size, ids.toSet().size)
        for (eval in StudyPrompts.EVALS) {
            assertTrue(eval.id, eval.prompt.length > 40)
            assertTrue(eval.id, eval.nameEn.isNotBlank() && eval.nameZhTw.isNotBlank())
        }
        for (template in StudyPrompts.TEMPLATES.values) assertTrue(template.all { it in ids })
    }

    @Test
    fun `an unclassified recording watches with the internal template`() {
        val internal = EvalPresets.forKind(MeetingKind.INTERNAL, FilingLanguage.EN)
        assertEquals(internal, EvalPresets.forKind(null, FilingLanguage.EN))
        assertEquals("in-undecided", internal.first().id)
    }

    @Test
    fun `evaluation names follow the UI language, prompts stay English`() {
        val zh = EvalPresets.forKind(MeetingKind.SALES, FilingLanguage.ZH_TW)
        val en = EvalPresets.forKind(MeetingKind.SALES, FilingLanguage.EN)
        assertEquals(en.map { it.id }, zh.map { it.id })
        assertEquals(en.map { it.prompt }, zh.map { it.prompt })
        assertEquals("顧慮", zh.first { it.id == "sl-objections" }.name)
        assertEquals("Objections", en.first { it.id == "sl-objections" }.name)
    }
}
