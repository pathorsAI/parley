package com.pathors.parley.ui

import com.pathors.parley.cloud.BatchTranscriptionFailure
import com.pathors.parley.cloud.BatchTranscriptionProblem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The "transcribe again" state machine, driven without a container, a cloud or
 * a coroutine.
 *
 * This is the part of the feature that is worth testing in isolation, because
 * every one of its states is a *refusal to spend money* or a promise about what
 * is going to happen to the document on screen — and both are things a screen
 * can only get right if the state underneath it is unambiguous. The two rules
 * that carry the most weight here:
 *
 * - a run that is in flight outranks every other reason the action might be
 *   unavailable, so a queued recording never offers a second run; and
 * - a failure that arrives while the recording stays queued is *both* facts at
 *   once, because reporting only "queued" would bury a quota message.
 */
class RetranscribeStateTest {

    private val ready = RetranscribeState(retriesRemaining = 3, audioObtainable = true)

    private val quota = BatchTranscriptionProblem(BatchTranscriptionFailure.QUOTA_EXHAUSTED, 402)

    @Test
    fun `a loaded recording with retries and audio can be re-transcribed`() {
        assertTrue(ready.canRequest)
        assertNull(ready.block)
        assertFalse("nothing has happened yet, so nothing to report", ready.showsStatus)
    }

    @Test
    fun `confirming is the only thing a tap does`() {
        val confirming = ready.confirming()

        assertEquals(RetranscribeState.Phase.CONFIRMING, confirming.phase)
        // Nothing is queued and nothing is spent until the dialog is answered.
        assertEquals(ready.retriesRemaining, confirming.retriesRemaining)
        assertFalse(
            "the dialog is the feedback; a band behind it would pre-announce it",
            confirming.showsStatus,
        )
    }

    @Test
    fun `a blocked state cannot be walked into the dialog`() {
        // The menu item is disabled, but the state has to refuse as well: the
        // budget can run out elsewhere while this screen is open.
        val spent = ready.copy(retriesRemaining = 0)
        val silent = ready.copy(audioObtainable = false)
        val queued = ready.queued()

        assertEquals(spent, spent.confirming())
        assertEquals(silent, silent.confirming())
        assertEquals(queued, queued.confirming())
    }

    @Test
    fun `cancelling returns to idle and leaves a queued run alone`() {
        assertEquals(RetranscribeState.Phase.IDLE, ready.confirming().dismissed().phase)
        // A dismissal racing a queue read must not knock the screen out of the
        // state that says the transcript is about to be replaced.
        val queued = ready.queued()
        assertEquals(queued, queued.dismissed())
    }

    @Test
    fun `working clears the last complaint`() {
        val retry = ready.failed(RetranscribeFailure.Cloud(quota)).working()

        assertEquals(RetranscribeState.Phase.WORKING, retry.phase)
        assertNull("a new attempt does not inherit the old one's error", retry.failure)
        assertTrue(retry.showsStatus)
        assertTrue(retry.isRunning)
    }

    @Test
    fun `a run in flight outranks every other reason`() {
        // Both of the other blocks apply too. In-flight is the one to say,
        // because it is the only one that is going to change by itself.
        val queued = ready.copy(retriesRemaining = 0, audioObtainable = false).queued()

        assertEquals(RetranscribeBlock.IN_FLIGHT, queued.block)
        assertFalse(queued.canRequest)
        assertTrue(queued.showsStatus)
    }

    @Test
    fun `a landed run returns to idle with one fewer retry`() {
        val settled = ready.queued().settled(retriesRemaining = 2)

        assertEquals(RetranscribeState.Phase.IDLE, settled.phase)
        assertEquals(2, settled.retriesRemaining)
        assertNull(settled.failure)
        assertFalse(settled.showsStatus)
        assertTrue("with retries left it can be asked for again", settled.canRequest)
    }

    @Test
    fun `a pass that failed without clearing the queue reports both`() {
        val stuck = ready.queued().stillQueued(quota)

        assertEquals(RetranscribeState.Phase.QUEUED, stuck.phase)
        assertEquals(RetranscribeFailure.Cloud(quota), stuck.failure)
        // Still queued, so still no second run — and the budget is untouched,
        // because nothing was transcribed.
        assertEquals(RetranscribeBlock.IN_FLIGHT, stuck.block)
        assertEquals(3, stuck.retriesRemaining)
    }

    @Test
    fun `a pass that stopped for no stated reason still reads as queued`() {
        val stuck = ready.queued().stillQueued(problem = null)

        assertEquals(RetranscribeState.Phase.QUEUED, stuck.phase)
        assertNull(stuck.failure)
        assertTrue("the spinner is the whole message here", stuck.isRunning)
    }

    @Test
    fun `a budget refusal is also the last word on the budget`() {
        // The ledger says no, so the count has to follow — otherwise the menu
        // would go on offering a retry the queue has just refused.
        val spent = ready.working().failed(RetranscribeFailure.BudgetSpent)

        assertEquals(RetranscribeState.Phase.FAILED, spent.phase)
        assertEquals(0, spent.retriesRemaining)
        assertEquals(RetranscribeBlock.BUDGET_SPENT, spent.block)
        assertFalse(spent.canRequest)
        assertTrue(spent.showsStatus)
    }

    @Test
    fun `an ordinary failure leaves the action available to try again`() {
        val failed = ready.working().failed(RetranscribeFailure.Cloud(quota))

        assertEquals(RetranscribeState.Phase.FAILED, failed.phase)
        assertEquals("a refusal that never ran costs nothing", 3, failed.retriesRemaining)
        assertNull(failed.block)
        assertTrue(failed.canRequest)
    }

    @Test
    fun `a recording with no audio anywhere cannot be re-transcribed`() {
        val silent = ready.copy(audioObtainable = false)

        assertEquals(RetranscribeBlock.NO_AUDIO, silent.block)
        assertFalse(silent.canRequest)
    }

    @Test
    fun `the audio being unreachable is a failure, not a permanent block`() {
        // The download can fail for the evening and work tomorrow, so this
        // reports and stands down rather than disabling the action.
        val failed = ready.working().failed(RetranscribeFailure.AudioUnavailable)

        assertEquals(RetranscribeFailure.AudioUnavailable, failed.failure)
        assertTrue(failed.canRequest)
    }

    @Test
    fun `every reason the action is unavailable has its own sentence`() {
        val copy = RetranscribeBlock.entries.map { retranscribeNoteRes(it) }

        assertEquals(
            "two blocks sharing a string would explain the wrong one",
            copy.size,
            copy.toSet().size,
        )
        assertTrue("a block with no copy would disable the item silently", copy.all { it != 0 })
    }
}
