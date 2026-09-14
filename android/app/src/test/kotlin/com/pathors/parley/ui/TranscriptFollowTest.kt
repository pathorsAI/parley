package com.pathors.parley.ui

import com.pathors.parley.cloud.TranscriptSegmentDto
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The two pure functions behind follow-the-audio.
 *
 * Both are arithmetic that is invisible until it is wrong: an off-by-one in
 * [firstSegmentItemIndex] scrolls the transcript to a findings card, and a
 * range-based [currentTurnIndex] would drop the highlight into nowhere every
 * time two people paused between turns.
 */
class TranscriptFollowTest {

    private fun turns(vararg startMs: Long): List<TranscriptSegmentDto> =
        startMs.mapIndexed { index, start ->
            TranscriptSegmentDto(
                id = "mix-$index",
                text = "turn $index",
                startMs = start,
                // Ends well before the next one starts: the gaps are the point.
                endMs = start + 4_000,
            )
        }

    @Test
    fun `before the first turn nothing is current`() {
        assertEquals(-1, currentTurnIndex(turns(9_000, 31_000), positionMs = 0))
        assertEquals(-1, currentTurnIndex(turns(9_000, 31_000), positionMs = 8_999))
    }

    @Test
    fun `a turn becomes current the instant it starts`() {
        val segments = turns(9_000, 31_000, 52_000)
        assertEquals(0, currentTurnIndex(segments, 9_000))
        assertEquals(1, currentTurnIndex(segments, 31_000))
        assertEquals(2, currentTurnIndex(segments, 52_000))
    }

    @Test
    fun `a pause between turns keeps the turn that was just spoken`() {
        // 20 s is inside neither turn's startMs…endMs range. The reader's eye
        // is on the one that just finished, so it keeps the mark.
        assertEquals(0, currentTurnIndex(turns(9_000, 31_000), positionMs = 20_000))
    }

    @Test
    fun `past the last turn the last turn stays current`() {
        assertEquals(1, currentTurnIndex(turns(9_000, 31_000), positionMs = 9_999_999))
    }

    @Test
    fun `an empty transcript has no current turn`() {
        assertEquals(-1, currentTurnIndex(emptyList(), positionMs = 1_000))
    }

    @Test
    fun `a transcript starting at zero is current from the first frame`() {
        assertEquals(0, currentTurnIndex(turns(0, 5_000), positionMs = 0))
    }

    @Test
    fun `the plain case is header, title, then the turns`() {
        // 0 header, 1 "Transcript", 2 first turn.
        assertEquals(2, firstSegmentItemIndex(findings = 0, actionItems = 0, hasSegments = true))
    }

    @Test
    fun `each analysis section costs its title plus its rows`() {
        // 0 header, 1 "Findings", 2-4 cards, 5 "Action items", 6-7 cards,
        // 8 "Transcript", 9 first turn.
        assertEquals(9, firstSegmentItemIndex(findings = 3, actionItems = 2, hasSegments = true))
    }

    @Test
    fun `an empty analysis section takes no room at all`() {
        assertEquals(4, firstSegmentItemIndex(findings = 1, actionItems = 0, hasSegments = true))
        assertEquals(4, firstSegmentItemIndex(findings = 0, actionItems = 1, hasSegments = true))
    }

    @Test
    fun `the no-transcript line sits where the first turn would`() {
        assertEquals(3, firstSegmentItemIndex(findings = 0, actionItems = 0, hasSegments = false))
    }

    @Test
    fun `the index matches a hand-counted demo recording`() {
        // The featured demo meeting: three findings, two action items, six
        // turns. Item 9 is the first thing the follow ever scrolls to, and
        // getting it wrong parks the reader on an action-item card.
        assertEquals(9, firstSegmentItemIndex(findings = 3, actionItems = 2, hasSegments = true))
    }
}
