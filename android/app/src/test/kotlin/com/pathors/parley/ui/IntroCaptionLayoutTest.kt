package com.pathors.parley.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/** Where the sign-in film's caption sits over the scrolling pitch — see `FilmPitch`. */
class IntroCaptionLayoutTest {

    @Test
    fun `it sits under the stage when that place is on screen`() {
        assertEquals(PLACE, stickyCaptionTop(PLACE.toFloat(), 0, TALL, CAPTION))
    }

    @Test
    fun `on a short screen it sticks above the button instead of going under it`() {
        assertEquals(
            SHORT - CAPTION,
            stickyCaptionTop(PLACE.toFloat(), scroll = 0, viewportHeight = SHORT, captionHeight = CAPTION),
        )
    }

    @Test
    fun `scrolling brings its place into view, and it follows the stage from there`() {
        val scrolled = PLACE - SHORT + CAPTION + 50
        assertEquals(SHORT - CAPTION - 50, stickyCaptionTop(PLACE.toFloat(), scrolled, SHORT, CAPTION))
    }

    @Test
    fun `it never goes above the top of the pitch`() {
        assertEquals(0, stickyCaptionTop(PLACE.toFloat(), 0, CAPTION / 2, CAPTION))
    }

    private companion object {
        const val PLACE = 1_500
        const val CAPTION = 120
        const val SHORT = 1_000
        const val TALL = 3_000
    }
}
