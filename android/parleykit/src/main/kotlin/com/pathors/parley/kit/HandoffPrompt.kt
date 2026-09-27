package com.pathors.parley.kit

import java.util.Locale

/**
 * The text Parley hands to the user's own AI: an analysis prompt, the meeting's
 * facts, and the whole transcript, as one paste.
 *
 * On a phone the hand-off is the share sheet or the clipboard — ChatGPT and
 * Claude are both share targets — so this is a plain string that reads correctly
 * pasted into any chat box. The shape is iOS `HandoffPrompt.swift`, line for
 * line, so the same meeting hands off identically from either phone:
 *
 * ```
 * You are my meeting analyst. Below is the full transcript …
 * 1. <question>
 * 2. <question>
 * 3. <question>
 * Quote the transcript's own words and give the timestamp when you answer.
 *
 * Meeting: <title> (<date>)
 * Context: <context, or "not provided">
 * Speakers: <names>
 *
 * --- Transcript ---
 * [m:ss] Speaker: text
 * ```
 *
 * Pure: every word of copy arrives through [Strings], already localized, and the
 * date and the speaker list arrive formatted. What is left here is the order of
 * the lines, which is the part both platforms have to agree on.
 */
object HandoffPrompt {

    /**
     * The localized copy. The templates are `String.format` patterns, the
     * Android spelling of the iOS catalogue entries (`%1$s` for `%1$@`).
     */
    data class Strings(
        val preamble: String,
        val closing: String,
        /** `Meeting: %1$s (%2$s)` — title, then date. */
        val meeting: String,
        /** `Context: %1$s`. */
        val context: String,
        /** What [context] says when the meeting has none. */
        val contextMissing: String,
        /** `Speakers: %1$s`. */
        val speakers: String,
        val transcriptHeader: String,
        /** `%1$s: %2$s` — speaker, then what they said. */
        val line: String,
    )

    /** One turn of the transcript, already labelled. */
    data class Turn(val speaker: String, val startMs: Long, val text: String)

    data class Meeting(
        val title: String,
        /** Already formatted in the reader's locale. */
        val date: String,
        val context: String,
        /** Already joined in the reader's locale ("You and Mr. Lin"). */
        val speakers: String,
        val turns: List<Turn>,
        val questions: List<String>,
    )

    fun build(strings: Strings, meeting: Meeting): String {
        val lines = mutableListOf<String>()
        lines += strings.preamble
        meeting.questions.forEachIndexed { index, question -> lines += "${index + 1}. $question" }
        lines += strings.closing
        lines += ""

        lines += format(strings.meeting, meeting.title, meeting.date)
        val context = meeting.context.trim()
        lines += format(strings.context, context.ifEmpty { strings.contextMissing })
        lines += format(strings.speakers, meeting.speakers)
        lines += ""

        lines += strings.transcriptHeader
        meeting.turns.forEach { turn ->
            lines += "[${clock(turn.startMs)}] " + format(strings.line, turn.speaker, turn.text)
        }
        return lines.joinToString("\n")
    }

    /**
     * The speakers in order of first appearance, each once — the order iOS
     * lists them in, which is the order a reader meets them.
     */
    fun <T> distinctSpeakers(turns: List<T>, label: (T) -> String): List<String> =
        turns.map(label).distinct()

    /** `m:ss`, the same clock the transcript rows and the plain copy use. */
    fun clock(ms: Long): String {
        val total = (ms / MS_PER_SECOND).coerceAtLeast(0L)
        return String.format(Locale.US, "%d:%02d", total / SECONDS_PER_MINUTE, total % SECONDS_PER_MINUTE)
    }

    // Locale.ROOT: the arguments are already-formatted text; nothing in these
    // templates is a number the locale could reshape.
    private fun format(template: String, vararg args: String): String =
        String.format(Locale.ROOT, template, *args)

    private const val MS_PER_SECOND = 1_000L
    private const val SECONDS_PER_MINUTE = 60L
}
