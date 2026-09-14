package com.pathors.parley.kit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the in-transcript search promises. The UI on top is highlights and a
 * chevron; these are the parts that are a contract — which ranges match, in
 * what order, and what happens when the query is not really a query.
 *
 * Ported from `ios/ParleyKit/Tests/ParleyKitTests/TranscriptSearchTests.swift`
 * case for case, so a change that makes one phone find something the other does
 * not fails here first.
 */
class TranscriptSearchTest {

    private fun seg(id: String, text: String, isFinal: Boolean = true) = TranscriptSegment(
        id = id,
        source = "mix",
        speaker = 1,
        text = text,
        isFinal = isFinal,
        startMs = 0,
        endMs = 1_000,
    )

    /**
     * The substring a hit actually covers, read back out of the segment it
     * belongs to — which is the only way the offsets mean anything.
     */
    private fun matched(hit: TranscriptSearch.Hit, segments: List<TranscriptSegment>): String {
        val segment = segments.firstOrNull { it.id == hit.segmentId } ?: return "<no such segment>"
        return hit.matchedIn(segment.text)
    }

    // ── case folding ─────────────────────────────────────────────────────────

    @Test
    fun `matches regardless of case`() {
        val segments = listOf(seg("a", "Two weeks assumes your SSO is already on Okta."))

        for (query in listOf("okta", "OKTA", "Okta", "oKtA")) {
            val hits = TranscriptSearch.hits(segments, query)
            assertEquals("query $query", 1, hits.size)
            assertEquals("Okta", matched(hits[0], segments))
        }
    }

    /**
     * The offsets come back pointing at the text as written, not as searched —
     * what gets highlighted is the transcript's own capitalisation.
     */
    @Test
    fun `the matched range keeps the original spelling`() {
        val segments = listOf(seg("a", "Forty is the FLOOR on the enterprise tier."))

        val hits = TranscriptSearch.hits(segments, "floor")

        assertEquals("FLOOR", matched(hits[0], segments))
    }

    // ── diacritics ───────────────────────────────────────────────────────────

    @Test
    fun `matches across diacritics`() {
        val segments = listOf(seg("a", "We met at the café on Wednesday."))

        assertEquals(1, TranscriptSearch.hits(segments, "cafe").size)
        assertEquals(1, TranscriptSearch.hits(segments, "café").size)
    }

    /**
     * Folding both ways at once: an unaccented query against accented text and
     * the reverse, with the case fold on top.
     */
    @Test
    fun `diacritic and case fold together`() {
        val segments = listOf(seg("a", "Renée signed the order form."))

        val hits = TranscriptSearch.hits(segments, "RENEE")

        assertEquals(1, hits.size)
        assertEquals("Renée", matched(hits[0], segments))
    }

    /**
     * The same word written decomposed — "e" plus a combining acute — is the
     * same word. The highlight has to cover the mark too, or the accent is left
     * sitting outside the tint.
     */
    @Test
    fun `matches text that arrived decomposed`() {
        val decomposed = "We met at the café on Wednesday."
        val segments = listOf(seg("a", decomposed))

        val hits = TranscriptSearch.hits(segments, "café")

        assertEquals(1, hits.size)
        assertEquals("café", matched(hits[0], segments))
    }

    // ── zh-Hant ──────────────────────────────────────────────────────────────

    /**
     * The reason this is a substring search and not a tokeniser: Chinese has
     * no spaces, so 「續約」 has to be findable inside 「下一次續約」 without
     * anything having been taught where the word boundaries are.
     */
    @Test
    fun `finds a Chinese substring with no word boundaries`() {
        val segments = listOf(
            seg("a", "四十席是企業版的最低門檻，我沒辦法再往下。"),
            seg("b", "我能做的是把今年的價格鎖到下一次續約。"),
        )

        val hits = TranscriptSearch.hits(segments, "續約")

        assertEquals(1, hits.size)
        assertEquals("b", hits[0].segmentId)
        assertEquals("續約", matched(hits[0], segments))
    }

    @Test
    fun `finds a longer Chinese phrase`() {
        val segments = listOf(seg("a", "兩週的前提是你們的 SSO 已經在 Okta 上。"))

        val hits = TranscriptSearch.hits(segments, "前提")

        assertEquals(1, hits.size)
        assertEquals("前提", matched(hits[0], segments))
    }

    // ── several hits ─────────────────────────────────────────────────────────

    @Test
    fun `finds every occurrence in one segment`() {
        val segments = listOf(seg("a", "Forty seats, forty seats, and forty again."))

        val hits = TranscriptSearch.hits(segments, "forty")

        assertEquals(3, hits.size)
        assertEquals(listOf("a", "a", "a"), hits.map { it.segmentId })
        // In order, and not overlapping: each range starts after the last ended.
        assertTrue(hits[0].endExclusive <= hits[1].start)
        assertTrue(hits[1].endExclusive <= hits[2].start)
        assertEquals("Forty", matched(hits[0], segments))
        assertEquals("forty", matched(hits[2], segments))
    }

    /**
     * Document order across segments, because "n of N" and the next/previous
     * chevrons walk this list and have to walk it down the page.
     */
    @Test
    fun `hits come back in document order`() {
        val segments = listOf(
            seg("a", "The price hold is the lever."),
            seg("b", "A price hold helps."),
            seg("c", "Nothing relevant here."),
            seg("d", "Put the price hold in writing."),
        )

        val hits = TranscriptSearch.hits(segments, "price hold")

        assertEquals(listOf("a", "b", "d"), hits.map { it.segmentId })
    }

    // ── the empty query ──────────────────────────────────────────────────────

    @Test
    fun `empty query matches nothing`() {
        val segments = listOf(seg("a", "Anything at all."))

        assertEquals(emptyList<TranscriptSearch.Hit>(), TranscriptSearch.hits(segments, ""))
    }

    /**
     * A field holding only spaces is a field nobody has typed in yet. Matching
     * every space in the transcript would light the whole column up.
     */
    @Test
    fun `whitespace-only query matches nothing`() {
        val segments = listOf(seg("a", "Anything at all."))

        assertEquals(emptyList<TranscriptSearch.Hit>(), TranscriptSearch.hits(segments, "   "))
        assertEquals(emptyList<TranscriptSearch.Hit>(), TranscriptSearch.hits(segments, "\n\t "))
    }

    /**
     * A query that is nothing but a combining mark folds away to nothing, which
     * is the same state as an empty field — and, unguarded, an empty needle that
     * matches at every position forever.
     */
    @Test
    fun `a query that folds away to nothing matches nothing`() {
        val segments = listOf(seg("a", "Renée signed the order form."))

        assertEquals(emptyList<TranscriptSearch.Hit>(), TranscriptSearch.hits(segments, "́"))
    }

    /**
     * Surrounding whitespace is trimmed, so a stray trailing space from a
     * keyboard's autospacing does not lose a hit the reader can see.
     */
    @Test
    fun `query is trimmed`() {
        val segments = listOf(seg("a", "Send the revised quote."))

        val hits = TranscriptSearch.hits(segments, "  quote  ")

        assertEquals(1, hits.size)
        assertEquals("quote", matched(hits[0], segments))
    }

    // ── no hits ──────────────────────────────────────────────────────────────

    @Test
    fun `no hits is an empty list`() {
        val segments = listOf(
            seg("a", "Forty is the floor on the enterprise tier."),
            seg("b", "四十席是企業版的最低門檻。"),
        )

        assertEquals(emptyList<TranscriptSearch.Hit>(), TranscriptSearch.hits(segments, "Okta"))
        assertEquals(emptyList<TranscriptSearch.Hit>(), TranscriptSearch.hits(segments, "續約"))
    }

    @Test
    fun `empty transcript matches nothing`() {
        assertEquals(
            emptyList<TranscriptSearch.Hit>(),
            TranscriptSearch.hits(emptyList(), "anything"),
        )
    }

    // ── what is not searched ─────────────────────────────────────────────────

    /**
     * The tentative tail never reaches the detail screen, so a hit inside it
     * would be a hit the reader cannot be scrolled to.
     */
    @Test
    fun `skips segments that are not final`() {
        val segments = listOf(
            seg("committed", "The price hold is in the quote."),
            seg("tail", "The price hold is", isFinal = false),
        )

        val hits = TranscriptSearch.hits(segments, "price hold")

        assertEquals(listOf("committed"), hits.map { it.segmentId })
    }

    // ── offsets survive the JVM's own string units ───────────────────────────

    /**
     * Offsets are UTF-16 indices because that is what `substring` and Compose's
     * `AnnotatedString` both take. An emoji earlier in the turn is two of those
     * per character, and a fold that counted code points instead would slide
     * every highlight after it one place left.
     */
    @Test
    fun `offsets are correct after a surrogate pair`() {
        val text = "🚀 shipping the price hold"
        val segments = listOf(seg("a", text))

        val hits = TranscriptSearch.hits(segments, "price hold")

        assertEquals(1, hits.size)
        assertEquals("price hold", text.substring(hits[0].start, hits[0].endExclusive))
    }

    // ── the same fold, used by the library ───────────────────────────────────

    /**
     * [TranscriptSearch.matches] is what the library filters titles and snippets
     * with, and it has to fold exactly as the transcript search does — a
     * recording that can be found from inside must be findable from the list.
     */
    @Test
    fun `matches folds case and diacritics like the transcript search does`() {
        assertTrue(TranscriptSearch.matches("Café Renewal — Northwind", "cafe"))
        assertTrue(TranscriptSearch.matches("Renewal terms — Northwind", "NORTHWIND"))
        assertTrue(TranscriptSearch.matches("續約條件討論 — 北風工業", "續約"))
        assertFalse(TranscriptSearch.matches("Renewal terms — Northwind", "Halcyon"))
    }

    @Test
    fun `matches treats a non-query as matching nothing`() {
        assertFalse(TranscriptSearch.matches("Renewal terms", ""))
        assertFalse(TranscriptSearch.matches("Renewal terms", "   "))
    }
}
