package com.pathors.parley.kit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The sign-in film's schedule — iOS `LapMotionTests`, number for number. */
class LapMotionTest {

    @Test
    fun `three clipped lines play in about seven seconds`() {
        val schedule = LapMotion.introBeats(listOf(34, 30, 34))
        assertEquals(7.0, schedule.end, 0.6)
    }

    @Test
    fun `beats are in order and lines do not overlap`() {
        val s = LapMotion.introBeats(listOf(20, 25, 10))
        assertTrue(s.recording < s.lines[0].start)
        s.lines.zipWithNext().forEach { (a, b) ->
            assertTrue("a name appears before the next line starts", a.name < b.start)
        }
        assertTrue(s.lines[2].typed < s.folder)
        assertTrue(s.folder < s.cardFly)
        assertTrue(s.cardFly < s.share)
        assertTrue(s.share < s.end)
    }

    @Test
    fun `typing is twenty-two milliseconds a character`() {
        val s = LapMotion.introBeats(listOf(10))
        val start = s.lines[0].start
        assertEquals(0, s.typedCount(0, start - 0.01))
        assertEquals(1, s.typedCount(0, start))
        assertEquals(5, s.typedCount(0, start + 0.022 * 4 + 0.001))
        assertEquals("never past the line", 10, s.typedCount(0, start + 10))
        assertEquals(start + 0.022 * 9, s.lines[0].typed, 1e-9)
        assertEquals(0, s.typedCount(3, 100.0))
    }

    @Test
    fun `the caption follows the beat`() {
        val s = LapMotion.introBeats(listOf(10, 10, 10))
        assertNull(s.beat(0.0))
        assertEquals(LapMotion.IntroBeat.RECORDING, s.beat(s.recording))
        assertEquals(LapMotion.IntroBeat.TRANSCRIPT, s.beat(s.lines[1].start))
        assertEquals(LapMotion.IntroBeat.FOLDER, s.beat(s.cardFly))
        assertEquals("it rests on the last beat", LapMotion.IntroBeat.SHARE, s.beat(s.end + 5))
    }

    @Test
    fun `no lines still makes a schedule`() {
        val s = LapMotion.introBeats(emptyList())
        assertTrue(s.lines.isEmpty())
        assertEquals(LapMotion.IntroBeat.RECORDING, s.beat(s.recording))
        assertTrue(s.recording < s.folder)
        assertFalse(s.nameShown(0, s.end))
    }

    @Test
    fun `names fade in once their line is typed`() {
        val s = LapMotion.introBeats(listOf(8, 8))
        assertFalse(s.nameShown(0, s.lines[0].typed))
        assertTrue(s.nameShown(0, s.lines[0].name))
        assertFalse(s.nameShown(1, s.lines[0].name))
    }

    @Test
    fun `the dot blinks while the film plays and rests lit`() {
        val s = LapMotion.introBeats(listOf(10))
        // Mid-way through each half, clear of floating-point edges.
        assertTrue(s.dotLit(s.recording + LapMotion.DOT_BLINK * 0.5))
        assertFalse(s.dotLit(s.recording + LapMotion.DOT_BLINK * 1.5))
        assertTrue(s.dotLit(s.recording + LapMotion.DOT_BLINK * 2.5))
        assertTrue(s.dotLit(s.end))
    }

    @Test
    fun `the folder flashes once, as the card lands`() {
        val s = LapMotion.introBeats(listOf(10))
        assertFalse(s.folderFlashing(s.folder))
        assertTrue(s.folderFlashing(s.cardFly))
        assertFalse(s.folderFlashing(s.cardFly + LapMotion.FOLDER_FLASH))
        assertFalse(s.folderFlashing(s.end))
    }

    @Test
    fun `the share mark fades in just before it lights`() {
        val s = LapMotion.introBeats(listOf(10))
        assertFalse(s.shareShown(s.cardFly))
        assertTrue(s.shareShown(s.share - LapMotion.SHARE_LEAD_IN))
        assertTrue(s.shareShown(s.end))
    }

    @Test
    fun `the spring matches SwiftUI's half-second response`() {
        // (2π / 0.5)² ≈ 157.9: between Compose's StiffnessVeryLow and StiffnessLow.
        assertEquals(157.91, LapMotion.springStiffness, 0.01)
    }

    @Test
    fun clipping() {
        assertEquals("林經理午安，謝謝您今天抽時間。", LapMotion.clip("林經理午安，謝謝您今天抽時間。我想先了解一下"))
        assertEquals("short", LapMotion.clip("short"))
        val long = "a".repeat(50)
        assertEquals("aaaaaaaaaa…", LapMotion.clip(long, limit = 10))
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
