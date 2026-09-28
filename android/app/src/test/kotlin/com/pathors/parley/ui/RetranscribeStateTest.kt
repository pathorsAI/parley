package com.pathors.parley.ui

import com.pathors.parley.cloud.BatchTranscriptionFailure
import com.pathors.parley.cloud.BatchTranscriptionProblem
import com.pathors.parley.upload.BackfillStatus
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
 * can only get right if the state underneath it is unambiguous. The rules that
 * carry the most weight here (iOS 1.14):
 *
 * - the spinner is drawn only while a run is actually alive;
 * - a request that is merely queued says so in plain words, with Start now,
 *   and does not stop the person asking again; and
 * - a failure line never shares the band with the spinner.
 */
class RetranscribeStateTest {

    private val ready = RetranscribeState(retriesRemaining = 3, audioObtainable = true)

    private val quota = BatchTranscriptionProblem(BatchTranscriptionFailure.QUOTA_EXHAUSTED, 402)

    @Test
    fun `a loaded recording with retries and audio can be re-transcribed`() {
        assertTrue(ready.canRequest)
        assertNull(ready.block)
        assertEquals("nothing has happened yet, so nothing to report", RetranscribeState.Status.NONE, ready.status)
    }

    @Test
    fun `confirming is the only thing a tap does`() {
        val confirming = ready.confirming()

        assertTrue(confirming.confirming)
        assertEquals(RetranscribeState.Phase.IDLE, confirming.phase)
        // Nothing is queued and nothing is spent until the dialog is answered.
        assertEquals(ready.retriesRemaining, confirming.retriesRemaining)
        assertEquals(
            "the dialog is the feedback; a band behind it would pre-announce it",
            RetranscribeState.Status.NONE,
            confirming.status,
        )
    }

    @Test
    fun `a blocked state cannot be walked into the dialog`() {
        // The menu item is disabled, but the state has to refuse as well: the
        // budget can run out elsewhere while this screen is open.
        val spent = ready.copy(retriesRemaining = 0)
        val silent = ready.copy(audioObtainable = false)
        val running = ready.working()

        assertEquals(spent, spent.confirming())
        assertEquals(silent, silent.confirming())
        assertEquals(running, running.confirming())
    }

    @Test
    fun `a queued request can be asked for again`() {
        // iOS 1.14: a job the system killed disabled its own retry for the life
        // of the install. A queued request is one nobody is working on.
        val queued = ready.queued()

        assertNull(queued.block)
        assertTrue(queued.canRequest)
        assertTrue(queued.confirming().confirming)
    }

    @Test
    fun `cancelling closes the dialog and leaves a queued request queued`() {
        assertFalse(ready.confirming().dismissed().confirming)
        val queued = ready.queued()
        val back = queued.confirming().dismissed()
        assertEquals(RetranscribeState.Phase.QUEUED, back.phase)
        assertEquals(RetranscribeState.Status.WAITING, back.status)
    }

    @Test
    fun `working clears the last complaint and spins`() {
        val retry = ready.failed(RetranscribeFailure.Cloud(quota)).confirming().working()

        assertEquals(RetranscribeState.Phase.WORKING, retry.phase)
        assertFalse(retry.confirming)
        assertNull("a new attempt does not inherit the old one's error", retry.failure)
        assertEquals(RetranscribeState.Status.RUNNING, retry.status)
        assertTrue(retry.isRunning)
    }

    @Test
    fun `a run that is alive outranks every other reason`() {
        // Both of the other blocks apply too. In-flight is the one to say,
        // because it is the only one that is going to change by itself.
        val running = ready.copy(retriesRemaining = 0, audioObtainable = false).working()

        assertEquals(RetranscribeBlock.IN_FLIGHT, running.block)
        assertFalse(running.canRequest)
    }

    @Test
    fun `queued with nothing running is plain text and start now, never the spinner`() {
        val waiting = ready.observed(BackfillStatus.Queued(lastAttemptAtMs = ATTEMPT))

        assertEquals(RetranscribeState.Phase.QUEUED, waiting.phase)
        assertEquals(RetranscribeState.Status.WAITING, waiting.status)
        assertFalse(waiting.isRunning)
        assertTrue(waiting.canStartNow)
        assertEquals(ATTEMPT, waiting.lastAttemptAtMs)
    }

    @Test
    fun `a queued request a pass has picked up spins`() {
        val running = ready.observed(BackfillStatus.Running)

        assertEquals(RetranscribeState.Status.RUNNING, running.status)
        assertEquals(RetranscribeBlock.IN_FLIGHT, running.block)
        assertFalse("nothing to start; it is already going", running.canStartNow)
    }

    @Test
    fun `the failure line and the spinner are never shown together`() {
        // A queued request with a complaint, which a background pass then picks
        // up: the band spins, and the complaint waits.
        val stuck = ready.working().stillQueued(quota)
        assertEquals(RetranscribeState.Status.WAITING, stuck.status)

        val pickedUp = stuck.observed(BackfillStatus.Running)
        assertEquals(RetranscribeState.Status.RUNNING, pickedUp.status)

        val letGo = pickedUp.observed(BackfillStatus.Queued(ATTEMPT))
        assertEquals("the reason is still there once it waits again", RetranscribeFailure.Cloud(quota), letGo.failure)
        assertEquals(RetranscribeState.Status.WAITING, letGo.status)
    }

    @Test
    fun `a landed run returns to idle with one fewer retry`() {
        val settled = ready.working().settled(retriesRemaining = 2)

        assertEquals(RetranscribeState.Phase.IDLE, settled.phase)
        assertEquals(2, settled.retriesRemaining)
        assertNull(settled.failure)
        assertEquals(RetranscribeState.Status.NONE, settled.status)
        assertTrue("with retries left it can be asked for again", settled.canRequest)
    }

    @Test
    fun `a pass that failed without clearing the queue reports both`() {
        val stuck = ready.working().stillQueued(quota)

        assertEquals(RetranscribeState.Phase.QUEUED, stuck.phase)
        assertEquals(RetranscribeFailure.Cloud(quota), stuck.failure)
        // Queued, so asking again is allowed — and the budget is untouched,
        // because nothing was transcribed.
        assertNull(stuck.block)
        assertEquals(3, stuck.retriesRemaining)
    }

    @Test
    fun `a pass that stopped for no stated reason says it did not finish`() {
        val stuck = ready.working().stillQueued(problem = null)

        assertEquals(RetranscribeState.Phase.QUEUED, stuck.phase)
        assertEquals(RetranscribeFailure.DidNotFinish, stuck.failure)
        assertEquals(RetranscribeState.Status.WAITING, stuck.status)
    }

    @Test
    fun `the queue emptying elsewhere takes a waiting screen back to idle`() {
        val waiting = ready.observed(BackfillStatus.Queued(null))
        val gone = waiting.observed(BackfillStatus.None)

        assertEquals(RetranscribeState.Phase.IDLE, gone.phase)
        assertNull(gone.lastAttemptAtMs)
    }

    @Test
    fun `a queue read never overwrites a request this screen is making`() {
        val working = ready.working()
        assertEquals(RetranscribeState.Phase.WORKING, working.observed(BackfillStatus.None).phase)
        assertEquals(RetranscribeState.Phase.WORKING, working.observed(BackfillStatus.Queued(null)).phase)
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
        assertEquals(RetranscribeState.Status.FAILURE, spent.status)
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
    fun `a retry of a queued request that failed still shows the request waiting`() {
        // The download failed on the second ask, but the first request is
        // still on disk: both facts, in the waiting band.
        val failed = ready.working().failed(RetranscribeFailure.AudioUnavailable)
            .observed(BackfillStatus.Queued(ATTEMPT))

        assertEquals(RetranscribeState.Status.WAITING, failed.status)
        assertEquals(RetranscribeFailure.AudioUnavailable, failed.failure)
    }

    @Test
    fun `a recording with no audio anywhere cannot be re-transcribed`() {
        val silent = ready.copy(audioObtainable = false)

        assertEquals(RetranscribeBlock.NO_AUDIO, silent.block)
        assertFalse(silent.canRequest)
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

    private companion object {
        const val ATTEMPT = 1_700_000_000_000L
    }
}
