package com.pathors.parley.ui

import com.pathors.parley.cloud.TranscriptSegmentDto
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The pure rules behind the recording page: which turn the playhead is in,
 * which turn a finding's 💡 line goes under, and which page a recording opens
 * on.
 *
 * All three are invisible until they are wrong: a range-based
 * [currentTurnIndex] would drop the highlight into nowhere every time two people
 * paused between turns, a finding filed under the wrong turn points at somebody
 * else's sentence, and a page that flips on reload moves the reader's place.
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

    // ── the 💡 lines ─────────────────────────────────────────────────────────

    private fun finding(title: String, atMs: Long) =
        FindingRow(id = title, title = title, detail = "", atMs = atMs, severity = null)

    @Test
    fun `a finding goes under the turn it starts in`() {
        val starts = listOf(300L, 8_900L, 18_076L)
        val byTurn = findingsByTurn(
            listOf(finding("a", 12_000), finding("b", 20_000), finding("c", 13_000)),
            starts,
        )
        assertEquals(listOf("a", "c"), byTurn[1]?.map { it.title })
        assertEquals(listOf("b"), byTurn[2]?.map { it.title })
        assertEquals(null, byTurn[0])
    }

    @Test
    fun `a floored moment goes under the turn it names, not the one before`() {
        // The analysis floors 8.9 s to 8 s on the way to a clock.
        assertEquals(listOf("x"), findingsByTurn(listOf(finding("x", 8_000)), listOf(300L, 8_900L))[1]?.map { it.title })
    }

    @Test
    fun `a finding before every turn belongs to the first, and no turns means no lines`() {
        assertEquals(listOf("early"), findingsByTurn(listOf(finding("early", 0)), listOf(5_000L))[0]?.map { it.title })
        assertEquals(emptyMap<Int, List<FindingRow>>(), findingsByTurn(listOf(finding("x", 0)), emptyList()))
    }

    // ── the page it opens on ─────────────────────────────────────────────────

    @Test
    fun `a recording with analysis opens on its report, one without on its transcript`() {
        assertEquals(DetailFace.REPORT, initialFace(hasAnalysis = true))
        assertEquals(DetailFace.TRANSCRIPT, initialFace(hasAnalysis = false))
    }

    @Test
    fun `the store-listing transcript frame stays on the transcript`() {
        assertEquals(DetailFace.TRANSCRIPT, initialFace(hasAnalysis = true, forceTranscript = true))
    }
}
