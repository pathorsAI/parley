package com.pathors.parley.voicetyping

import android.content.Context
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Build
import androidx.core.content.ContextCompat
import com.pathors.parley.R

/**
 * The keyboard's colors, and the two backgrounds it draws with.
 *
 * Why not `ui/theme/Theme.kt`? Because the keyboard is classic Views (see
 * [ParleyInputMethodService]'s header for that decision), so a Compose
 * `ColorScheme` is not in scope. This is the same palette by other means: the
 * static values are Theme.kt's `primary`/`secondary` seeds with stock Material 3
 * neutrals (`values/colors_keyboard.xml` + `values-night/`), and on API 31+ the
 * accent is swapped for the platform's dynamic color — the same thing
 * `dynamicLightColorScheme()`/`dynamicDarkColorScheme()` does for the app, so a
 * wallpaper-tinted app gets a wallpaper-tinted keyboard.
 */
class KeyboardPalette private constructor(
    val background: Int,
    val onBackground: Int,
    val muted: Int,
    val accent: Int,
    val onAccent: Int,
    val key: Int,
    val onKey: Int,
    val error: Int,
) {
    /** A rounded key face with a ripple, for the bottom row. */
    fun keyBackground(cornerRadiusPx: Float): Drawable = ripple(key, cornerRadiusPx)

    /** The accent-filled call to action shown when setup is incomplete. */
    fun accentBackground(cornerRadiusPx: Float): Drawable = ripple(accent, cornerRadiusPx)

    private fun ripple(fill: Int, cornerRadiusPx: Float): Drawable {
        val face = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = cornerRadiusPx
            setColor(fill)
        }
        val mask = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = cornerRadiusPx
            setColor(Color.WHITE)
        }
        // A translucent neutral reads correctly on both a light and a dark face,
        // which is what lets one ripple color serve the whole palette.
        return RippleDrawable(ColorStateList.valueOf(RIPPLE), face, mask)
    }

    companion object {
        private const val RIPPLE = 0x33808080

        fun of(context: Context): KeyboardPalette {
            val dark = (context.resources.configuration.uiMode and
                Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
            val color = { id: Int -> ContextCompat.getColor(context, id) }
            var accent = color(R.color.keyboard_accent)
            var onAccent = color(R.color.keyboard_on_accent)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // The same tonal slots Material 3 maps primary/onPrimary to.
                accent = color(
                    if (dark) android.R.color.system_accent1_200
                    else android.R.color.system_accent1_600
                )
                onAccent = color(
                    if (dark) android.R.color.system_accent1_800
                    else android.R.color.system_accent1_0
                )
            }
            return KeyboardPalette(
                background = color(R.color.keyboard_background),
                onBackground = color(R.color.keyboard_on_background),
                muted = color(R.color.keyboard_muted),
                accent = accent,
                onAccent = onAccent,
                key = color(R.color.keyboard_key),
                onKey = color(R.color.keyboard_on_key),
                error = color(R.color.keyboard_error),
            )
        }
    }
}
