package com.pathors.parley.kit

/**
 * The brief's markdown, read the way the phone draws it: paragraphs of text,
 * some of it bold, with `[m:ss]` timestamps that are links into the recording.
 * iOS `BriefMarkup.swift`, rule for rule, so a brief reads the same on both
 * phones.
 *
 * "Markdown-lite" on purpose. The brief is written by the analysis (or, for the
 * sample, by the script) and what it actually uses is bold lead-ins and
 * timestamps; a full markdown renderer would draw headings, tables and code
 * spans the summary has no room for, and none of them knows that `[1:34]` is a
 * link. So the handful of constructs the brief uses are parsed here, where they
 * can be tested, and everything else stays as the characters it is:
 *
 * - `**…**` toggles bold. An unclosed `**` is just two asterisks.
 * - `[m:ss]` and `[h:mm:ss]` become timestamps. Anything else in square
 *   brackets is text.
 * - A blank line separates paragraphs; a single newline is kept inside one.
 * - A line starting with `#`s is a heading and is drawn bold, without the
 *   hashes; a line starting with `- ` or `* ` is a bullet and gets `• `.
 */
object BriefMarkup {

    sealed interface Run {
        data class Text(val text: String, val bold: Boolean) : Run

        /**
         * A moment on the recording. [label] is what the brief wrote, so the link
         * reads exactly as the brief does.
         */
        data class Timestamp(val ms: Long, val label: String) : Run
    }

    /** The brief as paragraphs of runs. Empty paragraphs are dropped. */
    fun paragraphs(markdown: String): List<List<Run>> {
        val normalized = markdown.replace("\r\n", "\n")
        val blocks = mutableListOf(mutableListOf<String>())
        for (line in normalized.split("\n")) {
            if (line.all(::isHorizontalSpace)) {
                if (blocks.last().isNotEmpty()) blocks += mutableListOf<String>()
            } else {
                blocks.last() += line
            }
        }
        return blocks.filter { it.isNotEmpty() }.map { lines ->
            val runs = mutableListOf<Run>()
            lines.forEachIndexed { index, line ->
                if (index > 0) append(Run.Text("\n", bold = false), runs)
                parseLine(line).forEach { append(it, runs) }
            }
            runs
        }
    }

    /** `m:ss` or `h:mm:ss` to milliseconds; null for anything else. */
    fun milliseconds(clock: String): Long? {
        val parts = clock.split(":")
        if (parts.size !in 2..3) return null
        if (parts.any { part -> part.isEmpty() || part.any { it !in '0'..'9' } }) return null
        val numbers = parts.map { it.toLongOrNull() ?: return null }
        // Every field after the first is a two-digit base-60 field.
        for (index in 1 until parts.size) {
            if (parts[index].length != 2 || numbers[index] >= SECONDS_PER_MINUTE) return null
        }
        val seconds = numbers.fold(0L) { total, next -> total * SECONDS_PER_MINUTE + next }
        return seconds * MS_PER_SECOND
    }

    // ── parsing ──────────────────────────────────────────────────────────────

    private fun parseLine(raw: String): List<Run> {
        var line = raw.trim(::isHorizontalSpace)
        var headingBold = false
        if (line.startsWith("#")) {
            val hashes = line.takeWhile { it == '#' }.length
            val rest = line.substring(hashes)
            if (hashes <= MAX_HEADING_LEVEL && rest.startsWith(" ")) {
                line = rest.trimStart(' ')
                headingBold = true
            }
        }
        var prefix = ""
        if (line.startsWith("- ") || line.startsWith("* ")) {
            prefix = "• "
            line = line.substring(2)
        }
        return LineParser(line, headingBold).parse(prefix)
    }

    /** One line's runs, walked character by character. */
    private class LineParser(private val line: String, private val headingBold: Boolean) {
        private val runs = mutableListOf<Run>()
        private val buffer = StringBuilder()
        private var bold = false

        fun parse(prefix: String): List<Run> {
            if (prefix.isNotEmpty()) runs += Run.Text(prefix, bold = false)
            var i = 0
            while (i < line.length) {
                i = step(i)
            }
            flush()
            return runs
        }

        /** Consume what starts at [i] and return where the next thing starts. */
        private fun step(i: Int): Int {
            val c = line[i]
            if (c == '*' && i + 1 < line.length && line[i + 1] == '*' &&
                (bold || hasClosingMarker(after = i + 2))
            ) {
                flush()
                bold = !bold
                return i + 2
            }
            if (c == '[') {
                val close = line.indexOf(']', startIndex = i + 1)
                if (close >= 0) {
                    val inside = line.substring(i + 1, close)
                    val ms = milliseconds(inside)
                    if (ms != null) {
                        flush()
                        runs += Run.Timestamp(ms, inside)
                        return close + 1
                    }
                }
            }
            buffer.append(c)
            return i + 1
        }

        /**
         * Whether a later `**` exists to close an opening one — an unclosed marker
         * is literal text, not bold-to-the-end-of-the-line.
         */
        private fun hasClosingMarker(after: Int): Boolean = line.indexOf("**", startIndex = after) >= 0

        private fun flush() {
            if (buffer.isEmpty()) return
            runs += Run.Text(buffer.toString(), bold = bold || headingBold)
            buffer.clear()
        }
    }

    /**
     * Merges adjacent text runs of the same weight, so a caller building one
     * styled string per paragraph does not have to.
     */
    private fun append(run: Run, runs: MutableList<Run>) {
        val last = runs.lastOrNull()
        if (run is Run.Text && last is Run.Text && last.bold == run.bold) {
            runs[runs.lastIndex] = Run.Text(last.text + run.text, run.bold)
        } else {
            runs += run
        }
    }

    /**
     * Swift's `CharacterSet.whitespaces`: tab and the Unicode space separators,
     * and deliberately not line breaks — a line holding only a stray `\r` is
     * not blank there, so it is not blank here either.
     */
    private fun isHorizontalSpace(c: Char): Boolean =
        c == '\t' || Character.getType(c) == Character.SPACE_SEPARATOR.toInt()

    private const val MAX_HEADING_LEVEL = 6
    private const val SECONDS_PER_MINUTE = 60L
    private const val MS_PER_SECOND = 1_000L
}

/**
 * Which turn of a transcript a moment on the recording belongs to — the
 * question a timestamp in the summary and a finding's 💡 line both ask before
 * they can take the reader somewhere. iOS `TranscriptAnchor`.
 *
 * Works on the turns' start times rather than on a segment type, because the
 * app holds its transcript as the cloud DTO and the tests as [TranscriptSegment];
 * the answer is an index into whichever list the caller passed.
 */
object TranscriptAnchor {

    /**
     * How far past the moment a turn may start and still count as "at" it.
     *
     * A brief writes `[0:08]` for a turn that starts at 8.9 s: clocks are
     * floored to the second on the way into prose. Without the slack the
     * timestamp would land on the turn *before* — the tail of somebody else's
     * sentence.
     */
    const val SLACK_MS: Long = 999L

    /**
     * The last turn that has started by [ms] (with [SLACK_MS]), or the first
     * turn when the moment is before all of them. -1 only for no turns.
     */
    fun turnIndex(ms: Long, startsMs: List<Long>): Int {
        var found = -1
        for ((index, start) in startsMs.withIndex()) {
            if (start <= ms + SLACK_MS) found = index else break
        }
        return if (found >= 0) found else if (startsMs.isEmpty()) -1 else 0
    }

    /** [turnIndex] over segments. */
    fun turn(ms: Long, segments: List<TranscriptSegment>): TranscriptSegment? =
        segments.getOrNull(turnIndex(ms, segments.map { it.startMs }))

    /**
     * Where playback should go for a jump to [ms]: the turn's own start when the
     * moment was a floored clock for it, so the reader hears the sentence from
     * its first word; [ms] itself otherwise.
     */
    fun seekMs(ms: Long, startsMs: List<Long>): Long {
        val start = startsMs.getOrNull(turnIndex(ms, startsMs)) ?: return ms
        return if (start > ms) start else ms
    }
}
