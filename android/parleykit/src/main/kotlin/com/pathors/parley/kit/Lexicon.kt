package com.pathors.parley.kit

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * One correction the user has made: what dictation produced, and what they
 * meant. iOS `LexiconPair`.
 *
 * `count` is why this is a pair rather than a rule: a correction inferred from
 * one edit is a guess, and only one seen [Lexicon.AUTO_APPLY_THRESHOLD] times
 * is a rule. A pair the user typed in themselves is stored already confirmed.
 *
 * @property original what came back from dictation. Unique within a lexicon:
 *   one misheard form has exactly one correction, which makes it the id.
 * @property updatedAt epoch ms of the last sighting — and the eviction order.
 */
data class LexiconPair(
    val original: String,
    val replacement: String,
    val count: Int = 1,
    val updatedAt: Long = 0,
) {
    val isConfirmed: Boolean get() = count >= Lexicon.AUTO_APPLY_THRESHOLD
}

/**
 * A term the user typed in themselves. Not a substitution — nothing came back
 * wrong yet — but a word to bias recognition toward: it rides in the streaming
 * `hints.terms` and the batch `terms` (see [Lexicon.recognitionTerms]).
 */
data class LexiconTerm(val text: String, val updatedAt: Long = 0)

/**
 * The user's personal dictionary, as a value — iOS `Lexicon`.
 *
 * Immutable: every edit returns a new lexicon. All the rules live here rather
 * than on the file-backed [LexiconStore], so they are tested without a disk,
 * and [DictionarySync] can fold a whole exchange into a copy and compare.
 *
 * The keyboard learning (`record`) and the substitution pass (`apply`) iOS has
 * on the same type are not ported: Android's keyboard does not learn from edits
 * yet, so nothing would call them. What is here is what the dictionary screen,
 * sync and recognition need.
 */
data class Lexicon(
    val pairs: List<LexiconPair> = emptyList(),
    val terms: List<LexiconTerm> = emptyList(),
) {

    /** Why a pair cannot be stored. Both sides are expected trimmed. */
    enum class PairProblem {
        /** A side is empty. */
        EMPTY,

        /** The two sides are the same. */
        UNCHANGED,

        /**
         * The original is one CJK character. Applied as a plain substring —
         * the only way CJK can be applied — one character rewrites every word
         * it appears in: 派 → 帕 turns 派對 into 帕對.
         */
        SINGLE_CHARACTER,

        /** The replacement properly contains the original, so it would grow the text on every pass. */
        GROWS,
    }

    // ── editing ──────────────────────────────────────────────────────────────

    /**
     * A correction the user stated outright — typed into the dictionary
     * screen — rather than one inferred from an edit. Stored as already
     * confirmed, and it replaces whatever correction the original had before:
     * the two-sightings rule tells a mishearing from a change of mind, and
     * nobody fills in a form by changing their mind.
     *
     * @return the new lexicon, or null when [problem] refuses the pair.
     */
    fun recordConfirmed(original: String, replacement: String, now: Long): Lexicon? {
        val from = original.trim()
        val to = replacement.trim()
        if (problem(from, to) != null) return null
        val existing = pairs.indexOfFirst { it.original == from }
        if (existing >= 0) {
            val old = pairs[existing]
            val count = if (old.replacement == to) maxOf(old.count, AUTO_APPLY_THRESHOLD) else AUTO_APPLY_THRESHOLD
            val next = pairs.toMutableList()
            next[existing] = LexiconPair(from, to, count, now)
            return copy(pairs = next)
        }
        return copy(pairs = pairs + LexiconPair(from, to, AUTO_APPLY_THRESHOLD, now)).evicted()
    }

    /** A term added by hand. Re-adding one already there only freshens its stamp. */
    fun addTerm(text: String, now: Long): Lexicon {
        val term = text.trim()
        if (term.isEmpty()) return this
        if (terms.any { it.text == term }) {
            return copy(terms = terms.map { if (it.text == term) it.copy(updatedAt = now) else it })
        }
        return copy(terms = terms + LexiconTerm(term, now)).evicted()
    }

    fun removePair(original: String): Lexicon = copy(pairs = pairs.filterNot { it.original == original })

    fun removeTerm(text: String): Lexicon = copy(terms = terms.filterNot { it.text == text })

    /**
     * Held to the caps: oldest-updated go first, the closest thing to "least
     * useful" that costs nothing to track. Called by every write that can add
     * a row — including [DictionarySync], which writes many at once.
     */
    fun evicted(): Lexicon {
        val p = if (pairs.size > MAX_PAIRS) pairs.sortedByDescending { it.updatedAt }.take(MAX_PAIRS) else pairs
        val t = if (terms.size > MAX_TERMS) terms.sortedByDescending { it.updatedAt }.take(MAX_TERMS) else terms
        return if (p === pairs && t === terms) this else Lexicon(p, t)
    }

    // ── reading ──────────────────────────────────────────────────────────────

    /** Newest first — the order the screen lists them in, and the order a cap should keep. */
    val pairsByRecency: List<LexiconPair> get() = pairs.sortedByDescending { it.updatedAt }

    val termsByRecency: List<LexiconTerm> get() = terms.sortedByDescending { it.updatedAt }

    /**
     * The user's own words: every term they typed in, then the right-hand side
     * of every correction. Deduplicated, newest first, so under a cap (the
     * relay's 200, [ParleyStreamProtocol.VOCABULARY_LIMIT]) the newest survive.
     */
    val userTerms: List<String>
        get() = (termsByRecency.map { it.text } + pairsByRecency.map { it.replacement }).distinct()

    /**
     * What recognition is biased toward — [userTerms], and only those. A
     * separate name for the separate use, as on iOS: these leave the phone, so
     * anything ever added to the suggestion list has to be decided for this one
     * on purpose.
     */
    val recognitionTerms: List<String> get() = userTerms

    val isEmpty: Boolean get() = pairs.isEmpty() && terms.isEmpty()

    // ── file format ──────────────────────────────────────────────────────────

    /** `{ pairs: [...], terms: [...] }`, the same field names iOS writes. */
    fun encode(): String = buildJsonObject {
        put(
            "pairs",
            buildJsonArray {
                pairs.forEach { pair ->
                    add(
                        buildJsonObject {
                            put("original", pair.original)
                            put("replacement", pair.replacement)
                            put("count", pair.count)
                            put("updatedAt", pair.updatedAt)
                        },
                    )
                }
            },
        )
        put(
            "terms",
            buildJsonArray {
                terms.forEach { term ->
                    add(
                        buildJsonObject {
                            put("text", term.text)
                            put("updatedAt", term.updatedAt)
                        },
                    )
                }
            },
        )
    }.toString()

    companion object {
        /**
         * How many sightings make an inferred correction a rule. Two: one edit
         * is as likely a change of mind as a mishearing; a real mishearing
         * happens every time the word is said.
         */
        const val AUTO_APPLY_THRESHOLD = 2

        /** Caps, so the file cannot grow without bound. Same numbers as iOS. */
        const val MAX_PAIRS = 500
        const val MAX_TERMS = 200

        private val json = Json { ignoreUnknownKeys = true }

        /** Why `original → replacement` cannot be stored, or null when it can. */
        fun problem(original: String, replacement: String): PairProblem? = when {
            original.isEmpty() || replacement.isEmpty() -> PairProblem.EMPTY
            original == replacement -> PairProblem.UNCHANGED
            isLoneIdeograph(original) -> PairProblem.SINGLE_CHARACTER
            loops(original, replacement) -> PairProblem.GROWS
            else -> null
        }

        /**
         * The replacement *properly* contains the original, so substituting it
         * would grow the text every time it ran. "api" → "API" also contains
         * its original (Latin matches case-insensitively) but re-applying it is
         * a no-op, which is what the length test separates out.
         */
        internal fun loops(from: String, to: String): Boolean {
            if (to.codePointCount(0, to.length) <= from.codePointCount(0, from.length)) return false
            return to.contains(from, ignoreCase = isLatinWordLike(from))
        }

        /** All-ASCII with a letter or digit — the shape that has word boundaries worth asserting. */
        internal fun isLatinWordLike(text: String): Boolean =
            text.all { it.code < 0x80 } && text.any { it.isLetterOrDigit() }

        /** One ideograph and nothing else — iOS `EditDiff.isLoneIdeograph`. */
        internal fun isLoneIdeograph(text: String): Boolean =
            text.isNotEmpty() && text.codePointCount(0, text.length) == 1 && isIdeographic(text.codePointAt(0))

        private fun isIdeographic(cp: Int): Boolean =
            cp in 0x3040..0x30FF || // Hiragana, Katakana
                cp in 0x3400..0x4DBF || // CJK Extension A
                cp in 0x4E00..0x9FFF || // CJK Unified Ideographs
                cp in 0xAC00..0xD7AF || // Hangul syllables
                cp in 0xF900..0xFAFF || // CJK Compatibility Ideographs
                cp in 0x20000..0x2FA1F // CJK Extension B and beyond

        /**
         * Decode what is readable and drop what is not, row by row: one
         * malformed pair must not cost the user the rest of their dictionary.
         * A pair with no count or stamp is still a usable pair; only a missing
         * side makes it meaningless.
         */
        fun decode(text: String): Lexicon {
            val root = runCatching { json.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return Lexicon()
            val pairs = (root["pairs"] as? JsonArray).orEmpty().mapNotNull { element ->
                val o = element as? JsonObject ?: return@mapNotNull null
                val original = o.string("original") ?: return@mapNotNull null
                val replacement = o.string("replacement") ?: return@mapNotNull null
                LexiconPair(
                    original = original,
                    replacement = replacement,
                    count = (o["count"] as? JsonPrimitive)?.intOrNull ?: 1,
                    updatedAt = o.long("updatedAt"),
                )
            }
            val terms = (root["terms"] as? JsonArray).orEmpty().mapNotNull { element ->
                val o = element as? JsonObject ?: return@mapNotNull null
                val t = o.string("text") ?: return@mapNotNull null
                LexiconTerm(t, o.long("updatedAt"))
            }
            return Lexicon(pairs, terms)
        }

        private fun JsonObject.string(key: String): String? =
            (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

        private fun JsonObject.long(key: String): Long = (this[key] as? JsonPrimitive)?.longOrNull ?: 0L
    }
}
