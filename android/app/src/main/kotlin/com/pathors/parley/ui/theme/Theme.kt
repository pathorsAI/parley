package com.pathors.parley.ui.theme

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.graphics.drawable.ColorDrawable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat

/**
 * Parley's Material 3 theme: the brand's colours, the brand's faces, the brand's
 * corner, and an appearance the user can pin from inside the app.
 *
 * ## Why this is no longer stock Material
 *
 * This file used to say the opposite, and said it for a good reason: it took the
 * system's light/dark setting and, on Android 12 and up, the user's wallpaper
 * colours, on the grounds that an Android app which looks like the rest of the
 * phone is cheaper to maintain and better behaved. That was true as far as it
 * went. What it cost was that Parley had no face on Android. Roughly nine in ten
 * installs run Android 12 or later, so for nearly everyone the app was tinted by
 * their wallpaper — the brand blue only ever reached the minority on Android 11
 * and below, and even there the fallback was a teal (`#00696E`) that matched
 * neither iOS nor the landing site.
 *
 * Parley is one product sold as one product. It is demonstrated to customers next
 * to the iOS app, the desktop app and the website, and "the Android one looks
 * like your wallpaper" is not a thing a prospect hears as platform good manners.
 * So the visual language now comes from the same place on every client:
 * `docs/design/ios-visual-language.md` — white page, ink text, blue as a signal,
 * recording red above everything, DM Sans with Alexandria for the wordmark.
 *
 * ## What we gave up, and who owns it now
 *
 * Dynamic colour was not only a look. Material generates those schemes with
 * guaranteed tonal distances, so contrast held automatically, and it participated
 * in the system's high-contrast and colour-correction settings. **None of that is
 * free any more.** A hand-written scheme is a hand-checked scheme:
 *
 * - Contrast is now our obligation. `ParleyColorSchemeTest` is the replacement:
 *   it walks every text role across every surface a Material component can put it
 *   on and fails the build under WCAG AA. Changing a hex without running it is
 *   how this app ships unreadable secondary text.
 * - There is no high-contrast variant. Android's "high contrast text" setting
 *   still works — it is drawn by the platform, over whatever colours we give it —
 *   but the system's contrast slider on Android 14+ no longer has a scheme to
 *   move. If that becomes a complaint, the fix is a third and fourth
 *   `ColorScheme` selected off `UiModeManager.contrastLevel`, not a return to
 *   dynamic colour.
 * - Bundled fonts cost ~410KB of APK, and mean Chinese is drawn by a different
 *   font from the Latin around it. [ParleyTypography] explains what holds the two
 *   together.
 *
 * ## Appearance is the user's choice
 *
 * [preference] defaults to the value persisted by [ThemePreferenceStore], so the
 * app honours a choice made in settings and falls back to the device setting when
 * there is none — the same three-way System / Light / Dark that iOS offers. Pass
 * [preference] explicitly only to force an appearance, as a `@Preview` would.
 *
 * Because the app can now be dark while the device is light, the status and
 * navigation bar icons no longer follow the system on their own; this is where
 * they are flipped.
 */
@Composable
fun ParleyTheme(
    preference: ThemePreference = rememberThemePreference(),
    content: @Composable () -> Unit,
) {
    val darkTheme = when (preference) {
        ThemePreference.SYSTEM -> isSystemInDarkTheme()
        ThemePreference.LIGHT -> false
        ThemePreference.DARK -> true
    }
    val colorScheme = if (darkTheme) ParleyDarkColorScheme else ParleyLightColorScheme

    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = view.context.findActivity()?.window ?: return@SideEffect
            // The status and navigation bars are transparent (themes.xml), so what
            // shows through them is the window background — and that is resolved
            // from `?android:attr/colorBackground`, which follows the *device's*
            // night mode. The moment the app can disagree with the device, that
            // stops being good enough: pick Dark on a light phone and the page
            // goes navy while the two bands behind the system bars stay grey,
            // with white icons drawn on them. So the window background is set
            // from the scheme rather than from the configuration.
            window.setBackgroundDrawable(ColorDrawable(colorScheme.background.toArgb()))
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !darkTheme
                isAppearanceLightNavigationBars = !darkTheme
            }
        }
    }

    CompositionLocalProvider(LocalParleyColors provides extendedColorsFor(darkTheme)) {
        MaterialTheme(
            colorScheme = colorScheme,
            typography = ParleyTypography,
            shapes = ParleyShapes,
            content = content,
        )
    }
}

/**
 * 12dp is the Parley corner — the same one `ParleyDesignTokens.radius` sets on
 * iOS, chosen there as softer than the platform's 10. It is repeated across
 * `small` through `large` so that the component a screen happens to reach for
 * does not change the radius: Material's defaults would round a card to 12, a
 * chip to 8 and a bottom sheet to 28, and three radii on one screen is exactly
 * the drift this file exists to stop.
 *
 * `extraSmall` stays tighter for the things that are nearly square anyway
 * (tooltips, the small end of menus), and `extraLarge` stays larger for the
 * sheet's top edge, where 12 reads as an unfinished 28 rather than as a choice.
 */
private val ParleyShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(ParleyPalette.RADIUS_DP.dp),
    medium = RoundedCornerShape(ParleyPalette.RADIUS_DP.dp),
    large = RoundedCornerShape(ParleyPalette.RADIUS_DP.dp),
    extraLarge = RoundedCornerShape(20.dp),
)

/** The `Activity` behind a composition's context, through any `ContextWrapper`s. */
private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}
