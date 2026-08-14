package com.pathors.parley.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

/**
 * Stock Material 3, following the system's light/dark setting, with the user's
 * wallpaper colors on Android 12+.
 *
 * No custom design system on purpose: the desktop and iOS apps carry Parley's
 * visual identity, and an Android app that looks like the rest of the phone is
 * both cheaper to maintain and better behaved (contrast, large text, high
 * contrast themes all come for free).
 */
private val LightColors = lightColorScheme(
    primary = Color(0xFF00696E),
    secondary = Color(0xFF4A6365),
    error = Color(0xFFBA1A1A),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF4FD8DF),
    secondary = Color(0xFFB1CBCD),
    error = Color(0xFFFFB4AB),
)

@Composable
fun ParleyTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val context = LocalContext.current
    val colors = when {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ->
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)

        darkTheme -> DarkColors
        else -> LightColors
    }
    MaterialTheme(colorScheme = colors, content = content)
}
