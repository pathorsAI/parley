package com.pathors.parley.kit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The desktop's `fillerWords.test.ts` and the scorecard half of `delivery.test.ts`. */
class FillerWordsTest {

    private fun count(text: String) = FillerWords.countFillerSounds(text)

    @Test
    fun `counts English hesitations`() {
        assertEquals(2, count("um so uh yeah"))
        assertEquals(2, count("er, I mean, erm"))
        assertEquals(1, count("hmm let me think"))
    }

    @Test
    fun `collapses repeated runs to a single event`() {
        assertEquals(1, count("ummm"))
        assertEquals(1, count("嗯嗯嗯"))
        assertEquals(1, count("啊啊啊"))
    }

    @Test
    fun `counts unambiguous Mandarin hesitation characters`() {
        assertEquals(2, count("嗯我覺得呃這樣"))
        assertEquals(2, count("痾這個唔"))
    }

    @Test
    fun `counts code-switched fillers together`() {
        assertEquals(4, count("um 嗯 uh 呃"))
    }

    @Test
    fun `does not flag single ambiguous particles, only repeated runs`() {
        assertEquals(0, count("真的很好啊"))
        assertEquals(1, count("啊啊 怎麼會這樣"))
    }

    @Test
    fun `does not match hesitation letters inside real words`() {
        assertEquals(0, count("a human ahead, yeah, summary"))
    }

    @Test
    fun `a CJK character next to um is a word boundary, as in JavaScript`() {
        assertEquals(2, count("um嗯"))
    }

    @Test
    fun `returns 0 for empty or blank text`() {
        assertEquals(0, count(""))
        assertEquals(0, count("   "))
    }

    @Test
    fun `the watchlist puts the UI language first, without duplicates`() {
        val zh = FillerWords.watchlist(FilingLanguage.ZH_TW)
        val en = FillerWords.watchlist(FilingLanguage.EN)
        assertEquals("那個", zh.first())
        assertEquals("like", en.first())
        assertEquals(zh.toSet(), en.toSet())
        assertEquals(zh.size, zh.toSet().size)
    }

    // ── DeliveryStats ────────────────────────────────────────────────────────

    private fun seg(source: String, start: Long, end: Long, final: Boolean = true) =
        TranscriptSegment("$source-$start", source, 0, "x", final, start, end)

    @Test
    fun `talk time splits me against them by voiced duration`() {
        assertEquals(0.75, DeliveryStats.talkTimeRatio(listOf(seg("me", 0, 3000), seg("them", 3000, 4000)))!!, 1e-9)
    }

    @Test
    fun `talk time is null for a phone's mix, or with only one side heard`() {
        assertNull(DeliveryStats.talkTimeRatio(listOf(seg("mix", 0, 1000), seg("mix", 1000, 2000))))
        assertNull(DeliveryStats.talkTimeRatio(listOf(seg("me", 0, 3000), seg("me", 4000, 9000))))
        assertNull(DeliveryStats.talkTimeRatio(listOf(seg("them", 0, 3000))))
        assertNull(DeliveryStats.talkTimeRatio(emptyList()))
    }

    @Test
    fun `talk time ignores pending and zero-length segments`() {
        assertNull(DeliveryStats.talkTimeRatio(listOf(seg("me", 0, 3000), seg("them", 3000, 5000, final = false))))
        assertNull(DeliveryStats.talkTimeRatio(listOf(seg("me", 0, 3000), seg("them", 3000, 3000))))
        val r = DeliveryStats.talkTimeRatio(listOf(seg("mix", 0, 8000), seg("me", 0, 3000), seg("them", 3000, 4000)))
        assertEquals(0.75, r!!, 1e-9)
    }

    @Test
    fun `syllables per minute rounds`() {
        assertEquals(180L, DeliveryStats.syllablesPerMin(3.0))
    }

    @Test
    fun `filler sounds are counted on the user's own lines only`() {
        val segments = listOf(
            TranscriptSegment("me-0", "me", 0, "um 嗯", true, 0, 1000),
            TranscriptSegment("them-0", "them", 0, "uh", true, 1000, 2000),
            TranscriptSegment("mix-0", "mix", 1, "um", true, 2000, 3000),
        )
        assertEquals(2, DeliveryStats.fillerSounds(segments))
    }
}
