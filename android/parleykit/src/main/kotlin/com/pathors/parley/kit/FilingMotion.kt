package com.pathors.parley.kit

import java.text.BreakIterator
import kotlin.math.PI

/**
 * Every number the filing suggestion card moves by — the card's half of iOS
 * `LapMotion` (ParleyKit), kept in its own file because the intro film has
 * its own.
 *
 * The card has three small moments: it arrives on a spring, its proposed
 * title types itself in once, and an accepted suggestion flies into the
 * folder chip it was filed under, which pops. Each used to be the kind of
 * constant that gets re-typed slightly differently at every call site; here
 * they are one namespace, and the arithmetic in them is tested rather than
 * tuned by eye.
 *
 * The system's "Remove animations" setting is honoured at every call site by
 * skipping to the final state; nothing here plays on its own.
 */
object FilingMotion {

    /** iOS `LapMotion.springResponse`: the period of the undamped spring, in seconds. */
    const val SPRING_RESPONSE_S: Double = 0.5

    /** iOS `LapMotion.springDamping`. Compose calls it the damping ratio. */
    const val SPRING_DAMPING: Float = 0.8f

    /**
     * The same spring in Compose's terms: stiffness is `(2π / response)²` for
     * a unit mass, which is how SwiftUI's `spring(response:dampingFraction:)`
     * is defined.
     */
    val SPRING_STIFFNESS: Float = stiffnessFor(SPRING_RESPONSE_S)

    /** One character of the title typing itself in. iOS `LapMotion.perCharacter`. */
    const val PER_CHARACTER_MS: Long = 22L

    /** The card's entrance: from this far below where it sits… */
    const val ARRIVAL_OFFSET_DP: Float = 16f

    /** …and this much smaller. */
    const val ARRIVAL_SCALE: Float = 0.98f

    /** The flight from the title into the chip, before the chip pops. */
    const val FLY_MS: Long = 400L

    /** How long the chip holds its pop before settling back. */
    const val POP_MS: Long = 180L

    /** How far the chip swells when the card lands in it. */
    const val POP_SCALE: Float = 1.06f

    /** The ghost's opacity once it has arrived in the chip. */
    const val GHOST_LANDED_ALPHA: Float = 0.35f

    /** How long a guide's "look here" wash stays on the card. */
    const val WASH_MS: Long = 1_200L

    /** The wash's tint strength, as iOS draws it: the primary at 12 %. */
    const val WASH_ALPHA: Float = 0.12f

    /** SwiftUI's spring response → Compose stiffness, for a unit mass. */
    fun stiffnessFor(responseSeconds: Double): Float {
        val omega = 2 * PI / responseSeconds
        return (omega * omega).toFloat()
    }

    /**
     * How many user-perceived characters [text] has — grapheme clusters, as
     * Swift's `String.count` counts them, so an emoji or a flag types in as one
     * step rather than as its surrogate halves.
     */
    fun characterCount(text: String): Int {
        if (text.isEmpty()) return 0
        val breaks = BreakIterator.getCharacterInstance().apply { setText(text) }
        var count = 0
        while (breaks.next() != BreakIterator.DONE) count++
        return count
    }

    /**
     * The first [count] characters of [text] — what a typed line shows. iOS
     * `LapMotion.typed(_:count:)`. Never splits a grapheme cluster.
     */
    fun typed(text: String, count: Int): String {
        if (count <= 0) return ""
        val breaks = BreakIterator.getCharacterInstance().apply { setText(text) }
        var end = 0
        repeat(count) {
            val next = breaks.next()
            if (next == BreakIterator.DONE) return text
            end = next
        }
        return text.substring(0, end)
    }

    /** How long the whole title takes to type itself in. */
    fun typingDurationMs(text: String): Long = characterCount(text) * PER_CHARACTER_MS

    /**
     * The titles that have already typed themselves in this session — iOS
     * `LapMotion.typedTitles`. Process-wide on purpose: the card is redrawn on
     * every visit to the recording page and every rotation, and a title that
     * retyped itself each time would stop reading as Parley *writing* a name
     * and start reading as a loading effect.
     */
    val typedTitles: TypedTitles = TypedTitles()

    /** A set of titles, claimed once each. Thread-safe; composition is not the only caller. */
    class TypedTitles {
        private val seen = mutableSetOf<String>()

        /**
         * Whether [title] should type itself in now: true the first time it is
         * asked about, false ever after. Empty titles never type.
         */
        @Synchronized
        fun claim(title: String): Boolean = title.isNotEmpty() && seen.add(title)

        /** Whether [title] has already typed itself in. */
        @Synchronized
        fun contains(title: String): Boolean = title in seen

        /** For tests. */
        @Synchronized
        fun clear() = seen.clear()
    }
}
