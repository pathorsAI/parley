package com.pathors.parley.ui

import kotlin.math.PI
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * Every number that shapes the sign-in page's edge glow — iOS
 * `AuroraEdgeGlowTuning`, value for value, so the two platforms draw the same
 * light. Lengths are dp where iOS has points.
 *
 * The fields themselves (see [AuroraField]) are the approved prototype's
 * coefficients and live as literals in the shader and in [AuroraField]; they
 * are the design, not knobs. These are the knobs.
 */
internal object AuroraEdgeGlowTuning {
    /** The brand blue and the sky blue (the two `primary` values), as sRGB 0–1. */
    val BLUE = floatArrayOf(0x14 / 255f, 0x69 / 255f, 0xD4 / 255f)
    val SKY = floatArrayOf(0x2D / 255f, 0xB6 / 255f, 0xF3 / 255f)
    const val COLOUR_SEAM = 0.08f

    // Haze.
    const val HAZE_REACH = 8f
    const val HAZE_REACH_PER_I = 16f
    const val HAZE_BLUR = 14f
    const val HAZE_STRENGTH_DARK = 0.62f
    const val HAZE_STRENGTH_LIGHT = 0.36f

    // Core.
    const val CORE_WIDTH_MIN = 2f
    const val CORE_WIDTH_MAX = 7f
    const val CORE_BLUR = 2f
    const val CORE_STRENGTH_DARK = 0.95f
    const val CORE_STRENGTH_LIGHT = 0.85f

    // Glass.
    const val GLASS_INSET = 1.2f
    const val GLASS_WIDTH = 0.8f
    const val GLASS_STRENGTH_DARK = 0.30f
    const val GLASS_STRENGTH_LIGHT = 0.55f

    // Light mode.
    const val LIGHT_SATURATION = 1.18f
    const val LIGHT_HAZE_WHITE = 0.15f
    const val DARK_HAZE_WHITE = 0.7f

    // States. Level multiplies every opacity; speed multiplies the clock.
    const val IDLE_LEVEL = 1f
    const val IDLE_SPEED = 1f
    const val SIGNING_IN_LEVEL = 1.45f
    const val SIGNING_IN_SPEED = 2.6f

    /** Idle ⇄ signing in, both ways, in seconds. */
    const val STATE_EASE = 0.6

    /** From nothing to idle, when the sign-in page first appears. */
    const val APPEAR_FADE = 0.7

    /** From wherever it is to nothing, once the account is in. */
    const val SUCCESS_FADE = 0.85

    /**
     * How long the glow stays composed after the account arrives: the fade plus
     * a frame or two of slack, so it is never cut off before it reaches zero.
     */
    const val UNMOUNT_AFTER_MS = ((SUCCESS_FADE + 0.1) * 1000).toLong()

    /**
     * Reduced motion: no flow, and signing in is a step up in brightness rather
     * than a ramp and a faster current.
     */
    const val REDUCED_SIGNING_IN_LEVEL = 1.2f
}

/** What the glow is doing — the three states iOS `AuroraEdgeGlow.update` moves between. */
internal enum class AuroraPhase {
    /** The sign-in page is up and nothing is happening: breathe slowly. */
    IDLE,

    /** A sign-in is under way: brighter and quicker. */
    SIGNING_IN,

    /** The account is in: fade to nothing as the app appears. */
    LEAVING,
}

/**
 * Where the glow should head and how fast it should get there. [speed] null
 * means "leave the current flow alone" — the success fade dims the light
 * without stopping the current, so it does not look like it froze on the way
 * out.
 */
internal data class AuroraTarget(val level: Float, val speed: Float?, val durationSeconds: Double)

/** One frame of the glow: the integrated flow clock and the brightness. */
internal data class AuroraFrame(val t: Double, val level: Float)

/**
 * The state → speed/intensity mapping, kept out of Compose so it can be tested.
 */
internal object AuroraMotion {

    /** The phase for what the app is showing: off the sign-in page is always leaving. */
    fun phaseFor(onSignInPage: Boolean, signingIn: Boolean): AuroraPhase = when {
        !onSignInPage -> AuroraPhase.LEAVING
        signingIn -> AuroraPhase.SIGNING_IN
        else -> AuroraPhase.IDLE
    }

    /**
     * The ramp for entering [phase]. [appearing] is the first ramp after the
     * glow is composed, which fades in from nothing over the appear fade rather
     * than the quicker state ease. Leaving is only ever reached from a glow
     * already on screen, so it always takes the success fade.
     */
    fun target(phase: AuroraPhase, appearing: Boolean): AuroraTarget {
        val t = AuroraEdgeGlowTuning
        val ease = if (appearing) t.APPEAR_FADE else t.STATE_EASE
        return when (phase) {
            AuroraPhase.IDLE -> AuroraTarget(t.IDLE_LEVEL, t.IDLE_SPEED, ease)
            AuroraPhase.SIGNING_IN -> AuroraTarget(t.SIGNING_IN_LEVEL, t.SIGNING_IN_SPEED, ease)
            AuroraPhase.LEAVING -> AuroraTarget(0f, null, t.SUCCESS_FADE)
        }
    }

    /**
     * The level under reduced motion, read straight from the phase each frame:
     * no ramp, because nothing moves. The appear and success fades are done as
     * plain opacity by the caller.
     */
    fun reducedLevel(phase: AuroraPhase): Float = when (phase) {
        AuroraPhase.IDLE -> AuroraEdgeGlowTuning.IDLE_LEVEL
        AuroraPhase.SIGNING_IN -> AuroraEdgeGlowTuning.REDUCED_SIGNING_IN_LEVEL
        // Keep the last lit level while the opacity fades it out.
        AuroraPhase.LEAVING -> AuroraEdgeGlowTuning.IDLE_LEVEL
    }

    /** Ease in and out with no corner at either end. */
    fun smoothstep(x: Double): Double {
        val c = min(max(x, 0.0), 1.0)
        return c * c * (3 - 2 * c)
    }
}

/**
 * The glow's time and brightness, advanced once per frame — iOS `AuroraClock`.
 *
 * Two things it has to get right, both for the same reason as on iOS:
 *
 * - `t` is *integrated*: each frame adds its duration times the current speed.
 *   Multiplying the wall clock by speed instead would make the pattern leap
 *   the moment signing in more than doubles the speed.
 * - a frame after a pause (the app in the background, a hitch) adds at most
 *   [MAX_STEP_NANOS], so coming back resumes the flow where it was rather than
 *   skipping it forward.
 *
 * Times are the frame clock's nanoseconds, so the same values `withFrameNanos`
 * hands out drive it, and a test can drive it with plain numbers.
 */
internal class AuroraClock {

    private class Ramp(val from: Float, val to: Float, val startNanos: Long, val durationSeconds: Double) {
        fun value(nowNanos: Long): Float {
            if (durationSeconds <= 0) return to
            val x = (nowNanos - startNanos) / NANOS_PER_SECOND / durationSeconds
            return from + (to - from) * AuroraMotion.smoothstep(x).toFloat()
        }
    }

    private var t = 0.0
    private var last: Long? = null
    private var level = Ramp(0f, 0f, 0L, 0.0)
    private var speed = Ramp(1f, 1f, 0L, 0.0)

    /** Whether any ramp has been asked for yet — the first one is the appear fade. */
    var started: Boolean = false
        private set

    /** Head for [target] from wherever the glow is at [nowNanos]. */
    fun ramp(target: AuroraTarget, nowNanos: Long) {
        started = true
        level = Ramp(level.value(nowNanos), target.level, nowNanos, target.durationSeconds)
        target.speed?.let {
            speed = Ramp(speed.value(nowNanos), it, nowNanos, target.durationSeconds)
        }
    }

    fun advance(nowNanos: Long): AuroraFrame {
        last?.let { previous ->
            val step = (nowNanos - previous).coerceIn(0L, MAX_STEP_NANOS)
            t += step / NANOS_PER_SECOND * speed.value(nowNanos)
        }
        last = nowNanos
        return AuroraFrame(t, level.value(nowNanos))
    }

    companion object {
        private const val NANOS_PER_SECOND = 1_000_000_000.0

        /** 1/15 s: the longest a single frame may move the flow. */
        const val MAX_STEP_NANOS = 1_000_000_000L / 15
    }
}

/**
 * The prototype's three fields round the perimeter, in Kotlin — the same
 * formulas the shader evaluates per pixel. `u` is the position round the edge
 * in [0, 1), clockwise from the top-left; `t` is the flow clock in seconds.
 *
 *     i     = 0.55 + 0.30·sin 2π(2u + 0.07t) + 0.20·sin 2π(5u − 0.11t)
 *     c     = 0.5 + 0.5·sin 2π(1.5u − 0.05t)          blue → sky
 *     w     = 0.5 + 0.5·sin 2π(4u + 0.09t)
 *     glint = max(0, w − 0.55)·1.4·i                   towards white
 *
 * The pre-33 fallback samples these a few times along each edge instead of
 * per pixel, and the tests hold the colour seam closed.
 */
internal object AuroraField {
    private const val TAU = 2 * PI

    fun intensity(u: Double, t: Double): Double =
        0.55 + 0.30 * sin(TAU * (2 * u + 0.07 * t)) + 0.20 * sin(TAU * (5 * u - 0.11 * t))

    /**
     * `c`, with the last [seam] of the loop blended into the start: 1.5 turns
     * round the perimeter do not close, and left alone the two ends would show
     * as a colour step at the top-left corner.
     */
    fun colour(u: Double, t: Double, seam: Double = AuroraEdgeGlowTuning.COLOUR_SEAM.toDouble()): Double {
        val here = 0.5 + 0.5 * sin(TAU * (1.5 * u - 0.05 * t))
        val wrapped = 0.5 + 0.5 * sin(TAU * (1.5 * (u - 1.0) - 0.05 * t))
        val blend = AuroraMotion.smoothstep((u - (1.0 - seam)) / seam)
        return here + (wrapped - here) * blend
    }

    fun glint(u: Double, t: Double): Double {
        val w = 0.5 + 0.5 * sin(TAU * (4 * u + 0.09 * t))
        return max(0.0, w - 0.55) * 1.4 * intensity(u, t)
    }
}
