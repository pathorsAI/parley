package com.pathors.parley.kit

import kotlin.math.PI
import kotlin.math.floor
import kotlin.math.pow

/**
 * Every number the onboarding lap moves by, in one place. A port of iOS
 * `ParleyKit/LapMotion.swift`.
 *
 * The lap's motion is a handful of small moments — the sign-in page assembling
 * itself, the suggestion card arriving and flying into its folder, a replay
 * ripple on the waveform, the finish — and each of them used to be the kind of
 * constant that gets re-typed slightly differently in every view. Here they are
 * one namespace: durations between 0.4 and 0.7 s, and the sign-in page's beat
 * schedule, which is pure arithmetic and therefore tested rather than tuned by
 * eye on a device.
 *
 * All times are seconds, as on iOS, so the two schedules can be compared number
 * for number. "Remove animations" is honoured at every call site by skipping to
 * the final state; nothing here plays on its own.
 */
object LapMotion {
    /**
     * The one spring every lap moment moves on: iOS `.spring(response: 0.5,
     * dampingFraction: 0.8)`. Compose takes a stiffness rather than a response —
     * see [springStiffness].
     */
    const val SPRING_RESPONSE: Double = 0.5
    const val SPRING_DAMPING: Double = 0.8

    /** One character of a typed line. */
    const val PER_CHARACTER: Double = 0.022

    /** The ✓ lines of the finished lap, one after another. */
    const val CASCADE_STEP: Double = 0.26

    /** The waveform playhead gliding to a tapped turn, and the ring under it. */
    const val PLAYHEAD_GLIDE: Double = 0.5
    const val RIPPLE: Double = 0.7

    /** The single burst at the end of the lap. */
    const val CONFETTI_PIECES: Int = 26
    const val CONFETTI_DURATION: Double = 1.5

    /**
     * "Walk through it with the sample recording": how long the checklist's
     * header says "Transcribing…" before the sample opens (desktop
     * `TranscribingPulse`, iOS `LibraryView.walkThroughSample`).
     */
    const val TRANSCRIBING_BEAT: Double = 1.5

    /** How long one half of the recording dot's blink lasts. */
    const val DOT_BLINK: Double = 0.6

    /** How long the folder row stays washed in the tint once the card lands. */
    const val FOLDER_FLASH: Double = 0.6

    /** The share mark fades in this long before it lights. */
    const val SHARE_LEAD_IN: Double = 0.3

    /**
     * The four beats of the sign-in page's little film, in order: a recording
     * starts, it becomes text, it lands in a customer's folder, it goes to an
     * AI. The same four beats as the lap itself.
     */
    enum class IntroBeat { RECORDING, TRANSCRIPT, FOLDER, SHARE }

    data class IntroLine(
        /** When the first character appears. */
        val start: Double,
        /** When the last one has. */
        val typed: Double,
        /** When the speaker's name fades in — just after the line is typed. */
        val name: Double,
        val length: Int,
    )

    /** When everything on the sign-in page happens, from the moment it appears. */
    data class IntroSchedule(
        val recording: Double,
        val lines: List<IntroLine>,
        val folder: Double,
        /** The suggestion card flies into the folder row. */
        val cardFly: Double,
        val share: Double,
        /** Rest: the final state, held. */
        val end: Double,
    ) {

        /** The beat the stage is on at [t] — which caption is showing — or null before the first. */
        fun beat(t: Double): IntroBeat? {
            val first = lines.firstOrNull()
            return when {
                t >= share -> IntroBeat.SHARE
                t >= folder -> IntroBeat.FOLDER
                first != null && t >= first.start -> IntroBeat.TRANSCRIPT
                t >= recording -> IntroBeat.RECORDING
                else -> null
            }
        }

        /** How many characters of line [index] are showing at [t]. */
        fun typedCount(index: Int, t: Double): Int {
            val line = lines.getOrNull(index) ?: return 0
            if (t < line.start) return 0
            val count = floor((t - line.start) / PER_CHARACTER).toInt() + 1
            return minOf(line.length, count)
        }

        /** Whether line [index]'s speaker name is showing at [t]. */
        fun nameShown(index: Int, t: Double): Boolean {
            val line = lines.getOrNull(index) ?: return false
            return t >= line.name
        }

        /**
         * Whether the recording dot is lit at [t]: it blinks while the film
         * plays and rests lit.
         */
        fun dotLit(t: Double): Boolean {
            if (t >= end) return true
            val half = floor((t - recording) / DOT_BLINK).toInt()
            return half % 2 == 0
        }

        /** Whether the folder row is washed in the tint at [t] — the moment the card lands in it. */
        fun folderFlashing(t: Double): Boolean = t >= cardFly && t < cardFly + FOLDER_FLASH

        /** Whether the share mark is on the stage at [t], lit or not yet. */
        fun shareShown(t: Double): Boolean = t >= share - SHARE_LEAD_IN
    }

    /**
     * The schedule for transcript lines of these lengths (in characters). About
     * seven seconds for three clipped lines.
     */
    fun introBeats(lineLengths: List<Int>): IntroSchedule {
        val recording = 0.3
        var cursor = 1.4
        val lines = ArrayList<IntroLine>(lineLengths.size)
        for (length in lineLengths) {
            val start = cursor
            val typed = start + maxOf(0, length - 1) * PER_CHARACTER
            lines += IntroLine(start = start, typed = typed, name = typed + NAME_DELAY, length = length)
            cursor = typed + LINE_GAP
        }
        val folder = (lines.lastOrNull()?.typed ?: cursor) + 0.5
        val cardFly = folder + 0.6
        val share = cardFly + 1.0
        return IntroSchedule(
            recording = recording,
            lines = lines,
            folder = folder,
            cardFly = cardFly,
            share = share,
            end = share + 0.7,
        )
    }

    // ── the welcome demo ─────────────────────────────────────────────────────

    /**
     * The welcome screen's demo, beat for beat the desktop's
     * (`src/components/onboarding/IntroStage.tsx`) and iOS
     * `LapMotion.WelcomeBeat`: the four steps land as a row and hold, then a
     * recording starts, two transcript lines type with their speakers, a
     * recording flies into a customer folder, and the meeting ends on its
     * report while the MCP plug lights. It rests on its final frame ([READY]).
     * Declared in order, so `ordinal` and `compareTo` follow the film.
     */
    enum class WelcomeBeat {
        OVERVIEW, RECORD, TRANSCRIPT, FOLDER, MCP, READY;

        companion object {
            /** The four that are steps in the row; [OVERVIEW] and [READY] are not. */
            val STEPS: List<WelcomeBeat> = listOf(RECORD, TRANSCRIPT, FOLDER, MCP)
        }
    }

    /**
     * When everything in the welcome demo happens, in seconds from the start of
     * a run — the desktop's constants converted from milliseconds, iOS
     * `LapMotion.WelcomeSchedule`. Only the transcript's typing depends on the
     * content: [lineLengths] are the transcript lines' lengths in characters.
     *
     * The constants are referred to as `WelcomeSchedule.X` inside the class so
     * none of them can resolve to [LapMotion]'s own (it has a private
     * `LINE_GAP` of its own, for the old sign-in film).
     */
    class WelcomeSchedule(val lineLengths: List<Int>) {

        /**
         * How fast the transcript types — never slower than [PER_CHARACTER],
         * faster when the lines would overrun [TRANSCRIPT_BUDGET].
         */
        val secondsPerCharacter: Double

        /** Each transcript line's first character, from the start of the run. */
        val lineStarts: List<Double>

        init {
            val chars = lineLengths.sum()
            val gaps = WelcomeSchedule.LINE_GAP * maxOf(0, lineLengths.size - 1)
            val rate = if (chars > 0) {
                minOf(PER_CHARACTER, maxOf(0.001, (WelcomeSchedule.TRANSCRIPT_BUDGET - gaps) / chars))
            } else {
                PER_CHARACTER
            }
            val starts = ArrayList<Double>(lineLengths.size)
            var cursor = start(WelcomeBeat.TRANSCRIPT)
            for (length in lineLengths) {
                starts += cursor
                cursor += length * rate + WelcomeSchedule.LINE_GAP
            }
            secondsPerCharacter = rate
            lineStarts = starts
        }

        /** The rest frame. */
        val end: Double get() = start(WelcomeBeat.READY)

        /** The beat at [t]: the latest one that has started. */
        fun beat(t: Double): WelcomeBeat =
            WelcomeBeat.entries.lastOrNull { t >= start(it) } ?: WelcomeBeat.OVERVIEW

        /**
         * How far step [beat]'s bar has filled at [t], 0…1: empty before it,
         * filling linearly over its own length, full after.
         */
        fun fill(beat: WelcomeBeat, t: Double): Double {
            val next = WelcomeBeat.entries.getOrNull(beat.ordinal + 1)
                ?: return if (t >= end) 1.0 else 0.0
            val from = start(beat)
            val span = start(next) - from
            return minOf(1.0, maxOf(0.0, (t - from) / span))
        }

        /** How many characters of transcript line [line] show at [t]. */
        fun typedCount(line: Int, t: Double): Int {
            val lineStart = lineStarts.getOrNull(line) ?: return 0
            val elapsed = t - lineStart
            if (elapsed <= 0.0) return 0
            return minOf(lineLengths[line], floor(elapsed / secondsPerCharacter).toInt())
        }

        /** The speaker's name shows once the whole line is in. */
        fun lineDone(index: Int, t: Double): Boolean =
            index in lineLengths.indices && typedCount(index, t) >= lineLengths[index]

        /** The recording card: on screen, flying, or filed into the folder. */
        enum class Card { HIDDEN, SHOWN, FLYING, FILED }

        fun card(t: Double): Card {
            val folder = start(WelcomeBeat.FOLDER)
            return when {
                t < folder + WelcomeSchedule.CARD_IN -> Card.HIDDEN
                t < folder + WelcomeSchedule.CARD_FLY_AT -> Card.SHOWN
                t < folder + WelcomeSchedule.CARD_FLY_AT + WelcomeSchedule.CARD_FLY -> Card.FLYING
                else -> Card.FILED
            }
        }

        /** The folder row flashes once as the card lands. */
        fun folderFlashing(t: Double): Boolean {
            val landed = start(WelcomeBeat.FOLDER) + WelcomeSchedule.CARD_FLY_AT + WelcomeSchedule.CARD_FLY
            return t >= landed && t < landed + WelcomeSchedule.LANDED_FLASH
        }

        fun plugLit(t: Double): Boolean = t >= start(WelcomeBeat.MCP) + WelcomeSchedule.PLUG_LIGHT

        /** How many of the report's [total] lines are in at [t]. */
        fun reportLines(total: Int, t: Double): Int {
            val elapsed = t - start(WelcomeBeat.MCP) - WelcomeSchedule.REPORT_LINE_AT
            if (elapsed < 0.0) return 0
            return minOf(total, floor(elapsed / WelcomeSchedule.REPORT_LINE_STAGGER).toInt() + 1)
        }

        /** When report line [index] arrives, for its own rise. */
        fun reportLineStart(index: Int): Double =
            start(WelcomeBeat.MCP) + WelcomeSchedule.REPORT_LINE_AT + index * WelcomeSchedule.REPORT_LINE_STAGGER

        companion object {
            /** `INTRO_BEATS`: each beat's start. */
            val BEAT_STARTS: Map<WelcomeBeat, Double> = mapOf(
                WelcomeBeat.OVERVIEW to 0.0,
                WelcomeBeat.RECORD to 1.8,
                WelcomeBeat.TRANSCRIPT to 3.4,
                WelcomeBeat.FOLDER to 6.4,
                WelcomeBeat.MCP to 8.3,
                WelcomeBeat.READY to 11.0,
            )

            /** The transcript's typing budget and the pause between its lines. */
            const val TRANSCRIPT_BUDGET: Double = 2.4
            const val LINE_GAP: Double = 0.24

            /** Inside the folder beat: the recording card shows, then flies. */
            const val CARD_IN: Double = 0.225
            const val CARD_FLY_AT: Double = 0.75
            const val CARD_FLY: Double = 0.9

            /** How long the folder row flashes once the card has landed (a literal 0.5 on iOS). */
            const val LANDED_FLASH: Double = 0.5

            /** Inside the MCP beat: the plug lights, the report's lines arrive. */
            const val PLUG_LIGHT: Double = 0.3
            const val REPORT_LINE_AT: Double = 0.35
            const val REPORT_LINE_STAGGER: Double = 0.3

            /** The overview row: each step lands this long after the one before. */
            const val OVERVIEW_STAGGER: Double = 0.135

            fun start(beat: WelcomeBeat): Double = BEAT_STARTS[beat] ?: 0.0

            /** When step [index] of the overview row lands. */
            fun overviewLanding(index: Int): Double = index * OVERVIEW_STAGGER
        }
    }

    /**
     * A transcript line cut to what fits the stage: the first sentence if it is
     * short enough, else [limit] characters and an ellipsis.
     */
    fun clip(line: String, limit: Int = CLIP_LIMIT): String {
        val text = line.trim()
        val end = text.indexOfFirst { it in SENTENCE_ENDERS }
        if (end in 0 until limit) return text.substring(0, end + 1)
        if (text.length <= limit) return text
        return text.take(limit).trim() + "…"
    }

    /**
     * The spring's stiffness for a unit mass: SwiftUI's response is the
     * undamped period, so the stiffness is (2π / response)².
     */
    val springStiffness: Double
        get() = (2 * PI / SPRING_RESPONSE).pow(2)

    /** The first [count] characters of [text] — what a typed line shows. */
    fun typed(text: String, count: Int): String = text.take(maxOf(0, count))

    private const val NAME_DELAY = 0.05
    private const val LINE_GAP = 0.35
    private const val CLIP_LIMIT = 34
    private val SENTENCE_ENDERS = setOf('。', '？', '！', '.', '?', '!')
}
