package com.pathors.parley.kit

/**
 * Filler words — the desktop's `src/lib/analysis/fillerWords.ts`.
 *
 * Two different things share the name:
 *
 * - the LEXICAL crutch words (那個, 就是, "you know") the delivery pass is
 *   asked to judge for over-use — [watchlist], from `shared/prompts/study.json`;
 * - the non-lexical hesitation SOUNDS (um, uh, 嗯, 呃) the scorecard counts
 *   straight out of the transcript — [countFillerSounds].
 */
object FillerWords {

    /**
     * The crutch words for a UI language, its own list first and the other one
     * after (speakers code-switch), duplicates removed — `fillerWatchlist`.
     */
    fun watchlist(language: FilingLanguage): List<String> {
        val own = if (language == FilingLanguage.ZH_TW) StudyPrompts.FILLER_WORDS_ZH_TW else StudyPrompts.FILLER_WORDS_EN
        val other = if (language == FilingLanguage.ZH_TW) StudyPrompts.FILLER_WORDS_EN else StudyPrompts.FILLER_WORDS_ZH_TW
        return LinkedHashSet(own + other).toList()
    }

    /** Unambiguous Mandarin hesitation characters — a run of these is always filler. */
    private const val CJK_FILLER_CHARS = "嗯唔呃痾疴欸誒呣"

    /** Particles that read as hesitation only when repeated (啊啊 / 喔喔). */
    private const val CJK_PARTICLE_CHARS = "啊喔哦呀"

    /**
     * The Latin hesitation shapes, one per pattern, each anchored to a whole
     * word. The anchors are spelled out rather than `\b` because JavaScript's
     * `\b` (which the desktop uses) knows only ASCII word characters, while
     * Java's counts every letter — so "um嗯" is a boundary on the desktop and
     * would not be here.
     */
    private val LATIN_FILLER_SHAPES = listOf("u+m+", "u+h+", "uh+m+", "e+r+m*", "h+m+", "m+m+", "a+h+", "e+h+")

    private const val ASCII_WORD = "[A-Za-z0-9_]"

    private val PATTERNS: List<Regex> =
        LATIN_FILLER_SHAPES.map { Regex("(?<!$ASCII_WORD)(?:$it)(?!$ASCII_WORD)", RegexOption.IGNORE_CASE) } +
            Regex("[$CJK_FILLER_CHARS]+") +
            Regex("([$CJK_PARTICLE_CHARS])\\1+")

    /**
     * Hesitation sounds in a piece of transcript, a repeated run counting once
     * ("ummm", "嗯嗯嗯"). Language-agnostic, because a recognizer writes a
     * Mandarin 嗯 as "um" as often as not.
     */
    fun countFillerSounds(text: String): Int {
        if (text.isEmpty()) return 0
        return PATTERNS.sumOf { it.findAll(text).count() }
    }
}

/** The scorecard's numbers that need no model — `src/lib/analysis/delivery.ts`. */
object DeliveryStats {

    /** Syllables per second as the friendlier per-minute figure. */
    fun syllablesPerMin(hz: Double): Long = Math.round(hz * SECONDS_PER_MINUTE)

    /**
     * The user's share of the talking against everyone else, by the voiced
     * duration of final segments — only for a recording split by capture
     * source (`me` / `them`, a desktop recording). Null without evidence of
     * BOTH sides: a phone's diarized `mix` has no per-source "me", and a
     * one-sided tally is the absence of the far side, not a split.
     */
    fun talkTimeRatio(segments: List<TranscriptSegment>): Double? {
        var me = 0L
        var them = 0L
        for (s in segments) {
            if (!s.isFinal) continue
            val duration = (s.endMs - s.startMs).coerceAtLeast(0L)
            if (duration <= 0L) continue
            when (s.source) {
                "me" -> me += duration
                "them" -> them += duration
            }
        }
        if (me == 0L || them == 0L) return null
        return me.toDouble() / (me + them)
    }

    /** Hesitation sounds in the user's own (`me`) final lines — zero on a phone's `mix`. */
    fun fillerSounds(segments: List<TranscriptSegment>): Int =
        segments.filter { it.isFinal && it.source == "me" }.sumOf { FillerWords.countFillerSounds(it.text) }

    private const val SECONDS_PER_MINUTE = 60
}
