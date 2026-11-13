package com.pathors.parley.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The sign-in glow's state mapping and clock: what each phase asks for, and how the clock gets there. */
class AuroraMotionTest {

    private val second = 1_000_000_000L
    private val frame = second / 60

    @Test
    fun `the phase follows the page and the sign-in`() {
        assertEquals(AuroraPhase.IDLE, AuroraMotion.phaseFor(onSignInPage = true, signingIn = false))
        assertEquals(AuroraPhase.SIGNING_IN, AuroraMotion.phaseFor(onSignInPage = true, signingIn = true))
        // Off the page it leaves, whatever the sign-in flag still says.
        assertEquals(AuroraPhase.LEAVING, AuroraMotion.phaseFor(onSignInPage = false, signingIn = true))
        assertEquals(AuroraPhase.LEAVING, AuroraMotion.phaseFor(onSignInPage = false, signingIn = false))
    }

    @Test
    fun `signing in is brighter and quicker than idle`() {
        val idle = AuroraMotion.target(AuroraPhase.IDLE, appearing = false)
        val signingIn = AuroraMotion.target(AuroraPhase.SIGNING_IN, appearing = false)
        assertEquals(1f, idle.level, 0f)
        assertEquals(1f, idle.speed!!, 0f)
        assertEquals(1.45f, signingIn.level, 0f)
        assertEquals(2.6f, signingIn.speed!!, 0f)
        assertEquals(AuroraEdgeGlowTuning.STATE_EASE, idle.durationSeconds, 0.0)
        assertEquals(AuroraEdgeGlowTuning.STATE_EASE, signingIn.durationSeconds, 0.0)
    }

    @Test
    fun `the first ramp is the appear fade`() {
        val target = AuroraMotion.target(AuroraPhase.IDLE, appearing = true)
        assertEquals(AuroraEdgeGlowTuning.APPEAR_FADE, target.durationSeconds, 0.0)
    }

    @Test
    fun `leaving fades to nothing and leaves the current alone`() {
        val target = AuroraMotion.target(AuroraPhase.LEAVING, appearing = false)
        assertEquals(0f, target.level, 0f)
        assertNull(target.speed)
        assertEquals(AuroraEdgeGlowTuning.SUCCESS_FADE, target.durationSeconds, 0.0)
        assertTrue(AuroraEdgeGlowTuning.UNMOUNT_AFTER_MS > (AuroraEdgeGlowTuning.SUCCESS_FADE * 1000).toLong())
    }

    @Test
    fun `reduced motion steps the level instead of ramping`() {
        assertEquals(1f, AuroraMotion.reducedLevel(AuroraPhase.IDLE), 0f)
        assertEquals(1.2f, AuroraMotion.reducedLevel(AuroraPhase.SIGNING_IN), 0f)
    }

    @Test
    fun `the clock fades in from nothing to idle`() {
        val clock = AuroraClock()
        assertFalse(clock.started)
        clock.ramp(AuroraMotion.target(AuroraPhase.IDLE, appearing = true), 0L)
        assertTrue(clock.started)
        assertEquals(0f, clock.advance(0L).level, 0f)
        val halfway = clock.advance(second * 35 / 100).level
        assertEquals(0.5f, halfway, 0.001f)
        assertEquals(1f, clock.advance(second).level, 0f)
    }

    @Test
    fun `the flow clock is integrated so a change of speed does not jump it`() {
        val clock = AuroraClock()
        clock.ramp(AuroraTarget(1f, 1f, 0.0), 0L)
        var now = 0L
        clock.advance(now)
        repeat(60) { now += frame; clock.advance(now) }
        val before = clock.advance(now).t
        assertEquals(1.0, before, 0.001)

        // Snap to signing-in speed: the very next frame moves by one frame's worth, not by a leap.
        clock.ramp(AuroraTarget(1.45f, 2.6f, 0.0), now)
        now += frame
        val after = clock.advance(now).t
        assertEquals(2.6 / 60, after - before, 0.0001)
    }

    @Test
    fun `a long pause moves the flow by at most one capped step`() {
        val clock = AuroraClock()
        clock.ramp(AuroraTarget(1f, 1f, 0.0), 0L)
        clock.advance(0L)
        val t = clock.advance(30 * second).t
        assertEquals(1.0 / 15, t, 0.0001)
    }

    @Test
    fun `a ramp starts from wherever the glow is`() {
        val clock = AuroraClock()
        clock.ramp(AuroraTarget(1f, 1f, 1.0), 0L)
        val mid = clock.advance(second / 2).level
        clock.ramp(AuroraMotion.target(AuroraPhase.LEAVING, appearing = false), second / 2)
        assertEquals(mid, clock.advance(second / 2).level, 0.0001f)
        assertEquals(0f, clock.advance(second * 2).level, 0f)
    }

    @Test
    fun `the colour field closes at the top-left corner`() {
        for (t in listOf(0.0, 3.7, 12.0)) {
            assertEquals(AuroraField.colour(0.0, t), AuroraField.colour(0.999999, t), 0.001)
        }
    }

    @Test
    fun `the fields stay in their ranges`() {
        var u = 0.0
        while (u < 1.0) {
            val i = AuroraField.intensity(u, 5.0)
            assertTrue(i in 0.05..1.05)
            assertTrue(AuroraField.colour(u, 5.0) in 0.0..1.0)
            assertTrue(AuroraField.glint(u, 5.0) >= 0.0)
            u += 0.01
        }
    }
}
