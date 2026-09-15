package com.pathors.parley.ui.theme

import androidx.compose.material3.ColorScheme
import androidx.compose.ui.graphics.Color
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The guarantee we gave up when we stopped using dynamic colour.
 *
 * Material generates a dynamic scheme from tonal palettes, so its roles are a
 * fixed number of tone steps apart and contrast holds without anyone checking.
 * [ParleyLightColorScheme] and [ParleyDarkColorScheme] are hand-written hex, and
 * a hand-written scheme is only as accessible as its last review — so the review
 * is here, and it runs on every build.
 *
 * The bar is **WCAG 2.1 AA**: 4.5:1 for text, 3:1 for a non-text indicator. Not
 * 3:1-for-large-text, because Parley's large text is a page title a user reads
 * once and its body text is a meeting transcript they read for an hour.
 *
 * If you are here because this failed: the fix is to move the *surface*, not the
 * brand. `#1469D4`, `#2DB6F3`, `#0C1620`, `#E5322D` and `#FF453A` are shared with
 * iOS and the landing site and are not ours to retune.
 */
class ParleyColorSchemeTest {

    // ── WCAG 2.1 ────────────────────────────────────────────────────────────

    /** Relative luminance, WCAG 2.1 §1.4.3. */
    private fun luminance(color: Color): Double {
        fun channel(v: Float): Double {
            val c = v.toDouble()
            return if (c <= 0.04045) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4)
        }
        return 0.2126 * channel(color.red) +
            0.7152 * channel(color.green) +
            0.0722 * channel(color.blue)
    }

    private fun contrast(a: Color, b: Color): Double {
        val la = luminance(a)
        val lb = luminance(b)
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    /**
     * Every surface a Material component can end up drawing text on. The screens
     * only name `surface`, `background`, `surfaceVariant` and `primaryContainer`
     * by hand, but a `Dialog` picks `surfaceContainerHigh`, a `DropdownMenu` picks
     * `surfaceContainer` and a scrolled `TopAppBar` picks `surfaceContainer` on
     * its own, so a text role has to clear all of them or it is only accidentally
     * readable.
     */
    private fun surfaces(s: ColorScheme): List<Pair<String, Color>> = listOf(
        "surface" to s.surface,
        "background" to s.background,
        "surfaceVariant" to s.surfaceVariant,
        "surfaceDim" to s.surfaceDim,
        "surfaceBright" to s.surfaceBright,
        "surfaceContainerLowest" to s.surfaceContainerLowest,
        "surfaceContainerLow" to s.surfaceContainerLow,
        "surfaceContainer" to s.surfaceContainer,
        "surfaceContainerHigh" to s.surfaceContainerHigh,
        "surfaceContainerHighest" to s.surfaceContainerHighest,
    )

    /**
     * Roles the screens use as *text*, with the call-site count that makes each
     * one matter. `outline` is in here and not among the 3:1 decorations because
     * `MeetingScreen` and `RecordingDetailScreen` colour clock and timestamp
     * labels with it — in this app `outline` is iOS's `tertiaryLabel`, not a
     * hairline. The hairline is `outlineVariant`.
     */
    private fun textRoles(s: ColorScheme): List<Pair<String, Color>> = listOf(
        "onSurface" to s.onSurface,
        "onSurfaceVariant" to s.onSurfaceVariant,
        "outline" to s.outline,
        "error" to s.error,
        "primary" to s.primary,
    )

    private fun pairs(s: ColorScheme): List<Triple<String, Pair<Color, Color>, Double>> = listOf(
        Triple("onPrimary on primary", s.onPrimary to s.primary, AA_TEXT),
        Triple("onSecondary on secondary", s.onSecondary to s.secondary, AA_TEXT),
        Triple("onTertiary on tertiary", s.onTertiary to s.tertiary, AA_TEXT),
        Triple("onError on error", s.onError to s.error, AA_TEXT),
        Triple("onBackground on background", s.onBackground to s.background, AA_TEXT),
        Triple(
            "onPrimaryContainer on primaryContainer",
            s.onPrimaryContainer to s.primaryContainer,
            AA_TEXT,
        ),
        Triple(
            "onSecondaryContainer on secondaryContainer",
            s.onSecondaryContainer to s.secondaryContainer,
            AA_TEXT,
        ),
        Triple(
            "onTertiaryContainer on tertiaryContainer",
            s.onTertiaryContainer to s.tertiaryContainer,
            AA_TEXT,
        ),
        Triple(
            "onErrorContainer on errorContainer",
            s.onErrorContainer to s.errorContainer,
            AA_TEXT,
        ),
        // The snackbar: its own surface, and the brand blue has to survive on it.
        Triple("inverseOnSurface on inverseSurface", s.inverseOnSurface to s.inverseSurface, AA_TEXT),
        Triple("inversePrimary on inverseSurface", s.inversePrimary to s.inverseSurface, AA_TEXT),
    )

    // ── The checks ──────────────────────────────────────────────────────────

    @Test
    fun `text roles clear AA on every surface a component can pick`() {
        val failures = mutableListOf<String>()
        for ((schemeName, scheme) in schemes()) {
            for ((roleName, role) in textRoles(scheme)) {
                for ((surfaceName, surface) in surfaces(scheme)) {
                    val ratio = contrast(role, surface)
                    if (ratio < AA_TEXT) {
                        failures += "%s: %s on %s = %.2f:1 (needs %.1f:1)"
                            .format(schemeName, roleName, surfaceName, ratio, AA_TEXT)
                    }
                }
            }
        }
        assertTrue(failures.joinToString("\n", prefix = "\n"), failures.isEmpty())
    }

    @Test
    fun `paired roles clear AA against their own container`() {
        val failures = mutableListOf<String>()
        for ((schemeName, scheme) in schemes()) {
            for ((label, colors, minimum) in pairs(scheme)) {
                val ratio = contrast(colors.first, colors.second)
                if (ratio < minimum) {
                    failures += "%s: %s = %.2f:1 (needs %.1f:1)"
                        .format(schemeName, label, ratio, minimum)
                }
            }
        }
        assertTrue(failures.joinToString("\n", prefix = "\n"), failures.isEmpty())
    }

    /**
     * The recording red is an indicator, not a label, so the bar is the 3:1 for
     * non-text UI — but it has to clear it on the card fill as well as the page,
     * because a LIVE badge can sit inside a card.
     */
    @Test
    fun `recording red is legible as an indicator in both schemes`() {
        val cases = listOf(
            "light on surface" to
                contrast(ParleyPalette.LightRecording, ParleyLightColorScheme.surface),
            "light on surfaceVariant" to
                contrast(ParleyPalette.LightRecording, ParleyLightColorScheme.surfaceVariant),
            "dark on surface" to
                contrast(ParleyPalette.DarkRecording, ParleyDarkColorScheme.surface),
            "dark on surfaceVariant" to
                contrast(ParleyPalette.DarkRecording, ParleyDarkColorScheme.surfaceVariant),
        )
        for ((label, ratio) in cases) {
            assertTrue(
                "recording %s = %.2f:1 (needs %.1f:1)".format(label, ratio, AA_NON_TEXT),
                ratio >= AA_NON_TEXT,
            )
        }
    }

    /**
     * A card is drawn with `surfaceVariant` and separated from the page by
     * lightness alone, so if that step disappears the card does. It is deliberately
     * slight — Parley separates things with whitespace — but it must not be zero.
     */
    @Test
    fun `cards are distinguishable from the page`() {
        for ((name, scheme) in schemes()) {
            val step = contrast(scheme.surfaceVariant, scheme.surface)
            assertTrue(
                "%s: surfaceVariant is %.3f:1 against surface — the card has vanished"
                    .format(name, step),
                step >= 1.10,
            )
        }
    }

    /**
     * The three values that are not ours to change: they are copied from
     * `ios/App/Parley/ParleyDesignTokens.swift`, which mirrors the landing site.
     * If this fails, the Android app has drifted away from the rest of the
     * product and that is the bug, whatever the diff says it was fixing.
     */
    @Test
    fun `brand primitives match the iOS design tokens`() {
        assertEquals(Color(0xFFFFFFFF), ParleyPalette.LightBackground)
        assertEquals(Color(0xFF1469D4), ParleyPalette.LightPrimary)
        assertEquals(Color(0xFFE5322D), ParleyPalette.LightRecording)
        assertEquals(Color(0xFF0C1620), ParleyPalette.DarkBackground)
        assertEquals(Color(0xFF2DB6F3), ParleyPalette.DarkPrimary)
        assertEquals(Color(0xFFFF453A), ParleyPalette.DarkRecording)

        assertEquals(ParleyPalette.LightPrimary, ParleyLightColorScheme.primary)
        assertEquals(ParleyPalette.DarkPrimary, ParleyDarkColorScheme.primary)
        assertEquals(ParleyPalette.LightBackground, ParleyLightColorScheme.background)
        assertEquals(ParleyPalette.DarkBackground, ParleyDarkColorScheme.background)
    }

    private fun schemes() = listOf(
        "light" to ParleyLightColorScheme,
        "dark" to ParleyDarkColorScheme,
    )

    private companion object {
        const val AA_TEXT = 4.5
        const val AA_NON_TEXT = 3.0
    }
}
