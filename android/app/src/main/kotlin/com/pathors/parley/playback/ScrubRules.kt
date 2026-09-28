package com.pathors.parley.playback

import androidx.annotation.StringRes
import com.pathors.parley.R
import kotlin.math.abs
import kotlin.math.ceil

/**
 * The arithmetic behind the waveform's scrub, kept out of the composable so it
 * can be pinned by tests rather than tuned by eye on a device.
 *
 * ## YouTube's drag-away-for-precision, as iOS does it
 *
 * A 360dp-wide bar over a 40-minute meeting is about seven seconds per dp, so a
 * one-finger-width correction is a minute. Moving the finger away from the bar
 * while still dragging makes the drag finer: three tiers, and the *scale* of the
 * horizontal movement changes rather than the position jumping.
 *
 * Two things are load-bearing, both straight from iOS `ScrubbableWaveform`:
 *
 * - The time is **accumulated** from each move's horizontal delta, never
 *   recomputed from where the finger went down. Recomputing would mean that
 *   crossing into the ¼ tier snaps the playhead back to a quarter of where it
 *   was.
 * - The tier comes from the **absolute** vertical distance. The player is
 *   pinned under the top bar, where there is no room to drag upwards, so down
 *   counts as much as up.
 */
internal object ScrubRules {

    /**
     * One precision tier: how far from the touch-down point (vertically, in dp)
     * it starts, what it multiplies the horizontal movement by, and what the
     * floating label calls it (null for the plain tier, which says nothing).
     */
    data class Tier(val distanceDp: Float, val scale: Double, @StringRes val label: Int?)

    val TIERS: List<Tier> = listOf(
        Tier(distanceDp = 0f, scale = 1.0, label = null),
        Tier(distanceDp = 40f, scale = 0.25, label = R.string.playback_scrub_fine),
        Tier(distanceDp = 90f, scale = 1.0 / 16, label = R.string.playback_scrub_finer),
    )

    /** The tier for a finger [verticalTravelDp] above or below where it went down. */
    fun tierFor(verticalTravelDp: Float): Int {
        val distance = abs(verticalTravelDp)
        var tier = 0
        TIERS.forEachIndexed { index, entry -> if (distance >= entry.distanceDp) tier = index }
        return tier
    }

    /**
     * The scrub time after the finger moved [deltaPx] horizontally in [tier].
     *
     * Full width is the full duration at 1×; the result is clamped to the file.
     * A double, not a Long: at 1/16 a single move can be a few milliseconds, and
     * rounding every step would drift the accumulated time.
     */
    fun advance(
        timeMs: Double,
        deltaPx: Float,
        widthPx: Float,
        durationMs: Long,
        tier: Int,
    ): Double {
        if (widthPx <= 0f || durationMs <= 0L) return timeMs
        val msPerPx = durationMs / widthPx.toDouble()
        val scale = TIERS[tier.coerceIn(0, TIERS.lastIndex)].scale
        return (timeMs + deltaPx * msPerPx * scale).coerceIn(0.0, durationMs.toDouble())
    }

    /**
     * Where the floating time pill goes: centred over the finger, above it by
     * [gapPx], clamped inside the strip. The strip is pinned under the top bar,
     * so a pill that floated freely above the finger would end up behind it.
     *
     * Returns (x, y) of the pill's top-left corner.
     */
    fun pillOffset(
        fingerX: Float,
        fingerY: Float,
        pillWidth: Float,
        pillHeight: Float,
        stripWidth: Float,
        stripHeight: Float,
        gapPx: Float,
    ): Pair<Float, Float> {
        val x = (fingerX - pillWidth / 2f).coerceIn(0f, (stripWidth - pillWidth).coerceAtLeast(0f))
        val y = (fingerY - pillHeight - gapPx).coerceIn(0f, (stripHeight - pillHeight).coerceAtLeast(0f))
        return x to y
    }

    /** One TalkBack adjustment: 15 s, the step every podcast player uses (and iOS). */
    const val ACCESSIBILITY_STEP_SECONDS = 15

    /**
     * The accessibility range for a file of [durationMs], in seconds, and its
     * step count.
     *
     * Compose turns a swipe up or down on a node with `progressBarRangeInfo` and
     * `setProgress` into `current ± range / (steps + 1)`. Rounding the range up
     * to a whole number of 15 s steps is what makes that increment exactly 15 s;
     * a target past the end is clamped by the seek.
     */
    fun accessibilityRange(durationMs: Long): AccessibilityRange {
        val seconds = (durationMs.coerceAtLeast(0L) / 1000.0)
        val steps = ceil(seconds / ACCESSIBILITY_STEP_SECONDS).toInt().coerceAtLeast(1)
        return AccessibilityRange(
            endSeconds = (steps * ACCESSIBILITY_STEP_SECONDS).toFloat(),
            steps = steps - 1,
        )
    }

    data class AccessibilityRange(val endSeconds: Float, val steps: Int)
}

/**
 * The speeds, and the two rules that move between them. iOS
 * `PlaybackController.cycle` / `.menu` / `cycleRate` / the persisted
 * `playbackRate`, number for number.
 */
internal object PlaybackRates {

    /** What a tap on the speed steps through. */
    val CYCLE: List<Float> = listOf(1f, 1.25f, 1.5f, 2f)

    /** What the long-press menu offers. */
    val MENU: List<Float> = listOf(0.75f, 1f, 1.25f, 1.5f, 1.75f, 2f)

    private const val EPSILON = 0.001f

    /**
     * The next speed a tap steps to. Off-cycle speeds chosen from the menu
     * (0.75×, 1.75×) step to the next one *above* them rather than restarting
     * at 1×, so a tap after a menu choice is still a nudge forwards; 2× wraps.
     */
    fun next(rate: Float): Float = CYCLE.firstOrNull { it > rate + EPSILON } ?: CYCLE.first()

    /** A stored speed, or 1× when nothing — or nothing in the menu — was stored. */
    fun restore(saved: Float?): Float =
        MENU.firstOrNull { saved != null && abs(it - saved) < EPSILON } ?: 1f

    /** [rate] snapped to the nearest menu speed, so only menu speeds are ever stored. */
    fun snap(rate: Float): Float = MENU.minBy { abs(it - rate) }
}
