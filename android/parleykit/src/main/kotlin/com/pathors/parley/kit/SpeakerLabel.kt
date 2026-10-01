package com.pathors.parley.kit

import java.util.Locale

/**
 * What a transcript calls the person speaking — the desktop's
 * `defaultSpeakerLabel` (store.ts) and iOS `RecordingMeta.speakerLabel(for:)`,
 * rule for rule, so the same recording names the same people on every device:
 *
 * - a name the user assigned (`speakerNames["{source}-{speaker}"]`) always wins;
 * - a desktop `me` source is "You" (speaker 1) or "You N";
 * - a desktop `them` source is "Them" (speaker 1) or "Remote N";
 * - anything else — a phone's `mix` — is a letter, "Speaker A", "Speaker B" …,
 *   and an undecided speaker (index 0) is `…`: the provider has not said who is
 *   talking, and an ellipsis admits that where "Speaker A" would quietly invent
 *   a person.
 *
 * Pure: the words arrive through [Strings], already localized, so this file
 * holds only the rules — the part both platforms have to agree on.
 */
object SpeakerLabel {

    /** What iOS and the desktop show for a speaker nobody has decided on. */
    const val UNDECIDED = "…"

    /**
     * The localized copy. The numbered forms are `String.format` patterns — the
     * Android spelling of the iOS catalogue entries (`%1$d` for `%lld`, `%1$s`
     * for `%@`).
     */
    data class Strings(
        /** "You" — a desktop `me` source's only (or first) speaker. */
        val you: String,
        /** "You %1$d". */
        val youNumbered: String,
        /** "Them" — a desktop `them` source's only (or first) speaker. */
        val them: String,
        /** "Remote %1$d". */
        val remoteNumbered: String,
        /** "Speaker %1$s", filled with [letter]. */
        val lettered: String,
    )

    /** The label for a speaker with no assigned name. */
    fun fallback(source: String, speaker: Int, strings: Strings): String = when (source) {
        SOURCE_ME -> if (speaker <= 1) strings.you else format(strings.youNumbered, speaker)
        SOURCE_THEM -> if (speaker <= 1) strings.them else format(strings.remoteNumbered, speaker)
        else -> {
            val letter = letter(speaker)
            if (letter.isEmpty()) UNDECIDED else String.format(Locale.ROOT, strings.lettered, letter)
        }
    }

    /** [fallback], unless [names] holds a non-empty name for this speaker. */
    fun label(source: String, speaker: Int, names: Map<String, String>, strings: Strings): String =
        names["$source-$speaker"]?.takeIf { it.isNotEmpty() } ?: fallback(source, speaker, strings)

    /**
     * 1 → A, 2 → B … 26 → Z, 27 → AA — bijective base 26, the way spreadsheet
     * columns count, so every index gets a distinct name. Empty for 0 and below:
     * that is "not decided", not speaker A. iOS `speakerLetter`.
     */
    fun letter(n: Int): String {
        if (n <= 0) return ""
        var remaining = n
        val letters = StringBuilder()
        while (remaining > 0) {
            val digit = (remaining - 1) % ALPHABET
            letters.insert(0, 'A' + digit)
            remaining = (remaining - 1) / ALPHABET
        }
        return letters.toString()
    }

    private fun format(template: String, n: Int): String = String.format(Locale.ROOT, template, n)

    private const val SOURCE_ME = "me"
    private const val SOURCE_THEM = "them"
    private const val ALPHABET = 26
}
