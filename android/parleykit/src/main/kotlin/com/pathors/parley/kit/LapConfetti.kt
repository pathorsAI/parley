package com.pathors.parley.kit

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sin

/**
 * The one burst at the end of the guided lap, as arithmetic: where each of the
 * [LapMotion.CONFETTI_PIECES] pieces is at a moment of the
 * [LapMotion.CONFETTI_DURATION]. iOS `ConfettiBurst` (`LapMotionViews.swift`),
 * number for number.
 *
 * Small rectangles thrown up from the bottom centre in a fan of about 120°,
 * falling back and fading. Deterministic — each piece comes from its index,
 * not a random source — so the same frame looks the same every time, and after
 * the duration there is nothing left to draw. Kept apart from the drawing so a
 * test can hold it to that.
 */
object LapConfetti {

    /** One piece at one moment, in the burst's own coordinates (y grows downwards). */
    data class Piece(
        val x: Double,
        val y: Double,
        /** Radians. */
        val rotation: Double,
        val alpha: Double,
    )

    /** A piece's size: 4 × 7, centred on its position. */
    const val PIECE_WIDTH: Double = 4.0
    const val PIECE_HEIGHT: Double = 7.0

    /**
     * Every piece at [t] seconds into a burst drawn in a [width] × [height]
     * box, or an empty list once the burst is over.
     */
    fun pieces(t: Double, width: Double, height: Double): List<Piece> {
        if (t < 0 || t >= LapMotion.CONFETTI_DURATION) return emptyList()
        val progress = t / LapMotion.CONFETTI_DURATION
        val originX = width / 2
        val alpha = max(0.0, 1 - progress * progress)
        return (0 until LapMotion.CONFETTI_PIECES).map { i ->
            // Three independent pseudo-random draws per piece, from its
            // index: the fan's angle, a spread of speeds, a spread of start
            // points along the bottom.
            val angle = (FAN_START + FAN_WIDTH * unit(i, 1)) * PI / HALF_TURN
            val speed = MIN_SPEED + SPEED_SPREAD * unit(i, 2)
            val x = originX + (unit(i, 3) - 0.5) * width * 0.5 + cos(angle) * speed * t
            val y = height + sin(angle) * speed * t + GRAVITY * t * t
            Piece(x = x, y = y, rotation = t * (SPIN_BASE + i % SPIN_SPREAD), alpha = alpha)
        }
    }

    /** A stable number in 0 until 1 for piece [index], draw [salt]. */
    internal fun unit(index: Int, salt: Int): Double {
        var x = (index.toLong() * GOLDEN + salt.toLong() * SALT_STEP).toULong()
        x = x xor (x shr MIX_SHIFT)
        x *= MIX_MULTIPLIER
        x = x xor (x shr MIX_SHIFT)
        return (x % BUCKETS).toDouble() / BUCKETS.toDouble()
    }

    private const val FAN_START = -150.0
    private const val FAN_WIDTH = 120.0
    private const val HALF_TURN = 180.0
    private const val MIN_SPEED = 180.0
    private const val SPEED_SPREAD = 240.0
    private const val GRAVITY = 420.0
    private const val SPIN_BASE = 4.0
    private const val SPIN_SPREAD = 5

    private const val GOLDEN = 2_654_435_761L
    private const val SALT_STEP = 40_503L
    private const val MIX_SHIFT = 33
    private const val MIX_MULTIPLIER: ULong = 0xff51afd7ed558ccdUL
    private const val BUCKETS: ULong = 10_000UL
}
