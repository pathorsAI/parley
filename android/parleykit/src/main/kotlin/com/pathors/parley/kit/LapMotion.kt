package com.pathors.parley.kit

import kotlin.math.PI
import kotlin.math.floor
import kotlin.math.pow

/**
 * Every number the onboarding lap moves by, in one place. A port of iOS
 * `ParleyKit/LapMotion.swift`.
 *
 * The lap's motion is a handful of small moments — the welcome demo playing
 * through its beats, the suggestion card arriving and flying into its folder, a replay
 * ripple on the waveform, the finish — and each of them used to be the kind of
 * constant that gets re-typed slightly differently in every view. Here they are
 * one namespace: durations between 0.4 and 0.7 s, and the welcome demo's beat
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
     * The constants are referred to as `WelcomeSchedule.X` inside the class,
     * so it reads plainly which schedule a number belongs to.
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
     * The spring's stiffness for a unit mass: SwiftUI's response is the
     * undamped period, so the stiffness is (2π / response)².
     */
    val springStiffness: Double
        get() = (2 * PI / SPRING_RESPONSE).pow(2)

    /** The first [count] characters of [text] — what a typed line shows. */
    fun typed(text: String, count: Int): String = text.take(maxOf(0, count))
}
