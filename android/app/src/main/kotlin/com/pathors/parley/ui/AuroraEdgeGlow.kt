package com.pathors.parley.ui

import android.content.Context
import android.graphics.RuntimeShader
import android.os.Build
import android.provider.Settings
import android.view.RoundedCorner
import android.view.View
import androidx.annotation.RequiresApi
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay

/**
 * A slow aurora of blue-and-white light breathing round the edge of the screen
 * while the sign-in page is up — the Android half of iOS `AuroraEdgeGlow`
 * (#491). It is the one screen in the app where nothing is happening yet, and
 * the one that has to make someone want in.
 *
 * It is also the sign-in's progress signal. The button already turns into a
 * spinner, but the button is under the Custom Tab for most of a sign-in, and
 * the edge of the screen is not: while [signingIn] the glow brightens and
 * quickens, and when the account is in it fades away as the app appears — so
 * the moment reads as the page letting you through rather than being swapped
 * out. A failed or cancelled sign-in eases back to idle.
 *
 * That fade is why `ParleyRoot` hosts this rather than [OnboardingScreen]: the
 * stored token flipping swaps the onboarding screen for the library in one
 * frame, and a glow that lived inside it would vanish with it. Up there it
 * outlives the page by exactly the fade, then leaves the composition, and the
 * rest of the app pays nothing for it — no frame loop runs once signed in.
 *
 * It never takes a touch and has no semantics, so TalkBack never hears of it.
 * The frame loop also stops whenever the app is not started (in the background,
 * under the Custom Tab's own activity), and never runs at all when animations
 * are turned off in the system settings — the glow is then a still light that
 * steps up in brightness while signing in.
 *
 * Drawn by an AGSL shader on API 33+ ([AURORA_AGSL], a line-for-line port of
 * `AuroraEdgeGlow.metal`); below that, by a few edge gradients that sample the
 * same fields ([GradientAuroraPainter]).
 */
@Composable
internal fun AuroraEdgeGlow(onSignInPage: Boolean, signingIn: Boolean, modifier: Modifier = Modifier) {
    // Composed while the sign-in page is up, and for the success fade after it.
    var lingering by remember { mutableStateOf(false) }
    LaunchedEffect(onSignInPage) {
        if (onSignInPage) {
            lingering = true
        } else if (lingering) {
            delay(AuroraEdgeGlowTuning.UNMOUNT_AFTER_MS)
            lingering = false
        }
    }
    if (onSignInPage || lingering) {
        AuroraLayer(AuroraMotion.phaseFor(onSignInPage, signingIn), modifier)
    }
}

@Composable
private fun AuroraLayer(phase: AuroraPhase, modifier: Modifier) {
    val context = LocalContext.current
    val reduced = remember(context) { animatorsDisabled(context) }
    val dark = MaterialTheme.colorScheme.background.luminance() < 0.5f
    val view = LocalView.current
    val painter = remember { auroraPainter() }
    val frame = rememberAuroraFrame(phase, reduced)
    val opacity = rememberReducedOpacity(phase, reduced)

    Canvas(modifier.fillMaxSize()) {
        val look = AuroraLook(
            dark = dark,
            flowing = !reduced,
            density = density,
            cornerRadiusDp = displayCornerRadiusPx(view) / density,
        )
        val shown = if (reduced) AuroraFrame(0.0, AuroraMotion.reducedLevel(phase) * opacity.value) else frame
        if (shown.level > 0f) painter.draw(this, shown, look)
    }
}

/**
 * The flowing frame: ramps the clock on every phase change and advances it once
 * a frame while the app is started. Nothing runs under reduced motion.
 */
@Composable
private fun rememberAuroraFrame(phase: AuroraPhase, reduced: Boolean): AuroraFrame {
    val clock = remember { AuroraClock() }
    var frame by remember { mutableStateOf(AuroraFrame(0.0, 0f)) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle

    LaunchedEffect(phase) {
        val now = withFrameNanos { it }
        clock.ramp(AuroraMotion.target(phase, appearing = !clock.started), now)
    }
    LaunchedEffect(reduced, lifecycle) {
        if (reduced) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                frame = withFrameNanos { clock.advance(it) }
            }
        }
    }
    return frame
}

/** Reduced motion's stand-in for the level ramp: the appear and success fades, as opacity. */
@Composable
private fun rememberReducedOpacity(phase: AuroraPhase, reduced: Boolean): Animatable<Float, *> {
    val opacity = remember { Animatable(0f) }
    val leaving = phase == AuroraPhase.LEAVING
    LaunchedEffect(leaving, reduced) {
        if (!reduced) return@LaunchedEffect
        val seconds = if (leaving) AuroraEdgeGlowTuning.SUCCESS_FADE else AuroraEdgeGlowTuning.APPEAR_FADE
        opacity.animateTo(if (leaving) 0f else 1f, tween((seconds * 1000).toInt()))
    }
    return opacity
}

/**
 * The system's "Remove animations" switch (animator duration scale 0) — what
 * Android has in place of iOS Reduce Motion.
 */
private fun animatorsDisabled(context: Context): Boolean =
    Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f

/**
 * The display's corner radius in px, so the glow follows its curve. API 31
 * answers this publicly; before that there is no answer, and the glow is drawn
 * square, which on those phones' near-square corners loses nothing visible.
 */
private fun displayCornerRadiusPx(view: View): Float {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return 0f
    val corner = view.rootWindowInsets?.getRoundedCorner(RoundedCorner.POSITION_TOP_LEFT)
    return corner?.radius?.toFloat() ?: 0f
}

/** What the painter needs to know about the screen and the appearance. */
private data class AuroraLook(
    val dark: Boolean,
    val flowing: Boolean,
    val density: Float,
    val cornerRadiusDp: Float,
) {
    val hazeStrength get() = if (dark) AuroraEdgeGlowTuning.HAZE_STRENGTH_DARK else AuroraEdgeGlowTuning.HAZE_STRENGTH_LIGHT
    val coreStrength get() = if (dark) AuroraEdgeGlowTuning.CORE_STRENGTH_DARK else AuroraEdgeGlowTuning.CORE_STRENGTH_LIGHT
    val glassStrength get() = if (dark) AuroraEdgeGlowTuning.GLASS_STRENGTH_DARK else AuroraEdgeGlowTuning.GLASS_STRENGTH_LIGHT

    /**
     * Dark mode adds the light to the page, so it reads as light rather than
     * paint (iOS `plusLighter`); light mode lays it over the page normally.
     */
    val blendMode get() = if (dark) BlendMode.Plus else BlendMode.SrcOver
}

private interface AuroraPainter {
    fun draw(scope: DrawScope, frame: AuroraFrame, look: AuroraLook)
}

/** The shader where there is one, the gradients where there is not. */
private fun auroraPainter(): AuroraPainter =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) ShaderAuroraPainter() else GradientAuroraPainter()

/**
 * The real thing: one runtime shader over the whole screen. Its uniforms are
 * set each draw; the shader object and its brush are made once.
 */
@RequiresApi(Build.VERSION_CODES.TIRAMISU)
private class ShaderAuroraPainter : AuroraPainter {
    private val shader = RuntimeShader(AURORA_AGSL)
    private val brush = ShaderBrush(shader)

    override fun draw(scope: DrawScope, frame: AuroraFrame, look: AuroraLook) {
        val t = AuroraEdgeGlowTuning
        shader.setFloatUniform("sizePx", scope.size.width, scope.size.height)
        shader.setFloatUniform("density", look.density)
        shader.setFloatUniform("radius", look.cornerRadiusDp)
        shader.setFloatUniform("t", frame.t.toFloat())
        shader.setFloatUniform("level", frame.level)
        shader.setFloatUniform("flags", if (look.dark) 1f else 0f, if (look.flowing) 1f else 0f, 0f, 0f)
        shader.setFloatUniform("haze", t.HAZE_REACH, t.HAZE_REACH_PER_I, t.HAZE_BLUR, look.hazeStrength)
        shader.setFloatUniform("core", t.CORE_WIDTH_MIN, t.CORE_WIDTH_MAX, t.CORE_BLUR, look.coreStrength)
        shader.setFloatUniform("glass", t.GLASS_INSET, t.GLASS_WIDTH, look.glassStrength, 0f)
        shader.setFloatUniform("look", t.LIGHT_SATURATION, t.LIGHT_HAZE_WHITE, t.DARK_HAZE_WHITE, t.COLOUR_SEAM)
        shader.setFloatUniform("blue", t.BLUE)
        shader.setFloatUniform("sky", t.SKY)
        scope.drawRect(brush, blendMode = look.blendMode)
    }
}

/**
 * Below API 33 there are no runtime shaders, so the glow is approximated
 * cheaply: each edge gets a haze gradient running inward, tinted and weighted
 * by the same fields sampled at the edge's middle, plus a core stroke and the
 * glass hairline round the whole screen. It flows and brightens like the real
 * one; it just has four colours where the shader has a continuous band.
 */
private class GradientAuroraPainter : AuroraPainter {

    override fun draw(scope: DrawScope, frame: AuroraFrame, look: AuroraLook) = with(scope) {
        val tuning = AuroraEdgeGlowTuning
        val t = if (look.flowing) frame.t else 0.0
        val reachScale = 1f + (frame.level.coerceAtLeast(0f) - 1f) * 0.5f
        // Edge midpoints round the perimeter, clockwise from the top-left.
        for (edge in Edge.entries) {
            val i = fieldIntensity(edge.u, t, look).toFloat()
            val reach = (tuning.HAZE_REACH + tuning.HAZE_REACH_PER_I * i.coerceIn(0f, 1f)) * reachScale
            val alpha = (look.hazeStrength * i * frame.level).coerceIn(0f, 1f)
            val tint = tintAt(edge.u, t, look).copy(alpha = alpha)
            drawEdgeHaze(edge, tint, (reach + tuning.HAZE_BLUR) * look.density, look.blendMode)
        }
        val i = fieldIntensity(0.5, t, look).toFloat().coerceIn(0f, 1f)
        val coreWidth = (tuning.CORE_WIDTH_MIN + (tuning.CORE_WIDTH_MAX - tuning.CORE_WIDTH_MIN) * i) * look.density
        val coreAlpha = (look.coreStrength * (0.35f + 0.65f * i) * frame.level).coerceIn(0f, 1f)
        drawInsetStroke(tintAt(0.5, t, look).copy(alpha = coreAlpha), coreWidth, 0f, look)
        val glassAlpha = (look.glassStrength * frame.level.coerceAtMost(1f)).coerceIn(0f, 1f)
        drawInsetStroke(
            Color.White.copy(alpha = glassAlpha),
            tuning.GLASS_WIDTH * look.density,
            tuning.GLASS_INSET * look.density,
            look,
        )
    }

    private fun fieldIntensity(u: Double, t: Double, look: AuroraLook): Double =
        if (look.flowing) AuroraField.intensity(u, t) else REDUCED_INTENSITY

    private fun tintAt(u: Double, t: Double, look: AuroraLook): Color {
        val blue = AuroraEdgeGlowTuning.BLUE
        val sky = AuroraEdgeGlowTuning.SKY
        val c = if (look.flowing) AuroraField.colour(u, t).toFloat() else 0.5f
        return Color(
            red = blue[0] + (sky[0] - blue[0]) * c,
            green = blue[1] + (sky[1] - blue[1]) * c,
            blue = blue[2] + (sky[2] - blue[2]) * c,
        )
    }

    private fun DrawScope.drawEdgeHaze(edge: Edge, tint: Color, depthPx: Float, blendMode: BlendMode) {
        val colours = listOf(tint, Color.Transparent)
        val depth = depthPx.coerceAtMost(minOf(size.width, size.height) / 2)
        when (edge) {
            Edge.TOP -> drawRect(
                Brush.verticalGradient(colours, 0f, depth),
                size = Size(size.width, depth),
                blendMode = blendMode,
            )
            Edge.RIGHT -> drawRect(
                Brush.horizontalGradient(colours, size.width, size.width - depth),
                topLeft = Offset(size.width - depth, 0f),
                size = Size(depth, size.height),
                blendMode = blendMode,
            )
            Edge.BOTTOM -> drawRect(
                Brush.verticalGradient(colours, size.height, size.height - depth),
                topLeft = Offset(0f, size.height - depth),
                size = Size(size.width, depth),
                blendMode = blendMode,
            )
            Edge.LEFT -> drawRect(
                Brush.horizontalGradient(colours, 0f, depth),
                size = Size(depth, size.height),
                blendMode = blendMode,
            )
        }
    }

    private fun DrawScope.drawInsetStroke(colour: Color, widthPx: Float, insetPx: Float, look: AuroraLook) {
        val offset = insetPx + widthPx / 2
        val radius = (look.cornerRadiusDp * look.density - offset).coerceAtLeast(0f)
        drawRoundRect(
            color = colour,
            topLeft = Offset(offset, offset),
            size = Size(size.width - 2 * offset, size.height - 2 * offset),
            cornerRadius = CornerRadius(radius, radius),
            style = Stroke(widthPx),
            blendMode = look.blendMode,
        )
    }

    /** The four edges, by where their middles sit round the perimeter on a portrait phone. */
    private enum class Edge(val u: Double) {
        TOP(0.1),
        RIGHT(0.35),
        BOTTOM(0.6),
        LEFT(0.85),
    }

    private companion object {
        /** The intensity field's average round the loop, for the still glow. */
        const val REDUCED_INTENSITY = 0.55
    }
}

/**
 * `AuroraEdgeGlow.metal`, in AGSL. The body is the Metal one line for line; see
 * there (and iOS `AuroraEdgeGlowTuning`) for why each layer is a closed-form
 * Gaussian band instead of a blur pass. The differences are only of platform:
 *
 * - the canvas is in px, so position and size are divided by `density` first
 *   and every length below is in dp, exactly as iOS works in points;
 * - `atan2(y, x)` is spelled `atan(y, x)`;
 * - the pixel size for the glass hairline's antialiasing is `1 / density`.
 *
 * Returns premultiplied colour, as AGSL expects.
 */
private const val AURORA_AGSL = """
uniform float2 sizePx;
uniform float density;
uniform float radius;
uniform float t;
uniform float level;
uniform float4 flags;
uniform float4 haze;
uniform float4 core;
uniform float4 glass;
uniform float4 look;
uniform float3 blue;
uniform float3 sky;

const float TAU = 6.28318530718;

float gaussianCdf(float x) {
    return 1.0 / (1.0 + exp(-1.702 * x));
}

float blurredBand(float d, float width, float blur) {
    return gaussianCdf((width - d) / max(blur, 0.001));
}

float2 depthAndPerimeter(float2 p, float2 size, float rad) {
    float2 h = size * 0.5;
    float r = clamp(rad, 0.0, min(h.x, h.y));
    float2 c = p - h;
    float2 a = h - r;
    float2 q = abs(c) - a;

    float depth;
    if (q.x > 0.0 && q.y > 0.0) {
        depth = r - length(q);
    } else {
        depth = -max(q.x, q.y) + r;
    }

    float lx = 2.0 * a.x;
    float ly = 2.0 * a.y;
    float arc = 0.25 * TAU * r;
    float total = 2.0 * lx + 2.0 * ly + 4.0 * arc;

    float s;
    if (q.x > 0.0 && q.y > 0.0) {
        if (c.x > 0.0 && c.y < 0.0) {
            float2 v = c - float2(a.x, -a.y);
            s = lx + r * atan(v.x, -v.y);
        } else if (c.x > 0.0) {
            float2 v = c - float2(a.x, a.y);
            s = lx + arc + ly + r * atan(v.y, v.x);
        } else if (c.y > 0.0) {
            float2 v = c - float2(-a.x, a.y);
            s = 2.0 * lx + 2.0 * arc + ly + r * atan(-v.x, v.y);
        } else {
            float2 v = c - float2(-a.x, -a.y);
            s = 2.0 * lx + 3.0 * arc + 2.0 * ly + r * atan(-v.y, -v.x);
        }
    } else if (q.y >= q.x) {
        s = c.y < 0.0
            ? c.x + a.x
            : 2.0 * arc + lx + ly + (a.x - c.x);
    } else {
        s = c.x > 0.0
            ? lx + arc + (c.y + a.y)
            : 3.0 * arc + 2.0 * lx + ly + (a.y - c.y);
    }
    return float2(depth, fract(s / max(total, 1.0)));
}

float colourMix(float u, float tt, float seam) {
    float here = 0.5 + 0.5 * sin(TAU * (1.5 * u - 0.05 * tt));
    float wrapped = 0.5 + 0.5 * sin(TAU * (1.5 * (u - 1.0) - 0.05 * tt));
    return mix(here, wrapped, smoothstep(1.0 - seam, 1.0, u));
}

half4 main(float2 fragCoord) {
    float2 size = sizePx / density;
    float2 du = depthAndPerimeter(fragCoord / density, size, radius);
    float d = max(du.x, 0.0);
    float u = du.y;

    float maxReach = (haze.x + haze.y) * max(level, 1.0) + 3.0 * haze.z;
    if (d > maxReach || level <= 0.0) {
        return half4(0.0);
    }

    bool dark = flags.x > 0.5;
    bool flowing = flags.y > 0.5;
    float pixel = max(1.0 / density, 0.25);

    float i;
    float c;
    float glint;
    if (flowing) {
        i = 0.55 + 0.30 * sin(TAU * (2.0 * u + 0.07 * t))
                 + 0.20 * sin(TAU * (5.0 * u - 0.11 * t));
        c = colourMix(u, t, look.w);
        float w = 0.5 + 0.5 * sin(TAU * (4.0 * u + 0.09 * t));
        glint = max(0.0, w - 0.55) * 1.4 * i;
    } else {
        i = 0.55;
        c = 0.5;
        glint = 0.104;
    }
    float iC = clamp(i, 0.0, 1.0);

    float3 tint = mix(blue, sky, c);
    if (!dark) {
        float luma = dot(tint, float3(0.2126, 0.7152, 0.0722));
        tint = clamp(mix(float3(luma), tint, look.x), 0.0, 1.0);
    }
    float3 white = float3(1.0);

    float reachScale = mix(1.0, max(level, 0.0), 0.5);

    float hazeReach = (haze.x + haze.y * iC) * reachScale;
    float hazeA = clamp(haze.w * i * level * blurredBand(d, hazeReach, haze.z), 0.0, 1.0);
    float3 hazeRGB = mix(tint, white, clamp(glint * (dark ? look.z : look.y), 0.0, 1.0));

    float coreWidth = mix(core.x, core.y, iC);
    float coreA = clamp(core.w * (0.35 + 0.65 * iC) * level
                        * blurredBand(d, coreWidth, core.z), 0.0, 1.0);
    float3 coreRGB = mix(tint, white, clamp(glint, 0.0, 1.0));

    float g0 = glass.x;
    float g1 = glass.x + glass.y;
    float cover = clamp((d - g0) / pixel + 0.5, 0.0, 1.0) - clamp((d - g1) / pixel + 0.5, 0.0, 1.0);
    float glassA = clamp(glass.z * min(level, 1.0) * cover, 0.0, 1.0);

    float3 rgb;
    float alpha;
    if (dark) {
        rgb = hazeRGB * hazeA + coreRGB * coreA + white * glassA;
        alpha = clamp(max(max(hazeA, coreA), glassA), 0.0, 1.0);
    } else {
        rgb = hazeRGB * hazeA;
        alpha = hazeA;
        rgb = coreRGB * coreA + rgb * (1.0 - coreA);
        alpha = coreA + alpha * (1.0 - coreA);
        rgb = white * glassA + rgb * (1.0 - glassA);
        alpha = glassA + alpha * (1.0 - glassA);
    }
    return half4(half3(rgb), half(alpha));
}
"""
