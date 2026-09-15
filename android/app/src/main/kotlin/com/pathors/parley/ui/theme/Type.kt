package com.pathors.parley.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp
import com.pathors.parley.R

/**
 * Parley's type scale in the Pathors faces, as a Material 3 [Typography].
 *
 * DM Sans is everything the user reads; Alexandria is the wordmark and large
 * standalone numerals and nothing else. That split is the landing site's
 * (`components/v2/v2.css`) and iOS's (`ios/App/Parley/ParleyTypography.swift`),
 * and it is enforced here by which M3 slots each face occupies: `display*` is
 * Alexandria, every other slot is DM Sans. A call site that reaches for
 * `displayLarge` gets the display face; one that reaches for `headlineLarge`
 * gets DM Sans at the same size.
 *
 * ## The faces are bundled, not downloaded
 *
 * `res/font/` holds the six TTFs, byte-identical to the ones the iOS target
 * ships from `ios/App/Parley/Resources/Fonts/` (OFL; the licence texts are in
 * `res/raw/`). Downloadable fonts would have saved ~410KB of APK, and they were
 * the wrong trade for this app:
 *
 * - Parley records meetings, and is expected to work with no network. A
 *   downloadable font resolves asynchronously through Play Services, so a first
 *   launch offline draws Roboto and stays that way until some later fetch
 *   succeeds.
 * - Even online, the provider query is async on *every* cold start until the
 *   cache warms, which is a visible Roboto-to-DM-Sans reflow on the first frame.
 * - It requires Play Services at all, and Parley is open source and installed on
 *   devices that do not have them.
 *
 * ## Sizes are `sp`, and the scale is iOS's
 *
 * Every size below is `sp`, so the system font-size setting still scales the app
 * — the Android equivalent of the `relativeTo:` the iOS scale is built with. The
 * numbers are the iOS role sizes (17 body, 15 subheadline, 13 footnote…) rather
 * than Material's defaults, so the two apps set the same text at the same size.
 *
 * ## Chinese
 *
 * Neither face has a single CJK glyph and the app's default language is zh-TW, so
 * on most screens most of the text is drawn by the system's **Noto Sans CJK TC**
 * and only the Latin runs are ours. Android does that per-glyph without being
 * asked.
 *
 * What does *not* come for free is the leading. Noto Sans CJK TC's default line
 * spacing is about 1.48em against DM Sans' 1.30em, so left alone a paragraph that
 * mixes the two gets ragged: the all-Latin lines close up and the mixed lines
 * open out. Two things fix it, and both are load-bearing:
 *
 * 1. **Every style sets an explicit `lineHeight`.** A fixed line box is the same
 *    height whichever font drew the glyphs, so Latin, Chinese and mixed lines in
 *    one paragraph all step by the same amount.
 * 2. **[ParleyLineHeightStyle] centres the text in that box and does not trim
 *    it.** Centring keeps the two faces' differing ascents from pushing the
 *    baseline around between lines; `Trim.None` keeps the first line's ascent and
 *    the last line's descent, so nothing clips even though the box (1.24–1.50em)
 *    is shorter than Noto CJK's natural 1.48em metric. It can be: that metric is
 *    generous padding, and the actual TC glyph ink is about 1.0em.
 *
 * Compose 1.6 onwards already defaults `includeFontPadding` to `false`, which is
 * the other half of this working; it is not set here because setting it would
 * mean opting into an experimental API to restate the default.
 *
 * Cap height still differs — DM Sans is 0.70em against Noto CJK's ~0.88em — so
 * Chinese reads slightly larger beside Latin at the same size. That is true of
 * Roboto too, so it is not a regression, and it is why the scale is not tuned any
 * smaller.
 */
val DMSans = FontFamily(
    Font(R.font.dm_sans_regular, FontWeight.Normal),
    Font(R.font.dm_sans_medium, FontWeight.Medium),
    Font(R.font.dm_sans_semibold, FontWeight.SemiBold),
    Font(R.font.dm_sans_bold, FontWeight.Bold),
)

/** The display face. The wordmark and large numerals only — see [ParleyTypography]. */
val Alexandria = FontFamily(
    Font(R.font.alexandria_semibold, FontWeight.SemiBold),
    Font(R.font.alexandria_bold, FontWeight.Bold),
)

/**
 * Centre the glyphs in the fixed line box and keep the outer padding. This is
 * what makes a mixed Chinese/Latin paragraph step evenly instead of jittering
 * between the two faces' ascents.
 */
private val ParleyLineHeightStyle = LineHeightStyle(
    alignment = LineHeightStyle.Alignment.Center,
    trim = LineHeightStyle.Trim.None,
)

private fun parleyStyle(
    family: FontFamily,
    weight: FontWeight,
    size: Int,
    lineHeight: Int,
    letterSpacing: TextUnit = 0.sp,
    features: String? = null,
) = TextStyle(
    fontFamily = family,
    fontWeight = weight,
    fontSize = size.sp,
    lineHeight = lineHeight.sp,
    // Material tracks its scale out by up to 0.5sp. DM Sans is already wide, and
    // letter-spacing applied to a run of Chinese looks like a typesetting fault,
    // so the scale is set solid and only the two largest sizes are tightened.
    letterSpacing = letterSpacing,
    fontFeatureSettings = features,
    lineHeightStyle = ParleyLineHeightStyle,
)

private fun dmSans(weight: FontWeight, size: Int, lineHeight: Int, tracking: TextUnit = 0.sp) =
    parleyStyle(DMSans, weight, size, lineHeight, tracking)

/** Tabular figures, so a running timer does not shuffle its own digits sideways. */
private fun alexandria(weight: FontWeight, size: Int, lineHeight: Int, tracking: TextUnit = 0.sp) =
    parleyStyle(Alexandria, weight, size, lineHeight, tracking, features = "tnum")

/**
 * The scale. Slot by slot against the iOS roles it mirrors:
 *
 * | M3 slot        | face / weight        | size | iOS role               |
 * | -------------- | -------------------- | ---- | ---------------------- |
 * | displayLarge   | Alexandria SemiBold  | 34   | `displayNumber`        |
 * | displayMedium  | Alexandria SemiBold  | 28   | —                      |
 * | displaySmall   | Alexandria SemiBold  | 22   | `wordmark`'s size      |
 * | headlineLarge  | DM Sans Bold         | 34   | `largeTitle`           |
 * | headlineMedium | DM Sans Bold         | 28   | `title`                |
 * | headlineSmall  | DM Sans SemiBold     | 22   | `title2`               |
 * | titleLarge     | DM Sans SemiBold     | 20   | `title3`               |
 * | titleMedium    | DM Sans SemiBold     | 17   | `headline`             |
 * | titleSmall     | DM Sans Medium       | 15   | `subheadlineEmphasized`|
 * | bodyLarge      | DM Sans Regular      | 17   | `body`                 |
 * | bodyMedium     | DM Sans Regular      | 16   | `callout`              |
 * | bodySmall      | DM Sans Regular      | 15   | `subheadline`          |
 * | labelLarge     | DM Sans Medium       | 15   | —  (button)            |
 * | labelMedium    | DM Sans Medium       | 13   | `footnote`             |
 * | labelSmall     | DM Sans Medium       | 12   | `caption`              |
 */
val ParleyTypography = Typography(
    displayLarge = alexandria(FontWeight.SemiBold, 34, 42, (-0.5).sp),
    displayMedium = alexandria(FontWeight.SemiBold, 28, 36, (-0.25).sp),
    displaySmall = alexandria(FontWeight.SemiBold, 22, 30),

    headlineLarge = dmSans(FontWeight.Bold, 34, 42, (-0.5).sp),
    headlineMedium = dmSans(FontWeight.Bold, 28, 36, (-0.25).sp),
    headlineSmall = dmSans(FontWeight.SemiBold, 22, 30),

    titleLarge = dmSans(FontWeight.SemiBold, 20, 28),
    titleMedium = dmSans(FontWeight.SemiBold, 17, 24),
    titleSmall = dmSans(FontWeight.Medium, 15, 22),

    bodyLarge = dmSans(FontWeight.Normal, 17, 25),
    bodyMedium = dmSans(FontWeight.Normal, 16, 24),
    bodySmall = dmSans(FontWeight.Normal, 15, 22),

    labelLarge = dmSans(FontWeight.Medium, 15, 20),
    labelMedium = dmSans(FontWeight.Medium, 13, 18),
    labelSmall = dmSans(FontWeight.Medium, 12, 16),
)

/**
 * The few roles Material's fifteen slots have no honest home for. Prefer
 * `MaterialTheme.typography`; add to this only when a second call site wants the
 * same thing.
 */
object ParleyTextStyles {
    /** The Parley wordmark. Nothing else gets Alexandria at this size. */
    val wordmark: TextStyle = parleyStyle(Alexandria, FontWeight.Bold, 22, 28)

    /** A duration, a count, a stat. Same as `displayLarge`, named for what it is. */
    val displayNumber: TextStyle = ParleyTypography.displayLarge

    /** Body weight-forward, for a label that is not quite a `titleMedium`. */
    val bodyEmphasized: TextStyle = dmSans(FontWeight.Medium, 17, 25)

    /** iOS `caption2` — the smallest thing on screen. */
    val caption2: TextStyle = dmSans(FontWeight.Normal, 11, 15)
}
