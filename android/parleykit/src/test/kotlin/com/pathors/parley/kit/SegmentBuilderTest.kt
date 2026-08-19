package com.pathors.parley.kit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Semantics ported from `src-tauri/src/transcription/common.rs::SegmentBuilder`
 * (via `SegmentBuilderTests.swift`). These tests are the contract: if they
 * diverge from the desktop's behavior, the two transcripts drift.
 */
class SegmentBuilderTest {
    private val emitted = mutableListOf<TranscriptSegment>()
    private lateinit var builder: SegmentBuilder

    @Before
    fun setUp() {
        emitted.clear()
        builder = SegmentBuilder("mix") { emitted.add(it) }
    }

    @Test
    fun growingRunReemitsUnderSameId() {
        builder.pushFinal("Hello", speaker = 1, startMs = 0, endMs = 400)
        builder.emitCommitted()
        builder.pushFinal(" world", speaker = 1, startMs = 400, endMs = 800)
        builder.emitCommitted()

        assertEquals(2, emitted.size)
        assertEquals("mix-0", emitted[0].id)
        assertEquals("growing run keeps the same id", "mix-0", emitted[1].id)
        assertEquals("Hello world", emitted[1].text)
        assertTrue(emitted[1].isFinal)
        assertEquals(0L, emitted[1].startMs)
        assertEquals(800L, emitted[1].endMs)
    }

    @Test
    fun speakerChangeCommitsAndStartsNewRun() {
        builder.pushFinal("Hi there.", speaker = 1, startMs = 0, endMs = 500)
        builder.pushFinal("Hello!", speaker = 2, startMs = 600, endMs = 900)
        builder.emitCommitted()

        // Speaker change commits run 0 solid, then the open run re-emits as mix-1.
        assertEquals(2, emitted.size)
        assertEquals("mix-0", emitted[0].id)
        assertEquals(1, emitted[0].speaker)
        assertEquals("Hi there.", emitted[0].text)
        assertEquals("mix-1", emitted[1].id)
        assertEquals(2, emitted[1].speaker)
        assertEquals("Hello!", emitted[1].text)
    }

    @Test
    fun speakerZeroNeverSplits() {
        // Non-diarizing input always reports 0 — one run forever.
        builder.pushFinal("a", speaker = 0, startMs = 0, endMs = 100)
        builder.pushFinal("b", speaker = 0, startMs = 100, endMs = 200)
        builder.emitCommitted()

        assertEquals(1, emitted.size)
        assertEquals("mix-0", emitted[0].id)
        assertEquals("ab", emitted[0].text)
    }

    @Test
    fun endpointCommitsResetsAndAdvancesIndex() {
        builder.pushFinal("First utterance.", speaker = 1, startMs = 0, endMs = 1000)
        builder.endpoint()
        builder.pushFinal("Second.", speaker = 1, startMs = 1200, endMs = 1500)
        builder.emitCommitted()

        assertEquals(2, emitted.size)
        assertEquals("mix-0", emitted[0].id)
        assertEquals("endpoint advances the index", "mix-1", emitted[1].id)
        assertEquals("new run gets a fresh start", 1200L, emitted[1].startMs)
    }

    @Test
    fun endpointOnEmptyRunIsNoop() {
        builder.endpoint()
        assertTrue(emitted.isEmpty())
        builder.pushFinal("x", speaker = 1, startMs = 0, endMs = 10)
        builder.emitCommitted()
        assertEquals("index did not advance on empty endpoint", "mix-0", emitted[0].id)
    }

    @Test
    fun whitespaceOnlyRunNeverCommits() {
        builder.pushFinal("  ", speaker = 1, startMs = 0, endMs = 100)
        builder.emitCommitted()
        builder.endpoint()
        assertTrue(emitted.isEmpty())
    }

    @Test
    fun tailUsesStableIdAndEmptyClears() {
        builder.emitTail("typing…", speaker = 2, startMs = 300)
        builder.emitTail("", speaker = 2, startMs = 300)

        assertEquals(2, emitted.size)
        assertEquals("mix-tail", emitted[0].id)
        assertFalse(emitted[0].isFinal)
        assertEquals("mix-tail", emitted[1].id)
        assertEquals("empty tail clears the UI row", "", emitted[1].text)
    }

    @Test
    fun currentSpeakerAndEndTrackOpenRun() {
        assertEquals(0, builder.currentSpeaker)
        builder.pushFinal("hey", speaker = 3, startMs = 50, endMs = 250)
        assertEquals(3, builder.currentSpeaker)
        assertEquals(250L, builder.currentEnd)
        builder.endpoint()
        assertEquals("reset after endpoint", 0, builder.currentSpeaker)
    }

    /**
     * A relay that has to be reopened mid-meeting restarts its own numbering
     * and its own clock at zero. Both are rebased so the second leg lands after
     * the first instead of on top of it.
     */
    @Test
    fun reconnectedLegKeepsItsOwnIdsAndRebasedTimestamps() {
        val second = mutableListOf<TranscriptSegment>()
        val leg = SegmentBuilder("mix", idPrefix = "mix@1", timeOffsetMs = 60_000) {
            second.add(it)
        }
        leg.pushFinal("Back again", speaker = 1, startMs = 0, endMs = 900)
        leg.emitCommitted()
        leg.emitTail("and still", speaker = 1, startMs = 900)

        assertEquals("must not collide with the first leg's mix-0", "mix@1-0", second[0].id)
        assertEquals("speaker labels still key off the source", "mix", second[0].source)
        assertEquals(60_000L, second[0].startMs)
        assertEquals(60_900L, second[0].endMs)
        // The tail id is the one thing that stays put: every `-tail` check in
        // the app and the cloud depends on this exact shape, and only one tail
        // is ever on screen.
        assertEquals("mix-tail", second[1].id)
        assertEquals(60_900L, second[1].startMs)
    }
}
