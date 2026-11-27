package com.pathors.parley.kit

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

private const val PARLEY = "Parley"
private const val HEARD = "怕理"
private const val CERANA = "Cerana"
private const val CERANA_AI = "Cerana AI"

/**
 * The personal dictionary as a value and on disk: the refusals a pair is held
 * to, the caps, what recognition is biased toward, and a file that survives a
 * bad row — iOS `LexiconStore.swift`'s rules for what Android uses.
 */
class LexiconTest {

    @get:Rule
    val temporary = TemporaryFolder()

    // ── refusals ─────────────────────────────────────────────────────────────

    @Test
    fun `refuses empty, unchanged, a lone ideograph and a replacement that grows`() {
        assertEquals(Lexicon.PairProblem.EMPTY, Lexicon.problem("", PARLEY))
        assertEquals(Lexicon.PairProblem.UNCHANGED, Lexicon.problem(PARLEY, PARLEY))
        assertEquals(Lexicon.PairProblem.SINGLE_CHARACTER, Lexicon.problem("派", "帕"))
        assertEquals(Lexicon.PairProblem.GROWS, Lexicon.problem("api", "api endpoint"))
        assertEquals(Lexicon.PairProblem.GROWS, Lexicon.problem("api", "The API v2"))
        assertEquals(Lexicon.PairProblem.GROWS, Lexicon.problem("在來", "在來了"))
        assertNull("a case fix re-applies as a no-op, not growth", Lexicon.problem("api", "API"))
        assertNull(Lexicon.problem(HEARD, PARLEY))
        assertNull("one Latin letter is not an ideograph", Lexicon.problem("x", "abc"))
    }

    // ── editing ──────────────────────────────────────────────────────────────

    @Test
    fun `a stated correction is stored confirmed and replaces the old one`() {
        val guess = Lexicon(listOf(LexiconPair(HEARD, "Pali", count = 1, updatedAt = 1)))
        val lex = guess.recordConfirmed(" $HEARD ", " $PARLEY ", now = 5)!!
        assertEquals(listOf(LexiconPair(HEARD, PARLEY, Lexicon.AUTO_APPLY_THRESHOLD, 5)), lex.pairs)

        val seen = Lexicon(listOf(LexiconPair(HEARD, PARLEY, count = 7, updatedAt = 1)))
        assertEquals("re-stating keeps a higher count", 7, seen.recordConfirmed(HEARD, PARLEY, 9)!!.pairs[0].count)
        assertNull(Lexicon().recordConfirmed("派", "帕", 1))
    }

    @Test
    fun `adding a term twice freshens it rather than duplicating it`() {
        val lex = Lexicon().addTerm(PARLEY, 1).addTerm("  $PARLEY ", 9).addTerm("   ", 10)
        assertEquals(listOf(LexiconTerm(PARLEY, 9)), lex.terms)
    }

    @Test
    fun `caps evict the oldest`() {
        var lex = Lexicon()
        for (i in 0..Lexicon.MAX_TERMS) lex = lex.addTerm("t$i", now = i.toLong())
        assertEquals(Lexicon.MAX_TERMS, lex.terms.size)
        assertFalse(lex.terms.any { it.text == "t0" })

        var pairs = Lexicon()
        for (i in 0..Lexicon.MAX_PAIRS) pairs = pairs.recordConfirmed("heard$i", "meant$i", now = i.toLong())!!
        assertEquals(Lexicon.MAX_PAIRS, pairs.pairs.size)
        assertFalse(pairs.pairs.any { it.original == "heard0" })
    }

    // ── recognition terms ────────────────────────────────────────────────────

    @Test
    fun `recognition terms are the user's words, terms first, newest first, deduplicated`() {
        val lex = Lexicon(
            pairs = listOf(
                LexiconPair(HEARD, PARLEY, 2, updatedAt = 30),
                LexiconPair("色瑞", CERANA, 1, updatedAt = 40),
            ),
            terms = listOf(LexiconTerm("Pathors", 10), LexiconTerm(PARLEY, 20)),
        )
        assertEquals(listOf(PARLEY, "Pathors", CERANA), lex.recognitionTerms)
        assertTrue("never the misheard side", HEARD !in lex.recognitionTerms)
    }

    // ── file ─────────────────────────────────────────────────────────────────

    @Test
    fun `decoding drops a bad row, not the file`() {
        val lex = Lexicon.decode(
            """{"pairs":[{"original":"$HEARD","replacement":"$PARLEY"},{"original":"x"},7],
               "terms":[{"text":"$CERANA","updatedAt":3},{"updatedAt":4}],"systemTerms":["Mom"]}""",
        )
        assertEquals(listOf(LexiconPair(HEARD, PARLEY, count = 1, updatedAt = 0)), lex.pairs)
        assertEquals(listOf(LexiconTerm(CERANA, 3)), lex.terms)
        assertEquals(Lexicon(), Lexicon.decode("not json"))
        assertEquals(lex, Lexicon.decode(lex.encode()))
    }

    @Test
    fun `the store persists edits, notifies after each write, and survives a reopen`() {
        val file = File(temporary.root, LexiconStore.FILE_NAME)
        var clock = 100L
        val store = LexiconStore(file) { clock++ }
        var saves = 0
        store.didSave = { saves++ }

        store.addTerm(CERANA)
        assertTrue(store.recordConfirmed(HEARD, PARLEY))
        assertFalse("a refused pair is not stored", store.recordConfirmed("派", "帕"))
        store.removeTerm("not there")
        assertEquals("a write that changed nothing does not schedule a sync", 2, saves)

        val reopened = LexiconStore(file)
        assertEquals(store.load(), reopened.load())
        assertEquals(listOf(CERANA, PARLEY), reopened.recognitionTerms())

        store.removeAll()
        assertTrue(LexiconStore(file).load().isEmpty)
    }

    @Test
    fun `editing a row replaces it, and a refused edit keeps the old one`() {
        val store = LexiconStore(File(temporary.root, LexiconStore.FILE_NAME))
        store.recordConfirmed(HEARD, PARLEY)
        assertFalse(store.replacePair(HEARD, "派", "帕"))
        assertEquals(listOf(HEARD), store.load().pairs.map { it.original })
        assertTrue(store.replacePair(HEARD, "帕力", PARLEY))
        assertEquals(listOf("帕力"), store.load().pairs.map { it.original })

        store.addTerm(CERANA)
        store.replaceTerm(CERANA, CERANA_AI)
        store.replaceTerm(CERANA_AI, "  ")
        assertEquals(listOf(CERANA_AI), store.load().terms.map { it.text })
    }

    // ── on the wire ──────────────────────────────────────────────────────────

    @Test
    fun `vocabulary is trimmed, deduplicated and capped in order`() {
        val many = (0 until ParleyStreamProtocol.VOCABULARY_LIMIT + 50).map { "w$it" }
        val cleaned = ParleyStreamProtocol.cleanVocabulary(listOf(" a ", "", "a", "b") + many)
        assertEquals(listOf("a", "b", "w0"), cleaned.take(3))
        assertEquals(ParleyStreamProtocol.VOCABULARY_LIMIT, cleaned.size)
    }

    @Test
    fun `the start frame carries the dictionary as hints, and omits them when empty`() {
        val frame = SttRelayClient.startFrame(SttRelayClient.Options(bearerToken = "t", hintTerms = listOf(" $PARLEY ", PARLEY)))
        assertEquals(listOf(PARLEY), frame.hints?.terms)
        assertNull(SttRelayClient.startFrame(SttRelayClient.Options(bearerToken = "t", hintTerms = listOf(" "))).hints)
    }

    // ── applying — iOS `LexiconTests`, the `apply(to:)` cases ────────────────

    /** A pair confirmed enough times to be worth applying. */
    private fun confirmed(original: String, replacement: String) =
        LexiconPair(original, replacement, count = Lexicon.AUTO_APPLY_THRESHOLD, updatedAt = 1)

    @Test
    fun `a stated correction applies at once`() {
        val lexicon = Lexicon().recordConfirmed(" 派斯 ", "Pathors", now = 1)!!
        assertEquals("我們Pathors的產品", lexicon.apply("我們派斯的產品"))
    }

    @Test
    fun `a singly seen pair is not applied`() {
        val lexicon = Lexicon(pairs = listOf(LexiconPair("pearly", PARLEY, count = 1)))
        assertEquals("we use pearly", lexicon.apply("we use pearly"))
    }

    @Test
    fun `a confirmed pair is applied`() {
        val lexicon = Lexicon(pairs = listOf(confirmed("pearly", PARLEY)))
        assertEquals("we use Parley today", lexicon.apply("we use pearly today"))
    }

    @Test
    fun `Latin pairs need word boundaries`() {
        // "rapid" contains "api" and must be left alone.
        val lexicon = Lexicon(pairs = listOf(confirmed("api", "API")))
        assertEquals("a rapid API call", lexicon.apply("a rapid api call"))
    }

    @Test
    fun `Latin pairs match regardless of case`() {
        val lexicon = Lexicon(pairs = listOf(confirmed("pearly", PARLEY)))
        assertEquals("Parley and Parley", lexicon.apply("Pearly and pearly"))
    }

    @Test
    fun `CJK pairs are a plain substring replacement`() {
        val lexicon = Lexicon(pairs = listOf(confirmed("在來", "再來")))
        assertEquals("我再來一次", lexicon.apply("我在來一次"))
    }

    @Test
    fun `the longest original wins`() {
        // With both on file, "pearly clod" must not be half-rewritten by "pearly".
        val lexicon = Lexicon(pairs = listOf(confirmed("pearly", PARLEY), confirmed("pearly clod", "Parley Cloud")))
        assertEquals("ship on Parley Cloud", lexicon.apply("ship on pearly clod"))
    }

    @Test
    fun `a looping pair is never applied even if it is on file`() {
        // recordConfirmed refuses these, but the file is synced and may hold one.
        val lexicon = Lexicon(pairs = listOf(confirmed("api", "api endpoint")))
        assertEquals("the api", lexicon.apply("the api"))
    }

    @Test
    fun `apply is deterministic and leaves unknown text alone`() {
        val lexicon = Lexicon(pairs = listOf(confirmed("pearly", PARLEY), confirmed("在說", "再說")))
        val text = "我在說 pearly 的事"
        val once = lexicon.apply(text)
        assertEquals("我再說 Parley 的事", once)
        assertEquals(once, lexicon.apply(text))
    }

    @Test
    fun `a widened CJK pair leaves other words with the same character alone`() {
        val lexicon = Lexicon(pairs = listOf(confirmed("派斯", "帕斯")))
        assertEquals("帕斯的派對", lexicon.apply("派斯的派對"))
        assertEquals("派對", lexicon.apply("派對"))
        assertEquals("帕斯辦了派對", lexicon.apply("派斯辦了派對"))
    }

    @Test
    fun `a legacy single-character pair is not applied`() {
        val lexicon = Lexicon(pairs = listOf(confirmed("派", "帕")))
        assertEquals("派對", lexicon.apply("派對"))
    }

    @Test
    fun `apply counts its replacements`() {
        val lexicon = Lexicon(pairs = listOf(confirmed("pearly", PARLEY), confirmed("派斯", "Pathors")))
        val result = lexicon.applyCounting("pearly, Pearly, 派斯 and rapid")
        assertEquals("Parley, Parley, Pathors and rapid", result.text)
        assertEquals(3, result.hits)
        assertEquals(0, lexicon.applyCounting("nothing here").hits)
    }

    @Test
    fun `substitute uses the same matching rules`() {
        assertEquals("a rapid API", Lexicon.substitute("api", "API", "a rapid api").text)
        assertEquals(2, Lexicon.substitute("派斯", "Pathors", "派斯派斯").hits)
        assertEquals(0, Lexicon.substitute("zzz", "y", "abc").hits)
    }

    @Test
    fun `apply on an empty lexicon and on empty text`() {
        assertEquals("untouched", Lexicon().apply("untouched"))
        assertEquals("", Lexicon(pairs = listOf(confirmed("a", "b"))).apply(""))
    }

    @Test
    fun `a regex metacharacter in a pair is a literal`() {
        val lexicon = Lexicon(pairs = listOf(confirmed("c++", "C++")))
        assertEquals("wrote C++ today", lexicon.apply("wrote c++ today"))
    }

    @Test
    fun `a dollar in a replacement is a literal`() {
        val lexicon = Lexicon(pairs = listOf(confirmed("usd", "\$")))
        assertEquals("10 \$", lexicon.apply("10 usd"))
    }

    @Test
    fun `the store applies what is on disk`() {
        val store = LexiconStore(File(temporary.root, LexiconStore.FILE_NAME)) { 1L }
        assertEquals("we use pearly", store.apply("we use pearly"))
        assertTrue(store.recordConfirmed("pearly", PARLEY))
        assertEquals("we use Parley", store.apply("we use pearly"))
    }
}
