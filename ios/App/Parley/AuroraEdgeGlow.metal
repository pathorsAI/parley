// The sign-in page's edge glow, one pixel at a time. See AuroraEdgeGlow.swift
// for what it is for, the states that drive it, and `AuroraEdgeGlowTuning` for
// every number that shapes it.
//
// The approved prototype was drawn on a web canvas: a wide stroke along the
// screen edge under a 14px CSS blur (the haze), a thin one under a 2px blur
// (the core), and a hairline. Blurring a full-screen layer every frame is the
// expensive way to get that look on a phone, and it is not needed: a stroke
// that starts at the edge and is blurred by a Gaussian of σ is, at depth d,
// exactly the normal CDF Φ((width − d) / σ). So each layer here is that
// closed form, evaluated per pixel from two numbers — how deep the pixel is
// inside the screen shape, and how far round the perimeter it sits — and a
// pixel deeper than the widest layer can reach returns before doing any of
// it. Nearly the whole screen takes that early exit.
//
// Kept in plain arithmetic (no SwiftUI-only helpers past the header) so the
// body ports line for line to AGSL on Android and GLSL on the desktop.

#include <metal_stdlib>
#include <SwiftUI/SwiftUI_Metal.h>
using namespace metal;

namespace aurora {

constant float TAU = 6.28318530718;

/// Φ(x), the standard normal CDF, by the logistic approximation
/// 1 / (1 + e^(−1.702x)). Off by under 0.01 everywhere, which no eye can find
/// in a glow, and a single exp instead of an erf.
inline float gaussianCdf(float x) {
    return 1.0 / (1.0 + exp(-1.702 * x));
}

/// A band that starts at the screen edge and runs `width` points inward,
/// blurred by a Gaussian of `blur` points: what a canvas stroke under a CSS
/// blur looks like at depth `d`.
inline float blurredBand(float d, float width, float blur) {
    return gaussianCdf((width - d) / max(blur, 0.001));
}

/// Depth of `p` inside a rounded rectangle of `size` and corner `radius`
/// (positive inside, zero on the edge), and its position round the perimeter
/// as a fraction `u` in [0, 1), clockwise from the top-left, where the top
/// edge's straight run begins.
///
/// The corners are circular arcs. The display's are Apple's continuous
/// corners, but at the same nominal radius the two curves never sit more than
/// a point apart, which is under the core's own blur.
inline float2 depthAndPerimeter(float2 p, float2 size, float radius) {
    float2 h = size * 0.5;
    float r = clamp(radius, 0.0, min(h.x, h.y));
    float2 c = p - h;             // centred, y down
    float2 a = h - r;             // half-size of the box the arcs are centred on
    float2 q = abs(c) - a;

    float depth;
    if (q.x > 0.0 && q.y > 0.0) {
        depth = r - length(q);
    } else {
        depth = -max(q.x, q.y) + r;
    }

    float lx = 2.0 * a.x;         // straight run of the top and bottom edges
    float ly = 2.0 * a.y;         // ... and of the sides
    float arc = 0.25 * TAU * r;   // one corner
    float total = 2.0 * lx + 2.0 * ly + 4.0 * arc;

    float s;
    if (q.x > 0.0 && q.y > 0.0) {
        if (c.x > 0.0 && c.y < 0.0) {            // top-right
            float2 v = c - float2(a.x, -a.y);
            s = lx + r * atan2(v.x, -v.y);
        } else if (c.x > 0.0) {                  // bottom-right
            float2 v = c - float2(a.x, a.y);
            s = lx + arc + ly + r * atan2(v.y, v.x);
        } else if (c.y > 0.0) {                  // bottom-left
            float2 v = c - float2(-a.x, a.y);
            s = 2.0 * lx + 2.0 * arc + ly + r * atan2(-v.x, v.y);
        } else {                                 // top-left
            float2 v = c - float2(-a.x, -a.y);
            s = 2.0 * lx + 3.0 * arc + 2.0 * ly + r * atan2(-v.y, -v.x);
        }
    } else if (q.y >= q.x) {
        s = c.y < 0.0
            ? c.x + a.x                                   // top, left to right
            : 2.0 * arc + lx + ly + (a.x - c.x);          // bottom, right to left
    } else {
        s = c.x > 0.0
            ? lx + arc + (c.y + a.y)                      // right, top to bottom
            : 3.0 * arc + 2.0 * lx + ly + (a.y - c.y);    // left, bottom to top
    }
    return float2(depth, fract(s / max(total, 1.0)));
}

/// The colour field's own term, `c` in the tuning notes. Split out because
/// 1.5 turns round the perimeter do not close: at the top-left, where `u`
/// wraps, the two ends disagree, so the last `seam` of the loop is blended
/// towards the value the start of the loop has.
inline float colourMix(float u, float t, float seam) {
    float here = 0.5 + 0.5 * sin(TAU * (1.5 * u - 0.05 * t));
    float wrapped = 0.5 + 0.5 * sin(TAU * (1.5 * (u - 1.0) - 0.05 * t));
    return mix(here, wrapped, smoothstep(1.0 - seam, 1.0, u));
}

} // namespace aurora

/// Arguments, in the order `AuroraEdgeGlow` passes them:
///
/// - size, radius:  the screen in points and its corner radius.
/// - t:             the flow clock in seconds, already multiplied by speed.
/// - level:         0 hidden, 1 idle, ≈1.45 signing in.
/// - flags:         (dark, flowing, pixelSize, _). `flowing` is 0 under
///                  Reduce Motion: every term is replaced by its average.
/// - haze:          (reach at i = 0, extra reach at i = 1, blur, strength).
/// - core:          (width at i = 0, width at i = 1, blur, strength).
/// - glass:         (inset, width, strength, _).
/// - look:          (light saturation, light haze whiteness, dark haze
///                  whiteness, colour seam).
/// - blue, sky:     the two ends of the colour field, sRGB 0–1.
///
/// Returns premultiplied colour. In dark mode the caller composites it with
/// `plusLighter`, so it is light added to the page; in light mode it is laid
/// over the page normally.
[[ stitchable ]] half4 auroraEdgeGlow(
    float2 position, half4 color,
    float2 size, float radius, float t, float level,
    float4 flags, float4 haze, float4 core, float4 glass, float4 look,
    float3 blue, float3 sky)
{
    float2 du = aurora::depthAndPerimeter(position, size, radius);
    // Outside the arc means the corner of a display whose real radius is
    // smaller than the one assumed (the pre-iOS 26 fallback): light it as the
    // edge itself rather than leave a dark notch between glow and glass.
    float d = max(du.x, 0.0);
    float u = du.y;

    // Early out: deeper than the haze can reach at its brightest.
    float maxReach = (haze.x + haze.y) * max(level, 1.0) + 3.0 * haze.z;
    if (d > maxReach || level <= 0.0) {
        return half4(0.0);
    }

    bool dark = flags.x > 0.5;
    bool flowing = flags.y > 0.5;
    float pixel = max(flags.z, 0.25);

    // The three fields of the prototype. Under Reduce Motion each is its own
    // average round the loop: i → 0.55, c → 0.5, and the glint strength
    // E[max(0, w − 0.55)]·1.4·0.55 ≈ 0.104.
    float i;
    float c;
    float glint;
    if (flowing) {
        i = 0.55 + 0.30 * sin(aurora::TAU * (2.0 * u + 0.07 * t))
                 + 0.20 * sin(aurora::TAU * (5.0 * u - 0.11 * t));
        c = aurora::colourMix(u, t, look.w);
        float w = 0.5 + 0.5 * sin(aurora::TAU * (4.0 * u + 0.09 * t));
        glint = max(0.0, w - 0.55) * 1.4 * i;
    } else {
        i = 0.55;
        c = 0.5;
        glint = 0.104;
    }
    float iC = clamp(i, 0.0, 1.0);

    float3 tint = mix(blue, sky, c);
    if (!dark) {
        // A little more saturated on white, where a pale blue reads as grey.
        float luma = dot(tint, float3(0.2126, 0.7152, 0.0722));
        tint = clamp(mix(float3(luma), tint, look.x), 0.0, 1.0);
    }
    float3 white = float3(1.0);

    // Signing in reaches a little further as well as shining brighter.
    float reachScale = mix(1.0, max(level, 0.0), 0.5);

    // Haze: wide, soft, and where the field is strong it reaches further in.
    float hazeReach = (haze.x + haze.y * iC) * reachScale;
    float hazeA = clamp(haze.w * i * level * aurora::blurredBand(d, hazeReach, haze.z), 0.0, 1.0);
    float3 hazeRGB = mix(tint, white, clamp(glint * (dark ? look.z : look.y), 0.0, 1.0));

    // Core: a bright thread right at the edge, 2–7pt wide with the field.
    float coreWidth = mix(core.x, core.y, iC);
    float coreA = clamp(core.w * (0.35 + 0.65 * iC) * level
                        * aurora::blurredBand(d, coreWidth, core.z), 0.0, 1.0);
    float3 coreRGB = mix(tint, white, clamp(glint, 0.0, 1.0));

    // Glass: a faint white hairline just inside the edge, antialiased over a
    // pixel, steady regardless of the field.
    float g0 = glass.x;
    float g1 = glass.x + glass.y;
    float cover = clamp((d - g0) / pixel + 0.5, 0.0, 1.0) - clamp((d - g1) / pixel + 0.5, 0.0, 1.0);
    float glassA = clamp(glass.z * min(level, 1.0) * cover, 0.0, 1.0);

    float3 rgb;
    float alpha;
    if (dark) {
        // Light adds up: the caller blends this with plusLighter.
        rgb = hazeRGB * hazeA + coreRGB * coreA + white * glassA;
        alpha = clamp(max(max(hazeA, coreA), glassA), 0.0, 1.0);
    } else {
        // Paint over paint: haze, then the core over it, then the glass.
        rgb = hazeRGB * hazeA;
        alpha = hazeA;
        rgb = coreRGB * coreA + rgb * (1.0 - coreA);
        alpha = coreA + alpha * (1.0 - coreA);
        rgb = white * glassA + rgb * (1.0 - glassA);
        alpha = glassA + alpha * (1.0 - glassA);
    }
    return half4(half3(rgb), half(alpha));
}
