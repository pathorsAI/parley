package com.pathors.parley.dictionary

import com.pathors.parley.kit.Lexicon
import com.pathors.parley.kit.LexiconPair
import com.pathors.parley.kit.LexiconTerm
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

private const val PARLEY = "Parley"

class DictionaryRulesTest {
    private val lexicon = Lexicon(
        pairs = listOf(LexiconPair("怕理", PARLEY, 2, 10), LexiconPair("色瑞", "Cerana", 2, 20)),
        terms = listOf(LexiconTerm("Pathors", 1), LexiconTerm("parley cloud", 2)),
    )

    @Test
    fun `a blank query lists everything newest first`() {
        val all = DictionaryRules.filter(lexicon, "  ")
        assertEquals(listOf("色瑞", "怕理"), all.pairs.map { it.original })
        assertEquals(listOf("parley cloud", "Pathors"), all.terms.map { it.text })
    }

    @Test
    fun `a search matches either side of a correction and terms, ignoring case`() {
        val hit = DictionaryRules.filter(lexicon, "PARLEY")
        assertEquals(listOf("怕理"), hit.pairs.map { it.original })
        assertEquals(listOf("parley cloud"), hit.terms.map { it.text })
        assertEquals(listOf(PARLEY), DictionaryRules.filter(lexicon, "怕").pairs.map { it.replacement })
        assertTrue(DictionaryRules.filter(lexicon, "nothing like it").isEmpty)
    }

    @Test
    fun `ago picks the unit iOS does`() {
        val minute = 60_000L
        assertEquals(DictionaryRules.Ago.JustNow, DictionaryRules.ago(0, 59_000))
        assertEquals(DictionaryRules.Ago.JustNow, DictionaryRules.ago(10, 0))
        assertEquals(DictionaryRules.Ago.Minutes(59), DictionaryRules.ago(0, 59 * minute))
        assertEquals(DictionaryRules.Ago.Hours(23), DictionaryRules.ago(0, 24 * 60 * minute - 1))
        assertEquals(DictionaryRules.Ago.Days(2), DictionaryRules.ago(0, 49 * 60 * minute))
    }
}
