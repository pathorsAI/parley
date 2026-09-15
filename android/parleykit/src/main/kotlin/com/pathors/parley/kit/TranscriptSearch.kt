package com.pathors.parley.kit

import java.text.Normalizer
import java.util.Locale

/**
 * Finding a phrase inside one recording's transcript.
 *
 * The library already searches titles and snippets; this is the other half —
 * once you are *inside* a recording, a one-hour meeting is one continuous
 * column and finding where somebody said the number you remember means
 * scrolling and reading.
 *
 * Plain substring matching, deliberately. No tokenising, no stemming, no
 * index: the corpus is one meeting's worth of text, the reader is looking for
 * something they already know was said, and zh-Hant does not put spaces
 * between words — a tokeniser would have to be taught Chinese before it could
 * match 「續約」 inside 「下一次續約」, which a substring search does for free.
 * The same call handles both shipping languages with no branch.
 *
 * Kept here rather than in the view because it is the part worth testing: the
 * UI is highlights and a chevron, but which ranges match, in what order, and
 * what an empty query means are contracts. Ported from
 * `ios/ParleyKit/Sources/ParleyKit/TranscriptSearch.swift`, tests included, so
 * the two phones agree about what a query finds.
 */
object TranscriptSearch {

    /**
     * One occurrence, as the segment it is in and the slice of that segment's
     * `text` it covers.
     *
     * The offsets index [TranscriptSegment.text] and nothing else — they are
     * only meaningful against the segment named by [segmentId], which is why
     * the three travel together. Case- and diacritic-insensitive matching means
     * the matched slice is not always the same length as the query, so it is
     * carried rather than recomputed from the query's length at the call site.
     *
     * Two `Int`s rather than an `IntRange` because every consumer wants a
     * half-open range: `String.substring` and `AnnotatedString.addStyle` both
     * take an exclusive end, and an `IntRange`'s inclusive one would be
     * decremented at every call site until somebody forgot.
     */
    data class Hit(
        val segmentId: String,
        val start: Int,
        val endExclusive: Int,
    ) {
        /** The matched slice, read back out of the text it came from. */
        fun matchedIn(text: String): String = text.substring(start, endExclusive)
    }

    /**
     * Every occurrence of [query] in [segments], in document order.
     *
     * - Case- and diacritic-insensitive, so "okta" finds "Okta" and "cafe"
     *   finds "café". Both folds are Unicode-correct rather than a
     *   lowercased-ASCII approximation — see [foldCodePoint].
     * - Final segments only. The tentative tail a live session leaves behind
     *   is not on screen, so it must not be findable either — a hit that
     *   cannot be scrolled to is worse than no hit.
     * - An empty or whitespace-only query matches nothing. It is what a search
     *   field holds before anybody has typed and immediately after they clear
     *   it, and highlighting the entire transcript at that moment is the one
     *   behaviour guaranteed to be wrong.
     * - All occurrences within a segment, not just the first: "n of N" has to
     *   be able to count them, and a turn that says the thing twice is exactly
     *   the turn somebody is looking for.
     *
     * Linear in the transcript and re-run on every keystroke, which is what a
     * live highlight costs. One meeting is tens of thousands of characters and
     * the ASCII fast path in [foldCodePoint] carries most of them, so this is
     * well inside a frame; it is not an index and is not meant to become one.
     */
    fun hits(segments: List<TranscriptSegment>, query: String): List<Hit> {
        val needle = foldedNeedle(query) ?: return emptyList()

        val found = mutableListOf<Hit>()
        for (segment in segments) {
            if (!segment.isFinal) continue
            val folded = fold(segment.text)
            var from = 0
            while (from <= folded.text.length) {
                val at = folded.text.indexOf(needle, from)
                if (at < 0) break
                val end = at + needle.length
                val start = folded.origin[at]
                val endExclusive = folded.origin[end]
                if (endExclusive > start) {
                    found.add(Hit(segment.id, start, endExclusive))
                }
                // Resume after the match, except for the degenerate empty match
                // a fold can in principle produce — advancing by one there is
                // what keeps this from spinning forever.
                from = if (end > at) end else at + 1
            }
        }
        return found
    }

    /**
     * Whether [text] contains [query] under the same fold [hits] uses.
     *
     * This is how the library filters titles and snippets, so the two searches
     * in the app can never disagree about what "cafe" finds — a recording whose
     * title is "Café Renewal" has to be reachable from the library field and
     * from inside its own transcript by the same typing.
     */
    fun matches(text: String, query: String): Boolean {
        val needle = foldedNeedle(query) ?: return false
        return fold(text).text.contains(needle)
    }

    /**
     * The query as it is actually searched for, or null when it is not a query
     * at all — empty, whitespace-only, or nothing but combining marks, which
     * fold away to the same thing.
     */
    private fun foldedNeedle(query: String): String? =
        query.trim().takeIf { it.isNotEmpty() }?.let { fold(it).text }?.takeIf { it.isNotEmpty() }

    /**
     * A folded string alongside the map back to where it came from.
     *
     * [origin] has one entry per folded character, holding the index in the
     * original string of the code point that produced it, plus a final sentinel
     * equal to the original's length. That sentinel is what lets a match ending
     * at the very end of the text map back to a range rather than off the end.
     */
    private class Folded(val text: String, val origin: IntArray)

    /**
     * Case- and diacritic-fold [text], remembering where every folded character
     * came from.
     *
     * Folding one code point at a time rather than the whole string is the
     * whole trick: folding changes length (é is one character and folds to one,
     * but a decomposed "e" plus a combining acute is two and folds to one), and
     * a highlight has to be drawn over the transcript *as written*. Per code
     * point, every folded character has an origin, so a match found in the
     * folded text maps straight back to a range in the original.
     */
    private fun fold(text: String): Folded {
        val out = StringBuilder(text.length)
        var origin = IntArray(text.length + 1)
        var written = 0
        var index = 0
        while (index < text.length) {
            val codePoint = text.codePointAt(index)
            for (character in foldCodePoint(codePoint)) {
                if (written == origin.size) origin = origin.copyOf(origin.size * 2 + 1)
                origin[written++] = index
                out.append(character)
            }
            index += Character.charCount(codePoint)
        }
        if (written == origin.size) origin = origin.copyOf(written + 1)
        origin[written] = text.length
        return Folded(out.toString(), origin)
    }

    /**
     * One code point, folded: decomposed, stripped of its diacritics, lowercased.
     *
     * NFD then drop every non-spacing mark is what makes "cafe" find "café" in
     * both directions — the accent becomes a separate character and is thrown
     * away, whichever form the text arrived in. Only `Mn` is dropped, not every
     * mark category: a spacing mark is a letter's vowel in several Indic
     * scripts, and removing those would not be an accent-insensitive search but
     * a wrong one.
     *
     * Lowercased in [Locale.ROOT] rather than the device's locale, because the
     * Turkish dotless-i rule would otherwise make the same transcript searchable
     * differently depending on who is holding the phone.
     *
     * The ASCII fast path is not a micro-optimisation for its own sake: this
     * runs over the whole transcript on every keystroke, and no code point below
     * 0x80 has a decomposition or a multi-character lowercase, so skipping the
     * normaliser there is free correctness-wise and carries most of an English
     * meeting.
     */
    private fun foldCodePoint(codePoint: Int): String {
        if (codePoint < 0x80) {
            val char = codePoint.toChar()
            return if (char in 'A'..'Z') (char + 32).toString() else char.toString()
        }
        val decomposed = Normalizer.normalize(String(Character.toChars(codePoint)), Normalizer.Form.NFD)
        val stripped = StringBuilder(decomposed.length)
        var index = 0
        while (index < decomposed.length) {
            val current = decomposed.codePointAt(index)
            if (Character.getType(current) != Character.NON_SPACING_MARK.toInt()) {
                stripped.appendCodePoint(current)
            }
            index += Character.charCount(current)
        }
        return stripped.toString().lowercase(Locale.ROOT)
    }
}
