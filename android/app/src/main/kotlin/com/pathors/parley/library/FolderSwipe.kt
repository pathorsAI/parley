package com.pathors.parley.library

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import kotlin.math.abs

/**
 * Whether a finger that went down and came up on the library was a swipe to
 * the neighbouring folder page, kept apart from the screen so the rule can be
 * tested without one.
 *
 * The rule is iOS's, so the two platforms agree on what a thumb does:
 *
 * - **Only from blank space.** A swipe that starts on a recording card is the
 *   card's — iOS hangs its swipe actions there — and never turns the page. The
 *   gaps between cards, the space under the last one and an empty page are
 *   all fair game.
 * - **Deliberate and sideways.** Far enough to not be a wobbly tap, and
 *   clearly more across than down, so a scroll that drifts never flips pages
 *   under the reader.
 * - **The row's direction.** Swiping towards the start brings in the next chip
 *   from the end, as a pager would; in a right-to-left layout that mirrors.
 */
object FolderSwipe {

    /** How much further across than down a swipe has to travel. */
    const val DOMINANCE = 1.5f

    /** Whose a gesture in progress is, as far as the library can tell yet. */
    enum class Claim {
        /** Still inside the touch slop: a tap, a long press or anything else. */
        UNDECIDED,

        /** Sideways: the swipe's, and the taps and presses under it are off. */
        SWIPE,

        /** Down (or a slant): the list's scroll, and never touched again. */
        NOT_OURS,
    }

    /**
     * What a finger that has moved [translation] from where it went down is,
     * decided once — the first time it is past [touchSlop], the distance the
     * platform uses to tell a tap from a drag. Sideways by [DOMINANCE] claims
     * it, wherever it started, so a swipe across a card does not open the card
     * on the way up; anything else is the list's, and stays the list's even if
     * it turns sideways later, so a scroll is never cut off halfway.
     */
    fun claim(translation: Offset, touchSlop: Float): Claim = when {
        translation.getDistance() <= touchSlop -> Claim.UNDECIDED
        abs(translation.x) > DOMINANCE * abs(translation.y) -> Claim.SWIPE
        else -> Claim.NOT_OURS
    }

    /**
     * -1 for the previous page, +1 for the next, 0 for "not a page swipe".
     *
     * [start] is where the finger went down and [translation] how far it had
     * moved when it lifted, both in the list's coordinates; [cards] are the
     * recording cards' bounds in the same space at the moment it went down.
     * [minDistance] is in the same units — pixels, in practice.
     */
    fun step(
        start: Offset,
        translation: Offset,
        cards: Collection<Rect>,
        minDistance: Float,
        rtl: Boolean = false,
    ): Int {
        val dx = translation.x
        if (abs(dx) < minDistance) return 0
        if (abs(dx) <= DOMINANCE * abs(translation.y)) return 0
        if (cards.any { it.contains(start) }) return 0
        val towardsStart = if (rtl) dx > 0 else dx < 0
        return if (towardsStart) 1 else -1
    }
}
