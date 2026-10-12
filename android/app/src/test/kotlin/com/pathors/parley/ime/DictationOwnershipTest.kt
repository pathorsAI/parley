package com.pathors.parley.ime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Which field a dictation may write into, and what happens to a session nobody
 * owns. These are the rules that keep field A's words out of field B — and out
 * of a password field — so they are pinned here rather than trusted to the
 * input-method callbacks that drive them.
 */
class DictationOwnershipTest {

    private fun sequentialGate(): DictationFieldGate {
        var next = 100L
        return DictationFieldGate { next++ }
    }

    // ── the field gate ───────────────────────────────────────────────────────

    @Test
    fun `the first field attached is a new target`() {
        val gate = sequentialGate()
        assertTrue(gate.onStartInput(CHAT_APP, FIELD_A, restarting = false))
    }

    @Test
    fun `a dictation started in a field owns that field`() {
        val gate = sequentialGate()
        gate.onStartInput(CHAT_APP, FIELD_A, restarting = false)
        assertTrue(gate.owns(gate.currentToken))
    }

    @Test
    fun `moving to another field takes the dictation's ownership away`() {
        val gate = sequentialGate()
        gate.onStartInput(CHAT_APP, FIELD_A, restarting = false)
        val owner = gate.currentToken

        assertTrue(gate.onStartInput(CHAT_APP, FIELD_B, restarting = false))
        assertFalse(gate.owns(owner))
    }

    @Test
    fun `moving to the same field id in another app takes ownership away`() {
        val gate = sequentialGate()
        gate.onStartInput(CHAT_APP, FIELD_A, restarting = false)
        val owner = gate.currentToken

        gate.onStartInput(BANK_APP, FIELD_A, restarting = true)
        assertFalse(gate.owns(owner))
    }

    @Test
    fun `the app restarting the same editor keeps ownership`() {
        val gate = sequentialGate()
        gate.onStartInput(CHAT_APP, FIELD_A, restarting = false)
        val owner = gate.currentToken

        assertFalse(gate.onStartInput(CHAT_APP, FIELD_A, restarting = true))
        assertTrue(gate.owns(owner))
    }

    @Test
    fun `refocusing the same field without a restart is a new target`() {
        // Field ids are not unique enough to trust on their own: two views with
        // no id share one. Only the app's own restart is taken as "same field".
        val gate = sequentialGate()
        gate.onStartInput(CHAT_APP, FIELD_A, restarting = false)
        val owner = gate.currentToken

        assertTrue(gate.onStartInput(CHAT_APP, FIELD_A, restarting = false))
        assertFalse(gate.owns(owner))
    }

    @Test
    fun `a session without an owner is never owned`() {
        val gate = DictationFieldGate { DictationFieldGate.NO_OWNER }
        gate.onStartInput(CHAT_APP, FIELD_A, restarting = false)
        assertFalse(gate.owns(DictationFieldGate.NO_OWNER))
    }

    @Test
    fun `a recreated keyboard never owns its predecessor's session`() {
        val first = DictationFieldGate()
        first.onStartInput(CHAT_APP, FIELD_A, restarting = false)
        val orphan = first.currentToken

        val second = DictationFieldGate()
        second.onStartInput(CHAT_APP, FIELD_A, restarting = false)
        assertNotEquals(orphan, second.currentToken)
        assertFalse(second.owns(orphan))
    }

    // ── adopting a session ───────────────────────────────────────────────────

    @Test
    fun `nothing there starts a session`() {
        assertEquals(
            DictationAdoption.Action.START,
            DictationAdoption.decide(existing = null, existingOwner = 0, requestedOwner = OWNER),
        )
    }

    @Test
    fun `a live session from the same field is adopted`() {
        for (state in listOf(DictationState.Idle, DictationState.Connecting, DictationState.Listening)) {
            assertEquals(
                DictationAdoption.Action.ADOPT,
                DictationAdoption.decide(state, existingOwner = OWNER, requestedOwner = OWNER),
            )
        }
    }

    @Test
    fun `a live session from another field is replaced`() {
        assertEquals(
            DictationAdoption.Action.REPLACE,
            DictationAdoption.decide(DictationState.Listening, existingOwner = OWNER, requestedOwner = OTHER),
        )
    }

    @Test
    fun `a terminal session is never adopted, even by its own field`() {
        val terminal = listOf(
            DictationState.Done(text = "stale words", polished = false),
            DictationState.Failed(reason = DictationFailure.RELAY_ERROR, partialText = "stale"),
            DictationState.Cancelled,
        )
        for (state in terminal) {
            assertEquals(
                DictationAdoption.Action.REPLACE,
                DictationAdoption.decide(state, existingOwner = OWNER, requestedOwner = OWNER),
            )
        }
    }

    @Test
    fun `only done, failed and cancelled are terminal`() {
        assertFalse(DictationState.Idle.isTerminal())
        assertFalse(DictationState.Connecting.isTerminal())
        assertFalse(DictationState.Listening.isTerminal())
        assertFalse(DictationState.Finishing.isTerminal())
        assertTrue(DictationState.Done(text = "", polished = false).isTerminal())
        assertTrue(DictationState.Failed(reason = DictationFailure.UNKNOWN, partialText = "").isTerminal())
        assertTrue(DictationState.Cancelled.isTerminal())
    }

    // ── the composing region ─────────────────────────────────────────────────

    @Test
    fun `a region that was never seen is not gone`() {
        val tracker = ComposingSpanTracker()
        tracker.onSelectionUpdate(NO_REGION, NO_REGION)
        assertFalse(tracker.isGone)
    }

    @Test
    fun `a region that disappears is gone`() {
        val tracker = ComposingSpanTracker()
        tracker.onSelectionUpdate(0, RAW.length)
        tracker.onSelectionUpdate(NO_REGION, NO_REGION)
        assertTrue(tracker.isGone)
    }

    @Test
    fun `a region that comes back is no longer gone`() {
        val tracker = ComposingSpanTracker()
        tracker.onSelectionUpdate(0, RAW.length)
        tracker.onSelectionUpdate(NO_REGION, NO_REGION)
        tracker.onSelectionUpdate(0, RAW.length)
        assertFalse(tracker.isGone)
    }

    @Test
    fun `reset forgets a lost region`() {
        val tracker = ComposingSpanTracker()
        tracker.onSelectionUpdate(0, RAW.length)
        tracker.onSelectionUpdate(NO_REGION, NO_REGION)
        tracker.reset()
        assertFalse(tracker.isGone)
        tracker.onSelectionUpdate(NO_REGION, NO_REGION)
        assertFalse(tracker.isGone)
    }

    // ── the final commit ─────────────────────────────────────────────────────

    @Test
    fun `the polished text replaces a region that still holds the raw text`() {
        assertEquals(
            FinalCommit.Action.COMMIT,
            FinalCommit.decide(regionGone = false, textBeforeCursor = "Hi. $RAW", composed = RAW),
        )
    }

    @Test
    fun `nothing is committed once the app has taken the region away`() {
        // The user tapped Send on the raw text: the field is empty and the
        // region is gone. Committing now would type the message a second time.
        assertEquals(
            FinalCommit.Action.LEAVE,
            FinalCommit.decide(regionGone = true, textBeforeCursor = "", composed = RAW),
        )
    }

    @Test
    fun `nothing is committed when the field no longer ends with the raw text`() {
        assertEquals(
            FinalCommit.Action.LEAVE,
            FinalCommit.decide(regionGone = false, textBeforeCursor = "", composed = RAW),
        )
    }

    @Test
    fun `an editor that will not say what is before the cursor still gets the commit`() {
        assertEquals(
            FinalCommit.Action.COMMIT,
            FinalCommit.decide(regionGone = false, textBeforeCursor = null, composed = RAW),
        )
    }

    @Test
    fun `a dictation that never composed anything may commit`() {
        assertEquals(
            FinalCommit.Action.COMMIT,
            FinalCommit.decide(regionGone = false, textBeforeCursor = "", composed = ""),
        )
    }

    private companion object {
        const val CHAT_APP = "com.example.chat"
        const val BANK_APP = "com.example.bank"
        const val FIELD_A = 7
        const val FIELD_B = 8
        const val OWNER = 41L
        const val OTHER = 42L
        const val NO_REGION = -1
        const val RAW = "meet at noon"
    }
}
