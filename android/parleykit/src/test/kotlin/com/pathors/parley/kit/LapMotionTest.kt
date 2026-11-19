package com.pathors.parley.kit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The lap's motion constants and the welcome demo's schedule — iOS `LapMotionTests`. */
class LapMotionTest {

    @Test
    fun `the spring matches SwiftUI's half-second response`() {
        // (2π / 0.5)² ≈ 157.9: between Compose's StiffnessVeryLow and StiffnessLow.
        assertEquals(157.91, LapMotion.springStiffness, 0.01)
    }

    @Test
    fun typing() {
        assertEquals("abc", LapMotion.typed("abcdef", 3))
        assertEquals("", LapMotion.typed("abc", -1))
    }

    // ── the welcome demo — iOS `LapMotionTests`, number for number ─────────────

    @Test
    fun `welcome beats match the desktop and rest at eleven`() {
        val s = LapMotion.WelcomeSchedule(listOf(15, 18))
        assertEquals(LapMotion.WelcomeBeat.OVERVIEW, s.beat(0.0))
        assertEquals(LapMotion.WelcomeBeat.OVERVIEW, s.beat(1.79))
        assertEquals(LapMotion.WelcomeBeat.RECORD, s.beat(1.8))
        assertEquals(LapMotion.WelcomeBeat.TRANSCRIPT, s.beat(3.4))
        assertEquals(LapMotion.WelcomeBeat.FOLDER, s.beat(6.4))
        assertEquals(LapMotion.WelcomeBeat.MCP, s.beat(8.3))
        assertEquals(LapMotion.WelcomeBeat.READY, s.beat(11.0))
        assertEquals("it rests on the final frame", LapMotion.WelcomeBeat.READY, s.beat(60.0))
        assertEquals(11.0, s.end, 0.0)
        assertEquals(
            listOf(
                LapMotion.WelcomeBeat.RECORD,
                LapMotion.WelcomeBeat.TRANSCRIPT,
                LapMotion.WelcomeBeat.FOLDER,
                LapMotion.WelcomeBeat.MCP,
            ),
            LapMotion.WelcomeBeat.STEPS,
        )
    }

    @Test
    fun `a step's bar fills over its own length`() {
        val s = LapMotion.WelcomeSchedule(listOf(10))
        assertEquals(0.0, s.fill(LapMotion.WelcomeBeat.RECORD, 1.0), 0.0)
        assertEquals(0.5, s.fill(LapMotion.WelcomeBeat.RECORD, 2.6), 1e-9)
        assertEquals(1.0, s.fill(LapMotion.WelcomeBeat.RECORD, 3.4), 0.0)
        assertEquals(0.5, s.fill(LapMotion.WelcomeBeat.MCP, 9.65), 1e-9)
        assertEquals(1.0, s.fill(LapMotion.WelcomeBeat.MCP, 30.0), 0.0)
    }

    @Test
    fun `short welcome lines type at twenty-two milliseconds a character`() {
        val s = LapMotion.WelcomeSchedule(listOf(10, 10))
        assertEquals(0.022, s.secondsPerCharacter, 1e-9)
        assertEquals(3.4, s.lineStarts[0], 1e-9)
        assertEquals(3.4 + 10 * 0.022 + 0.24, s.lineStarts[1], 1e-9)
        assertEquals(0, s.typedCount(0, 3.4))
        assertEquals(5, s.typedCount(0, 3.4 + 0.022 * 5 + 0.001))
        assertEquals("never past the line", 10, s.typedCount(0, 100.0))
        assertFalse(s.lineDone(1, s.lineStarts[1] + 0.1))
        assertTrue(s.lineDone(1, 6.0))
        assertEquals(0, s.typedCount(2, 100.0))
    }

    @Test
    fun `long welcome lines type faster to fit the budget`() {
        val s = LapMotion.WelcomeSchedule(listOf(120, 120))
        assertTrue(s.secondsPerCharacter < 0.022)
        val lastDone = s.lineStarts[1] + 120 * s.secondsPerCharacter
        assertEquals(3.4 + LapMotion.WelcomeSchedule.TRANSCRIPT_BUDGET, lastDone, 1e-9)
        assertTrue(lastDone < LapMotion.WelcomeSchedule.start(LapMotion.WelcomeBeat.FOLDER))
    }

    @Test
    fun `the card shows, flies and is filed inside the folder beat`() {
        val s = LapMotion.WelcomeSchedule(listOf(10))
        assertEquals(LapMotion.WelcomeSchedule.Card.HIDDEN, s.card(6.5))
        assertEquals(LapMotion.WelcomeSchedule.Card.SHOWN, s.card(6.4 + 0.3))
        assertEquals(LapMotion.WelcomeSchedule.Card.FLYING, s.card(6.4 + 0.8))
        assertEquals(LapMotion.WelcomeSchedule.Card.FILED, s.card(6.4 + 1.7))
        assertTrue(
            "filed before the MCP beat",
            6.4 + 0.75 + 0.9 < LapMotion.WelcomeSchedule.start(LapMotion.WelcomeBeat.MCP),
        )
        assertTrue(s.folderFlashing(6.4 + 1.7))
        assertFalse(s.folderFlashing(6.4 + 2.2))
    }

    @Test
    fun `the plug lights and the report fills in during the MCP beat`() {
        val s = LapMotion.WelcomeSchedule(listOf(10))
        assertFalse(s.plugLit(8.5))
        assertTrue(s.plugLit(8.61))
        assertEquals(0, s.reportLines(4, 8.6))
        assertEquals(1, s.reportLines(4, 8.66))
        assertEquals(2, s.reportLines(4, 8.96))
        assertEquals("all in by the rest frame", 4, s.reportLines(4, 11.0))
        assertEquals(8.95, s.reportLineStart(1), 1e-9)
    }

    @Test
    fun `the overview row lands step by step`() {
        assertEquals(0.0, LapMotion.WelcomeSchedule.overviewLanding(0), 0.0)
        assertEquals(0.27, LapMotion.WelcomeSchedule.overviewLanding(2), 1e-9)
    }
}
