package com.pathors.parley.kit

import java.text.Normalizer
import java.util.Locale

/**
 * Finding a folder by name in the "Move to folder" picker.
 *
 * A folder is a customer, so a working account ends up with dozens of them and
 * the picker has to be searchable. The rules are the ones iOS
 * `ParleyKit/FolderSearch.swift` settled on, ported so the two phones agree
 * about what a query finds:
 *
 * - a plain substring match, so 「北風」 finds 「北風工業」 without a tokeniser;
 * - case- and diacritic-insensitive, so "cafe" finds "Café";
 * - width-insensitive as well, because a zh-Hant keyboard can type full-width
 *   Latin and "ＡＣＭＥ" should still find "Acme".
 *
 * Generic over the item type rather than tied to the cloud's folder DTO: this
 * module does not know the app's cloud models, and "a list of things with a
 * name" is all the matching needs. Kept here rather than in the sheet because
 * what matches, and when the picker offers to create the query as a new folder,
 * are contracts worth a test; the view is rows and a text field.
 */
object FolderSearch {

    /**
     * The query as the picker uses it: surrounding whitespace is not part of
     * what anyone meant to search for, or to name a folder.
     */
    fun normalized(query: String): String = query.trim()

    /**
     * Whether [name] contains [query]. An empty (or all-whitespace) query
     * matches everything — no search is the whole list.
     */
    fun matches(name: String, query: String): Boolean {
        val needle = fold(normalized(query))
        if (needle.isEmpty()) return true
        return fold(name).contains(needle)
    }

    /** [items] narrowed to the ones whose [name] matches [query], in their original order. */
    fun <T> filter(items: List<T>, query: String, name: (T) -> String): List<T> =
        items.filter { matches(name(it), query) }

    /**
     * Whether an item is already called exactly [query], by the same loose
     * rules — so the picker does not offer to create a second "Acme" next to
     * "acme".
     */
    fun <T> hasExactMatch(items: List<T>, query: String, name: (T) -> String): Boolean =
        exactMatch(items, query, name) != null

    /** The first item called exactly [query], by the same loose rules. */
    fun <T> exactMatch(items: List<T>, query: String, name: (T) -> String): T? {
        val needle = fold(normalized(query))
        if (needle.isEmpty()) return null
        return items.firstOrNull { fold(normalized(name(it))) == needle }
    }

    /**
     * Width-, diacritic- and case-fold [text].
     *
     * NFKD does two of the three in one pass: its compatibility mappings turn
     * full-width Latin (and half-width katakana) into the ordinary forms, and
     * its canonical decomposition splits "é" into "e" plus a combining acute.
     * Dropping every non-spacing mark then removes the accent. Only `Mn` goes —
     * a spacing mark is a letter's vowel in several Indic scripts, and removing
     * those would not be an accent-insensitive search but a wrong one (the same
     * line `TranscriptSearch` draws).
     *
     * Lowercased in [Locale.ROOT], so the Turkish dotless-i rule cannot make the
     * same folder list searchable differently depending on the phone's language.
     *
     * NFKD is slightly broader than iOS's `.widthInsensitive` — it also folds,
     * say, a circled digit to the digit. Folder names are customer names, and a
     * search that is a little more forgiving than iOS's is not one anybody will
     * trip over.
     */
    private fun fold(text: String): String {
        val decomposed = Normalizer.normalize(text, Normalizer.Form.NFKD)
        val out = StringBuilder(decomposed.length)
        var index = 0
        while (index < decomposed.length) {
            val codePoint = decomposed.codePointAt(index)
            if (Character.getType(codePoint) != Character.NON_SPACING_MARK.toInt()) {
                out.appendCodePoint(codePoint)
            }
            index += Character.charCount(codePoint)
        }
        return out.toString().lowercase(Locale.ROOT)
    }
}
