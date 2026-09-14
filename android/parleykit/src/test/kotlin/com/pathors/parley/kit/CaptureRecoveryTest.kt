package com.pathors.parley.kit

import com.pathors.parley.kit.CaptureRecovery.Action
import com.pathors.parley.kit.CaptureRecovery.Event
import com.pathors.parley.kit.CaptureRecovery.Loss
import com.pathors.parley.kit.CaptureRecovery.Phase
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The port of `ios/ParleyKit/Tests/ParleyKitTests/CaptureRecoveryTests.swift`,
 * case for case, plus the two situations Android has and iOS does not.
 *
 * The sequences these cover take a real phone, a real interruption and a minute
 * of waiting to produce once. They are six lines here.
 */
class CaptureRecoveryTest {

    // ── the reported bug, end to end ────────────────────────────────────────

    /**
     * The failure this file exists for: Parley is recording, something with a
     * higher claim takes the microphone, and every attempt to take it back is
     * refused for as long as that other thing is running.
     *
     * The ladder runs out, and the only honest thing left is to say so. The
     * capture that shipped went quiet instead — and, before the durability
     * wave, deleted the meeting on its way out.
     */
    @Test
    fun `a microphone held by another app ends with the user being told`() {
        val recovery = CaptureRecovery()

        assertEquals(Action.Rebuild(recovery.probeAfterMillis), recovery.apply(Event.Interrupted))
        assertEquals(
            Action.Rebuild(recovery.resumeAfterMillis),
            recovery.apply(Event.InterruptionEnded),
        )

        val actions = mutableListOf<Action>()
        while (actions.lastOrNull() !is Action.GiveUp) {
            actions += recovery.apply(REFUSED_BUSY)
            assertTrue("the ladder has to end", actions.size < 50)
        }

        assertEquals(Action.GiveUp(Loss.TakenBySystem), actions.last())
        assertEquals(recovery.maxAttempts, actions.size)
        assertTrue(recovery.hasGivenUp)
        assertFalse(recovery.holdsMicrophone)
    }

    /**
     * …and the microphone is not gone for good. Giving up is a state that still
     * answers the events which change the answer, which is exactly what a
     * boolean flag could not do: the moment that would have worked arrived and
     * reached nothing.
     */
    @Test
    fun `giving up stays armed for the app coming forward`() {
        val recovery = givenUp()

        assertEquals(Action.Rebuild(0), recovery.apply(Event.AppBecameActive))
        assertFalse(recovery.hasGivenUp)
        assertEquals(Action.Wait, recovery.apply(Event.RebuildSucceeded()))
        assertTrue(recovery.holdsMicrophone)
    }

    /**
     * `ERROR_DEAD_OBJECT` means the audio server restarted, which killed the
     * `AudioRecord` the *other* client was holding as surely as it killed ours.
     * One of the two events worth trying again after having given up.
     */
    @Test
    fun `giving up stays armed for the audio server restarting`() {
        val recovery = givenUp()

        assertEquals(
            Action.Rebuild(recovery.resumeAfterMillis),
            recovery.apply(Event.AudioServerDied),
        )
        assertFalse(recovery.hasGivenUp)
    }

    /**
     * A late "the interruption is over" is the best reason there has ever been
     * to try again, even after the ladder has been spent.
     */
    @Test
    fun `giving up stays armed for a late interruption end`() {
        val recovery = givenUp()

        assertEquals(
            Action.Rebuild(recovery.resumeAfterMillis),
            recovery.apply(Event.InterruptionEnded),
        )
        assertEquals(0, recovery.attempts)
    }

    // ── the interruption that never announces its end ───────────────────────

    /**
     * `isClientSilenced` can go true and never come back: the other client let
     * go without the framework re-running our callback. The probe scheduled by
     * the interruption itself is the only thing that can notice, which is why
     * an interruption schedules one instead of settling down to wait.
     */
    @Test
    fun `an interruption with no end is still probed`() {
        val recovery = CaptureRecovery()

        assertEquals(Action.Rebuild(recovery.probeAfterMillis), recovery.apply(Event.Interrupted))
        assertEquals(Phase.INTERRUPTED, recovery.phase)

        // The other client let go without saying so: a probe simply works.
        assertEquals(Action.Wait, recovery.apply(Event.RebuildSucceeded()))
        assertTrue(recovery.holdsMicrophone)
    }

    /**
     * A second interruption for one already being probed says nothing new, and
     * answering it would put a second rebuild chain on the same `AudioRecord` —
     * two threads racing to open the microphone, which is its own outage.
     */
    @Test
    fun `repeated interruptions do not stack chains`() {
        val recovery = CaptureRecovery()

        assertEquals(Action.Rebuild(recovery.probeAfterMillis), recovery.apply(Event.Interrupted))
        assertEquals(Action.Wait, recovery.apply(Event.Interrupted))
        assertEquals(Action.Wait, recovery.apply(Event.Interrupted))
    }

    // ── the ladder ──────────────────────────────────────────────────────────

    @Test
    fun `backoff doubles from the first step and caps`() {
        val recovery = CaptureRecovery(firstBackoffMillis = 250, backoffCapMillis = 4_000)

        assertEquals(
            listOf(250L, 500L, 1_000L, 2_000L, 4_000L, 4_000L, 4_000L),
            (1..7).map(recovery::backoffFor),
        )
        // Never asked to wait negatively, whatever it is handed.
        assertEquals(250L, recovery.backoffFor(0))
        assertEquals(250L, recovery.backoffFor(-3))
    }

    /**
     * A ladder that runs out in ten seconds outlasts a route change settling
     * down, not a person answering a call. The point of this one is that the
     * ladder outlasts the interruption it exists for — and is still bounded,
     * because a capture that claims to be recovering for minutes is the silent
     * failure this whole file is here to avoid.
     */
    @Test
    fun `the ladder outlasts an interruption rather than a route change`() {
        val recovery = CaptureRecovery()

        assertTrue(recovery.ladderMillis > 25_000)
        assertTrue(recovery.ladderMillis < 60_000)
    }

    @Test
    fun `each failure climbs one rung and a success resets the climb`() {
        val recovery = CaptureRecovery()
        recovery.apply(Event.InterruptionEnded)

        assertEquals(Action.Rebuild(250), recovery.apply(REFUSED_BUSY))
        assertEquals(Action.Rebuild(500), recovery.apply(REFUSED_BUSY))
        assertEquals(Action.Rebuild(1_000), recovery.apply(REFUSED_BUSY))
        assertEquals(3, recovery.attempts)

        assertEquals(Action.Wait, recovery.apply(Event.RebuildSucceeded()))
        assertEquals(0, recovery.attempts)

        // A fresh interruption starts from the bottom of the ladder, not from
        // wherever the last one got to.
        recovery.apply(Event.InterruptionEnded)
        assertEquals(Action.Rebuild(250), recovery.apply(REFUSED_BUSY))
    }

    /**
     * Capture stopping for a reason of ours — the route moved, the watchdog
     * noticed chunks had stopped arriving — is not something to wait for.
     * Nobody is holding the microphone.
     */
    @Test
    fun `capture that simply stopped is rebuilt at once`() {
        val recovery = CaptureRecovery()

        assertEquals(Action.Rebuild(0), recovery.apply(Event.CaptureStopped))
    }

    // ── what the user is told ───────────────────────────────────────────────

    /**
     * The two losses are different pieces of advice. "Somebody else has the
     * microphone" is fixed by ending the call or coming back to Parley, which
     * is what the banner offers; a device with no working audio input is not
     * fixed by tapping anything, so it gets named instead.
     */
    @Test
    fun `a broken audio stack is named rather than offered a retry`() {
        val recovery = CaptureRecovery(maxAttempts = 2)
        recovery.apply(Event.CaptureStopped)

        assertEquals(
            Action.Rebuild(recovery.firstBackoffMillis),
            recovery.apply(Event.RebuildFailed(systemHoldsInput = false, description = "no 16 kHz")),
        )
        assertEquals(
            Action.GiveUp(Loss.Broken("no 16 kHz")),
            recovery.apply(Event.RebuildFailed(systemHoldsInput = false, description = "no 16 kHz")),
        )
    }

    /**
     * A chain that began with the system taking the microphone is reported as
     * exactly that, even when the last failure on the way down was something
     * else. A probe attempted while another app holds the input can surface as
     * an unsupported-configuration failure, and the user needs to be told what
     * happened rather than the last thing that went wrong.
     */
    @Test
    fun `an interrupted chain is reported as taken even if the last error is not`() {
        val recovery = CaptureRecovery(maxAttempts = 2)
        recovery.apply(Event.Interrupted)

        recovery.apply(Event.RebuildFailed(systemHoldsInput = true, description = "state=0"))
        assertEquals(
            Action.GiveUp(Loss.TakenBySystem),
            recovery.apply(
                Event.RebuildFailed(systemHoldsInput = false, description = "no configuration"),
            ),
        )
    }

    /**
     * One give-up per chain. A straggler from the chain that gave up is not a
     * reason to tell the user twice — and on the session side a second telling
     * would be a second wind-down of a recording already being saved.
     */
    @Test
    fun `a straggler failure after giving up changes nothing`() {
        val recovery = givenUp()

        assertEquals(Action.Wait, recovery.apply(REFUSED_BUSY))
        assertTrue(recovery.hasGivenUp)
    }

    // ── a fresh start ───────────────────────────────────────────────────────

    /**
     * The user tapped record. Nothing this policy was remembering belongs to
     * the capture being replaced.
     */
    @Test
    fun `restarting forgets everything`() {
        val recovery = givenUp()

        assertEquals(Action.Wait, recovery.apply(Event.Restarted))
        assertTrue(recovery.holdsMicrophone)
        assertFalse(recovery.hasGivenUp)
        assertEquals(0, recovery.attempts)

        // And the fresh capture's first failure is reported on its own terms,
        // not inheriting the last one's story.
        recovery.apply(Event.CaptureStopped)
        assertEquals(
            Action.Rebuild(recovery.firstBackoffMillis),
            recovery.apply(Event.RebuildFailed(systemHoldsInput = false, description = "no 16 kHz")),
        )
    }

    /** A healthy capture is not woken up by events it has nothing to do with. */
    @Test
    fun `the app coming forward does nothing while the microphone is ours`() {
        val recovery = CaptureRecovery()

        assertEquals(Action.Wait, recovery.apply(Event.AppBecameActive))
        assertTrue(recovery.holdsMicrophone)
    }

    // ── Android's own two ───────────────────────────────────────────────────

    /**
     * Android-only, and the reason `isRecovering` exists at all.
     *
     * The watchdog fires every two seconds and "no chunks are arriving" is true
     * for the whole of a recovery, so a watchdog allowed to speak during one
     * would reset the ladder on every tick and the chain would never reach its
     * end. Same for a route change landing mid-climb. This asserts that the two
     * phases a chain can be in both report themselves as busy, and that the
     * other two do not.
     */
    @Test
    fun `a chain in progress reports itself busy so the watchdog stays quiet`() {
        val recovery = CaptureRecovery()
        assertFalse("a healthy capture is not recovering", recovery.isRecovering)

        recovery.apply(Event.Interrupted)
        assertTrue("an interruption is a chain in progress", recovery.isRecovering)

        recovery.apply(REFUSED_BUSY)
        assertEquals(Phase.RECOVERING, recovery.phase)
        assertTrue(recovery.isRecovering)

        recovery.apply(Event.RebuildSucceeded())
        assertFalse(recovery.isRecovering)

        // And a capture that has given up is not "recovering" either: the
        // ladder had its turn, so the watchdog is free to stay quiet for a
        // different reason — there is nothing left for it to trigger.
        val lost = givenUp()
        assertFalse(lost.isRecovering)
        assertTrue(lost.hasGivenUp)
    }

    /**
     * Android-only: a configuration this policy cannot honour must be rejected
     * at construction rather than producing a ladder that silently never ends
     * (`maxAttempts` of zero) or a negative delay.
     */
    @Test
    fun `a nonsensical configuration is refused at construction`() {
        assertThrows { CaptureRecovery(maxAttempts = 0) }
        assertThrows { CaptureRecovery(firstBackoffMillis = 0) }
        assertThrows { CaptureRecovery(firstBackoffMillis = 4_000, backoffCapMillis = 250) }
        assertThrows { CaptureRecovery(probeAfterMillis = -1) }
        assertThrows { CaptureRecovery(resumeAfterMillis = -1) }

        // A single-attempt ladder is legal and spends no time at all before
        // telling the user, which is what a caller asking for one means.
        assertEquals(0L, CaptureRecovery(maxAttempts = 1).ladderMillis)
        assertNotEquals(0L, CaptureRecovery().ladderMillis)
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    private fun givenUp(): CaptureRecovery {
        val recovery = CaptureRecovery()
        recovery.apply(Event.Interrupted)
        recovery.apply(Event.InterruptionEnded)
        while (!recovery.hasGivenUp) {
            recovery.apply(REFUSED_BUSY)
        }
        return recovery
    }

    private fun assertThrows(block: () -> Unit) {
        try {
            block()
        } catch (e: IllegalArgumentException) {
            return
        }
        throw AssertionError("expected an IllegalArgumentException")
    }

    private companion object {
        /**
         * The failure the bug is made of: `AudioRecord` refusing to open or to
         * start because another client holds the microphone.
         */
        val REFUSED_BUSY = Event.RebuildFailed(
            systemHoldsInput = true,
            description = "microphone is busy (recordingState=1)",
        )
    }
}
