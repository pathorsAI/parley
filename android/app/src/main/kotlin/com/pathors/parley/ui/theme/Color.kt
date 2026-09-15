package com.pathors.parley.ui.theme

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/**
 * Parley's colour primitives, and the two Material 3 schemes built out of them.
 *
 * ## Where the values come from
 *
 * The three that carry the brand are copied byte-for-byte from
 * `ios/App/Parley/ParleyDesignTokens.swift`, which in turn mirrors the landing
 * site's `--v2-brand` / `--v2-sky` / `--v2-navy`:
 *
 * | role        | light     | dark      |
 * | ----------- | --------- | --------- |
 * | background  | `#FFFFFF` | `#0C1620` |
 * | primary     | `#1469D4` | `#2DB6F3` |
 * | recording   | `#E5322D` | `#FF453A` |
 *
 * Dark mode's page is a navy-black derived from `--v2-navy` (`#1B3A66`) rather
 * than a neutral one, so it still reads as the same product; `primary` switches
 * to sky there because `#1469D4` cannot be read on it.
 *
 * ## Everything else is new, and that is the cost of the switch
 *
 * iOS needs exactly three custom values because UIKit hands it `label`,
 * `secondaryLabel`, `tertiaryLabel` and `separator` — semantic colours that
 * already follow appearance, Increase Contrast and the accessibility contrast
 * settings. Compose has no such thing. `ColorScheme` *is* the semantic layer, so
 * every grey iOS gets from the platform has to be a literal here, and every one
 * of them is a contrast obligation we now carry ourselves (see
 * `ParleyColorSchemeTest`, which is the check that used to be Apple's).
 *
 * The greys are tinted towards the navy rather than neutral, so a hairline on the
 * white page belongs to the same family as the dark page.
 *
 * ## The rules the values encode
 *
 * From `docs/design/ios-visual-language.md`, unchanged by the port:
 *
 * - **White page, ink text.** `surface` is white and the whole light
 *   `surfaceContainer*` ladder sits within 4% of it. Parley does not fill things;
 *   a card here is a whisper (`surfaceVariant` is 1.16:1 against the page), not a
 *   panel.
 * - **Blue is a signal, never a background.** `primary` marks what is happening
 *   now and what can be tapped. It is not a page fill, which is why
 *   `primaryContainer` is pale.
 * - **Recording red outranks the blue.** [ParleyExtendedColors.recording] is that
 *   red and nothing else.
 *
 * `error` is deliberately *not* the recording red. The screens use `error` both
 * for failure text and for the stop-recording button, and a red that has to be
 * readable as 15sp body text on every surface in the ladder is a different red
 * from one that only ever has to be a 3:1 indicator. Dark `error` is therefore
 * `#FF7A70`, a lightened `#FF453A`; `recording` keeps `#FF453A` exactly.
 */
object ParleyPalette {

    // ── The brand primitives (shared with iOS) ──────────────────────────────

    val LightBackground = Color(0xFFFFFFFF)
    val LightPrimary = Color(0xFF1469D4) // --v2-brand
    val LightRecording = Color(0xFFE5322D)

    val DarkBackground = Color(0xFF0C1620) // derived from --v2-navy #1B3A66
    val DarkPrimary = Color(0xFF2DB6F3) // --v2-sky
    val DarkRecording = Color(0xFFFF453A)

    /** 12, not Material's 8 or 16: the same softer corner the iOS app rounds to. */
    const val RADIUS_DP = 12
}

/**
 * Colours Material 3 has no slot for. Reach for [MaterialTheme.colorScheme]
 * first; this is only what the scheme cannot say.
 *
 * @property recording a recording is running — the waveform playhead, the LIVE
 *   badge, the stop control. The one colour allowed to outrank the blue, and
 *   nothing else may use it.
 */
@androidx.compose.runtime.Immutable
data class ParleyExtendedColors(
    val recording: Color,
)

private val LightExtendedColors = ParleyExtendedColors(recording = ParleyPalette.LightRecording)
private val DarkExtendedColors = ParleyExtendedColors(recording = ParleyPalette.DarkRecording)

/**
 * Provided by `ParleyTheme`. Defaults to the light set so a stray `@Preview` that
 * forgets the theme renders something sane rather than throwing.
 */
val LocalParleyColors = staticCompositionLocalOf { LightExtendedColors }

/** `ParleyTheme.colors.recording` — the extended palette for the current scheme. */
object ParleyTheme {
    val colors: ParleyExtendedColors
        @Composable @ReadOnlyComposable
        get() = LocalParleyColors.current
}

internal fun extendedColorsFor(darkTheme: Boolean): ParleyExtendedColors =
    if (darkTheme) DarkExtendedColors else LightExtendedColors

// ── Light ───────────────────────────────────────────────────────────────────
//
// A white page. The container ladder is almost flat on purpose: Material wants
// six visibly separated surfaces, Parley separates things with whitespace, so the
// ladder exists to keep M3's own components (dialogs, menus, the scrolled app
// bar) from picking a grey that fights the page.

internal val ParleyLightColorScheme: ColorScheme = lightColorScheme(
    primary = ParleyPalette.LightPrimary,
    onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFDCEAFB),
    onPrimaryContainer = Color(0xFF0B3E85),
    inversePrimary = ParleyPalette.DarkPrimary,

    // Navy, the landing site's --v2-navy. Used where something needs weight
    // without claiming to be tappable.
    secondary = Color(0xFF1B3A66),
    onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = Color(0xFFDEE7F2),
    onSecondaryContainer = Color(0xFF13294A),

    // Sky, darkened until it can be read on white. The light scheme's stand-in
    // for the colour dark mode uses as `primary`.
    tertiary = Color(0xFF0F6E96),
    onTertiary = Color(0xFFFFFFFF),
    tertiaryContainer = Color(0xFFD4EDF9),
    onTertiaryContainer = Color(0xFF0A3F58),

    // A deepened recording red: `error` is body text 14 times over, and #E5322D
    // only reaches 3.9:1 on white.
    error = Color(0xFFC02A26),
    onError = Color(0xFFFFFFFF),
    errorContainer = Color(0xFFFBDCDB),
    onErrorContainer = Color(0xFF7A1613),

    background = ParleyPalette.LightBackground,
    onBackground = Color(0xFF0C1620),
    surface = ParleyPalette.LightBackground,
    onSurface = Color(0xFF0C1620),

    // The card fill. #EAEFF5 rather than anything darker because `primary` has to
    // stay readable on top of it (4.54:1) — the brand blue is fixed, so the
    // surface is what moves.
    surfaceVariant = Color(0xFFEAEFF5),
    onSurfaceVariant = Color(0xFF46586A),

    // iOS's `separator` is far lighter than this. It cannot be here: the screens
    // colour clock and timestamp text with `outline`, so it is text, and text is
    // 4.5:1.
    outline = Color(0xFF5C6B7A),
    outlineVariant = Color(0xFFCBD5DE),

    surfaceTint = ParleyPalette.LightPrimary,
    inverseSurface = Color(0xFF0C1620),
    inverseOnSurface = Color(0xFFEDF1F5),
    scrim = Color(0xFF000000),

    surfaceBright = Color(0xFFFFFFFF),
    surfaceDim = Color(0xFFEAEFF5),
    surfaceContainerLowest = Color(0xFFFFFFFF),
    surfaceContainerLow = Color(0xFFF8FAFC),
    surfaceContainer = Color(0xFFF3F6F9),
    surfaceContainerHigh = Color(0xFFEEF2F7),
    surfaceContainerHighest = Color(0xFFEAEFF5),
)

// ── Dark ────────────────────────────────────────────────────────────────────
//
// The navy-black page. Text is #E6EDF4 rather than pure white: on a page this
// dark, #FFFFFF at 15sp haloes.

internal val ParleyDarkColorScheme: ColorScheme = darkColorScheme(
    primary = ParleyPalette.DarkPrimary,
    onPrimary = Color(0xFF00243A),
    primaryContainer = Color(0xFF0E4E79),
    onPrimaryContainer = Color(0xFFCBE8FB),
    inversePrimary = ParleyPalette.LightPrimary,

    secondary = Color(0xFFA9C6E6),
    onSecondary = Color(0xFF122C4C),
    // The navy itself works as a container here — it is lighter than the page.
    secondaryContainer = Color(0xFF1B3A66),
    onSecondaryContainer = Color(0xFFD6E5F6),

    tertiary = Color(0xFF8AD5F5),
    onTertiary = Color(0xFF00344A),
    tertiaryContainer = Color(0xFF0B4C68),
    onTertiaryContainer = Color(0xFFC3EAFB),

    // Lightened from the recording red so it clears 4.5:1 as text on every
    // surface, not just on the page. It is kept as close to #FF453A as that
    // allows, because the screens also use `error` as the stop-recording
    // button's fill and a washed-out coral does not read as "stop".
    error = Color(0xFFFF5A50),
    onError = Color(0xFF3E0502),
    errorContainer = Color(0xFF8C1F19),
    onErrorContainer = Color(0xFFFFDAD5),

    background = ParleyPalette.DarkBackground,
    onBackground = Color(0xFFE6EDF4),
    surface = ParleyPalette.DarkBackground,
    onSurface = Color(0xFFE6EDF4),

    surfaceVariant = Color(0xFF1E2A37),
    onSurfaceVariant = Color(0xFFAFC0D0),

    outline = Color(0xFF92A4B6),
    outlineVariant = Color(0xFF2C3947),

    surfaceTint = ParleyPalette.DarkPrimary,
    // Light enough that the brand blue survives as the snackbar's action colour.
    inverseSurface = Color(0xFFF2F5F8),
    inverseOnSurface = Color(0xFF0C1620),
    scrim = Color(0xFF000000),

    // Capped at the card fill rather than set above it: the brightest surface
    // Parley allows in the dark *is* the card. Letting Material go lighter here
    // only buys a tint nothing in this app wants, and it costs every text role
    // contrast — the red especially, which is why this and `error` were chosen
    // together.
    surfaceBright = Color(0xFF1E2A37),
    surfaceDim = Color(0xFF0C1620),
    surfaceContainerLowest = Color(0xFF060E16),
    surfaceContainerLow = Color(0xFF111B25),
    surfaceContainer = Color(0xFF15202B),
    surfaceContainerHigh = Color(0xFF1A2531),
    surfaceContainerHighest = Color(0xFF1E2A37),
)
