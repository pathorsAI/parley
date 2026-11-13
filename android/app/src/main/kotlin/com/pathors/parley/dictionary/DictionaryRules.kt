package com.pathors.parley.dictionary

import com.pathors.parley.kit.Lexicon
import com.pathors.parley.kit.LexiconPair
import com.pathors.parley.kit.LexiconTerm
import java.util.Locale

/**
 * The dictionary screen's non-UI decisions, kept apart from Compose so they
 * are unit-tested: what a search shows, and how "last synced" is worded.
 */
object DictionaryRules {

    /** The rows a search leaves, newest first. A blank query shows everything. */
    data class Listing(val pairs: List<LexiconPair>, val terms: List<LexiconTerm>) {
        val isEmpty: Boolean get() = pairs.isEmpty() && terms.isEmpty()
    }

    /**
     * Case-insensitive substring match on either side of a correction, or on a
     * term — someone searching "parley" means 怕理 → Parley as much as the term.
     */
    fun filter(lexicon: Lexicon, query: String): Listing {
        val q = query.trim().lowercase(Locale.ROOT)
        if (q.isEmpty()) return Listing(lexicon.pairsByRecency, lexicon.termsByRecency)
        fun hit(text: String) = text.lowercase(Locale.ROOT).contains(q)
        return Listing(
            pairs = lexicon.pairsByRecency.filter { hit(it.original) || hit(it.replacement) },
            terms = lexicon.termsByRecency.filter { hit(it.text) },
        )
    }

    /** How long ago, in the unit iOS `DictionarySyncStatusLine.ago` picks. */
    sealed interface Ago {
        data object JustNow : Ago
        data class Minutes(val n: Int) : Ago
        data class Hours(val n: Int) : Ago
        data class Days(val n: Int) : Ago
    }

    fun ago(atMs: Long, nowMs: Long): Ago {
        val minutes = ((nowMs - atMs).coerceAtLeast(0) / 60_000).toInt()
        val hours = minutes / 60
        return when {
            minutes < 1 -> Ago.JustNow
            minutes < 60 -> Ago.Minutes(minutes)
            hours < 24 -> Ago.Hours(hours)
            else -> Ago.Days(hours / 24)
        }
    }
}
