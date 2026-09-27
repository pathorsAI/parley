package com.pathors.parley.ui

/**
 * The geometry of the live meeting's resizable controls panel, kept apart from
 * the composable so it can be tested without Compose.
 *
 * While a meeting records, the user can drag the top edge of the controls down
 * to give the live transcript more room, and the panel stays wherever they let
 * go — continuous, no fixed detents, snapping only near the two ends. As it
 * shrinks, the secondary pieces leave in a fixed order: Discard first, then the
 * recording status row, then the status line, then the level meter. The timer
 * and the stop button shrink continuously, and near the bottom the whole column
 * crossfades into a single compact row.
 *
 * Discard goes first on purpose. It is the one destructive control on the
 * screen, and a panel the user has half-collapsed is one they are dragging with
 * a thumb — so it only exists when the panel is fully open.
 *
 * All lengths are dp; the height of a fully open panel is whatever its content
 * measures ([fullDp] below), because that grows and shrinks with font scale and
 * with the warnings on screen. The thresholds come from the HTML prototype the
 * design was picked from (full 350, compact 88) and are kept as *progress* along
 * compact…full, so they scale with the real height.
 */
internal object LivePanel {

    /** The collapsed panel: the grabber and one row. */
    const val COMPACT_DP = 88f

    /** Let go this close to compact and the panel settles there. */
    const val SNAP_TO_COMPACT_DP = 40f

    /** Let go this close to full and the panel opens fully (and Discard comes back). */
    const val SNAP_TO_FULL_DP = 24f

    /** How far past either end a drag can stretch the panel, however hard it pulls. */
    const val RUBBER_BAND_LIMIT_DP = 32f

    private const val RUBBER_BAND_STIFFNESS = 0.55f

    const val TIMER_FULL_SP = 56f
    const val TIMER_SMALLEST_SP = 34f
    const val TIMER_ROW_SP = 22f

    const val STOP_FULL_DP = 72f
    const val STOP_SMALLEST_DP = 56f

    /** The compact row's stop button — still a full touch target. */
    const val STOP_ROW_DP = 48f

    private const val PROTOTYPE_FULL_DP = 350f

    /** A height in the prototype, as progress along its compact…full range. */
    private fun prototype(heightDp: Float): Float =
        (heightDp - COMPACT_DP) / (PROTOTYPE_FULL_DP - COMPACT_DP)

    val DISCARD_FROM = prototype(330f)
    val STATUS_ROW_FROM = prototype(285f)
    val STATUS_LINE_FROM = prototype(250f)
    val LEVEL_METER_FROM = prototype(215f)

    /** The full column is opaque at and above this, gone at and below [COLUMN_GONE_AT]. */
    val COLUMN_OPAQUE_FROM = prototype(190f)
    val COLUMN_GONE_AT = prototype(160f)

    /** The compact row is gone at and above this, opaque at and below [ROW_OPAQUE_AT]. */
    val ROW_GONE_FROM = prototype(175f)
    val ROW_OPAQUE_AT = prototype(145f)

    /** The panel height for a stored [fraction] (0 compact … 1 full). */
    fun heightDp(fraction: Float, fullDp: Float): Float {
        if (fullDp <= COMPACT_DP) return fullDp
        return COMPACT_DP + fraction * (fullDp - COMPACT_DP)
    }

    /** The inverse of [heightDp]; not clamped, so a rubber-banded height reads past 0 or 1. */
    fun fraction(heightDp: Float, fullDp: Float): Float {
        if (fullDp <= COMPACT_DP) return 1f
        return (heightDp - COMPACT_DP) / (fullDp - COMPACT_DP)
    }

    /**
     * The height to draw while the finger is at [rawDp]: the finger itself
     * inside compact…full, and a resisting stretch past either end that never
     * exceeds [RUBBER_BAND_LIMIT_DP].
     */
    fun rubberBand(rawDp: Float, fullDp: Float): Float {
        val low = minOf(COMPACT_DP, fullDp)
        return when {
            rawDp > fullDp -> fullDp + resist(rawDp - fullDp)
            rawDp < low -> low - resist(low - rawDp)
            else -> rawDp
        }
    }

    private fun resist(overshootDp: Float): Float =
        RUBBER_BAND_LIMIT_DP *
            (1f - 1f / (overshootDp * RUBBER_BAND_STIFFNESS / RUBBER_BAND_LIMIT_DP + 1f))

    /**
     * Where the panel comes to rest when released at [heightDp], as a fraction:
     * exactly 1 near the top, exactly 0 near the bottom, and where it was let go
     * everywhere in between. Full wins when a very short panel puts both ends in
     * range.
     */
    fun restingFraction(heightDp: Float, fullDp: Float): Float = when {
        fullDp <= COMPACT_DP -> 1f
        heightDp >= fullDp - SNAP_TO_FULL_DP -> 1f
        heightDp <= COMPACT_DP + SNAP_TO_COMPACT_DP -> 0f
        else -> fraction(heightDp, fullDp).coerceIn(0f, 1f)
    }

    /** A tap on the grabber: an open panel collapses, anything else opens fully. */
    fun toggledFraction(fraction: Float): Float = if (fraction >= FULLY_OPEN) 0f else 1f

    /** Whether [fraction] counts as fully open (what a tap on the grabber collapses). */
    fun isFullyOpen(fraction: Float): Boolean = fraction >= FULLY_OPEN

    /** Whether [fraction] counts as fully collapsed. */
    fun isCompact(fraction: Float): Boolean = fraction <= 1f - FULLY_OPEN

    private const val FULLY_OPEN = 0.999f

    /** What to draw at [heightDp] when the open panel measures [fullDp]. */
    fun shape(heightDp: Float, fullDp: Float): LivePanelShape {
        val progress = fraction(heightDp, fullDp)
        val t = progress.coerceIn(0f, 1f)
        return LivePanelShape(
            progress = t,
            showsDiscard = progress >= DISCARD_FROM,
            showsStatusRow = progress >= STATUS_ROW_FROM,
            showsStatusLine = progress >= STATUS_LINE_FROM,
            showsLevelMeter = progress >= LEVEL_METER_FROM,
            timerSp = lerp(TIMER_SMALLEST_SP, TIMER_FULL_SP, t),
            stopDp = lerp(STOP_SMALLEST_DP, STOP_FULL_DP, t),
            columnAlpha = ramp(progress, from = COLUMN_GONE_AT, to = COLUMN_OPAQUE_FROM),
            rowAlpha = ramp(progress, from = ROW_GONE_FROM, to = ROW_OPAQUE_AT),
        )
    }

    private fun lerp(start: Float, stop: Float, t: Float): Float = start + (stop - start) * t

    /** 0 at [from], 1 at [to], linear between; works in either direction. */
    private fun ramp(value: Float, from: Float, to: Float): Float =
        ((value - from) / (to - from)).coerceIn(0f, 1f)
}

/**
 * One frame of the panel.
 *
 * @property progress 0 compact … 1 full, clamped.
 * @property timerSp the full column's timer size; the compact row uses [LivePanel.TIMER_ROW_SP].
 * @property stopDp the full column's stop button diameter.
 * @property columnAlpha opacity of the full column; not drawn at all when 0.
 * @property rowAlpha opacity of the compact row; not drawn at all when 0.
 */
internal data class LivePanelShape(
    val progress: Float,
    val showsDiscard: Boolean,
    val showsStatusRow: Boolean,
    val showsStatusLine: Boolean,
    val showsLevelMeter: Boolean,
    val timerSp: Float,
    val stopDp: Float,
    val columnAlpha: Float,
    val rowAlpha: Float,
)
