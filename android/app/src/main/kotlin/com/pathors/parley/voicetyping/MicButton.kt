package com.pathors.parley.voicetyping

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.drawable.Drawable
import android.util.AttributeSet
import android.view.View
import androidx.core.content.ContextCompat
import androidx.core.graphics.ColorUtils
import com.pathors.parley.R
import kotlin.math.min

/**
 * The keyboard's mic toggle: a filled circle, a mic/stop glyph, and — while
 * listening — a ring that breathes with the input level.
 *
 * A custom [View] rather than an `ImageButton` because of that ring. The level is
 * the only honest answer to "is it hearing me": Android hands a muted app
 * *silence* rather than an error when another app has taken the microphone
 * (see [com.pathors.parley.audio.MicCapture]'s error policy), so a keyboard with
 * no level indicator cannot tell "quiet room" from "your mic was stolen".
 * Redrawing one circle per audio chunk is also cheaper than animating a view
 * hierarchy inside a process that is hosting somebody else's text field.
 */
class MicButton @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {

    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val ringPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val micIcon: Drawable? = ContextCompat.getDrawable(context, R.drawable.ic_kb_mic)
    private val stopIcon: Drawable? = ContextCompat.getDrawable(context, R.drawable.ic_kb_stop)

    var palette: KeyboardPalette = KeyboardPalette.of(context)
        set(value) {
            field = value
            invalidate()
        }

    /** Listening — the button offers "stop" and the level ring is live. */
    var listening: Boolean = false
        set(value) {
            if (field == value) return
            field = value
            invalidate()
        }

    /**
     * Greyed out: the mic is not available to us (setup incomplete, or the
     * session is still finishing). Still tappable — the tap is what starts the
     * hand-off — so this is deliberately not [setEnabled], which would also
     * make the view unclickable and inaudible to TalkBack.
     */
    var muted: Boolean = false
        set(value) {
            if (field == value) return
            field = value
            invalidate()
        }

    /** Input level, 0..1. Cheap to set on every audio chunk. */
    var level: Float = 0f
        set(value) {
            val clamped = value.coerceIn(0f, 1f)
            // Ignore changes too small to see; the mic publishes ~10 per second.
            if (kotlin.math.abs(clamped - field) < LEVEL_EPSILON) return
            field = clamped
            if (listening) invalidate()
        }

    init {
        isClickable = true
        isFocusable = true
    }

    override fun onDraw(canvas: Canvas) {
        val cx = width / 2f
        val cy = height / 2f
        val outer = min(width, height) / 2f
        val face = outer * FACE_FRACTION

        if (listening) {
            // Speech RMS lives near the bottom of the range, so scale it up
            // before mapping to the ring — otherwise normal speaking barely
            // moves it.
            val reach = (level * LEVEL_GAIN).coerceIn(0f, 1f)
            ringPaint.color = ColorUtils.setAlphaComponent(palette.accent, RING_ALPHA)
            ringPaint.strokeWidth = outer * RING_STROKE_FRACTION
            val radius = face + (outer - face) * reach
            canvas.drawCircle(cx, cy, radius - ringPaint.strokeWidth / 2f, ringPaint)
        }

        val base = if (muted) palette.key else palette.accent
        fillPaint.color = if (isPressed) {
            ColorUtils.blendARGB(base, palette.onBackground, PRESS_BLEND)
        } else {
            base
        }
        canvas.drawCircle(cx, cy, face, fillPaint)

        val icon = (if (listening) stopIcon else micIcon) ?: return
        val half = (face * ICON_FRACTION).toInt()
        icon.setTint(if (muted) palette.onKey else palette.onAccent)
        icon.setBounds(cx.toInt() - half, cy.toInt() - half, cx.toInt() + half, cy.toInt() + half)
        icon.draw(canvas)
    }

    override fun setPressed(pressed: Boolean) {
        super.setPressed(pressed)
        invalidate()
    }

    private companion object {
        /** Circle radius as a fraction of the view's half-size. */
        const val FACE_FRACTION = 0.66f
        const val ICON_FRACTION = 0.58f
        const val RING_STROKE_FRACTION = 0.10f
        const val RING_ALPHA = 110
        const val LEVEL_GAIN = 4f
        const val LEVEL_EPSILON = 0.01f
        const val PRESS_BLEND = 0.16f
    }
}
