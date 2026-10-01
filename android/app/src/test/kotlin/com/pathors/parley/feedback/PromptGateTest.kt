package com.pathors.parley.feedback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The client-side frequency limits of spec §4: two brush-offs buy thirty days
 * of quiet, one recording is asked about once, and crash / manual are never
 * held back.
 */
class PromptGateTest {

    @get:Rule
    val folder = TemporaryFolder()

    private val day = 24L * 60 * 60 * 1000
    private val t0 = 1_759_000_000_000L

    @Test
    fun `a fresh gate lets every prompt through`() {
        val gate = PromptGate()

        FeedbackTrigger.entries.forEach { trigger ->
            assertTrue(trigger.name, gate.canShow(trigger, "rec-1", t0))
        }
    }

    @Test
    fun `one recording is asked about once per trigger`() {
        val gate = PromptGate().markShown(FeedbackTrigger.EMPTY_TRANSCRIPT, "rec-1")

        assertFalse(gate.canShow(FeedbackTrigger.EMPTY_TRANSCRIPT, "rec-1", t0))
        assertTrue("another recording", gate.canShow(FeedbackTrigger.EMPTY_TRANSCRIPT, "rec-2", t0))
        assertTrue("another trigger", gate.canShow(FeedbackTrigger.TRUNCATED_TRANSCRIPT, "rec-1", t0))
    }

    @Test
    fun `one brush-off is not enough to go quiet`() {
        val gate = PromptGate().markIgnored(FeedbackTrigger.SCREENSHOT, t0)

        assertTrue(gate.canShow(FeedbackTrigger.SCREENSHOT, null, t0 + 1))
    }

    @Test
    fun `two brush-offs silence that trigger for thirty days, and only that trigger`() {
        val gate = PromptGate()
            .markIgnored(FeedbackTrigger.SCREENSHOT, t0)
            .markIgnored(FeedbackTrigger.SCREENSHOT, t0 + day)

        assertFalse(gate.canShow(FeedbackTrigger.SCREENSHOT, null, t0 + day))
        assertFalse(gate.canShow(FeedbackTrigger.SCREENSHOT, null, t0 + day + 29 * day))
        assertTrue(gate.canShow(FeedbackTrigger.SCREENSHOT, null, t0 + day + 30 * day))
        assertTrue("other triggers are unaffected", gate.canShow(FeedbackTrigger.SYNC_FAILED, "rec-1", t0 + day))
    }

    @Test
    fun `after a quiet spell the count starts again from zero`() {
        val quiet = PromptGate()
            .markIgnored(FeedbackTrigger.DELETE_FAILED, t0)
            .markIgnored(FeedbackTrigger.DELETE_FAILED, t0)
        val later = t0 + PromptGate.QUIET_MS + 1
        val once = quiet.markIgnored(FeedbackTrigger.DELETE_FAILED, later)

        assertTrue(once.canShow(FeedbackTrigger.DELETE_FAILED, "rec-9", later))
        assertFalse(once.markIgnored(FeedbackTrigger.DELETE_FAILED, later).canShow(FeedbackTrigger.DELETE_FAILED, "rec-9", later))
    }

    @Test
    fun `crash and manual are never limited`() {
        var gate = PromptGate()
        repeat(5) {
            gate = gate.markIgnored(FeedbackTrigger.CRASH, t0).markIgnored(FeedbackTrigger.MANUAL, t0)
                .markShown(FeedbackTrigger.CRASH, "rec-1")
        }

        assertTrue(gate.canShow(FeedbackTrigger.CRASH, "rec-1", t0))
        assertTrue(gate.canShow(FeedbackTrigger.MANUAL, null, t0))
    }

    @Test
    fun `the shown list is bounded`() {
        var gate = PromptGate()
        repeat(PromptGate.MAX_REMEMBERED + 10) { gate = gate.markShown(FeedbackTrigger.SYNC_FAILED, "rec-$it") }

        assertEquals(PromptGate.MAX_REMEMBERED, gate.shown.size)
        assertFalse("the newest is remembered", gate.canShow(FeedbackTrigger.SYNC_FAILED, "rec-${PromptGate.MAX_REMEMBERED + 9}", t0))
    }

    @Test
    fun `the store keeps the gate across instances`() {
        val file = folder.root.resolve("Feedback/prompts.json")
        PromptGateStore(file).update { it.markShown(FeedbackTrigger.MIC_RECOVERY, "rec-1") }

        assertFalse(PromptGateStore(file).read().canShow(FeedbackTrigger.MIC_RECOVERY, "rec-1", t0))
    }

    @Test
    fun `an unreadable store reads as a fresh gate rather than a silenced one`() {
        val file = folder.newFile("prompts.json").apply { writeText("{not json") }

        assertEquals(PromptGate(), PromptGateStore(file).read())
    }
}
