package com.pathors.parley.kit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The lap's one burst: 26 pieces, 1.5 s, the same every time, and gone after. */
class LapConfettiTest {

    @Test
    fun `twenty-six pieces start along the bottom, fully opaque`() {
        val pieces = LapConfetti.pieces(0.0, WIDTH, HEIGHT)
        assertEquals(26, pieces.size)
        assertTrue(pieces.all { it.y == HEIGHT && it.alpha == 1.0 })
        // A spread of start points, half the width wide, around the centre.
        assertTrue(pieces.all { it.x >= WIDTH / 4 && it.x <= WIDTH * 3 / 4 })
    }

    @Test
    fun `they fly up first and fade as they go`() {
        val early = LapConfetti.pieces(0.2, WIDTH, HEIGHT)
        assertTrue("thrown upwards", early.all { it.y < HEIGHT })
        val late = LapConfetti.pieces(1.4, WIDTH, HEIGHT)
        assertTrue(late.first().alpha < early.first().alpha)
    }

    @Test
    fun `the burst lasts one and a half seconds and then draws nothing`() {
        assertTrue(LapConfetti.pieces(1.49, WIDTH, HEIGHT).isNotEmpty())
        assertTrue(LapConfetti.pieces(1.5, WIDTH, HEIGHT).isEmpty())
        assertTrue(LapConfetti.pieces(-0.1, WIDTH, HEIGHT).isEmpty())
    }

    @Test
    fun `the same frame is the same every time`() {
        assertEquals(LapConfetti.pieces(0.7, WIDTH, HEIGHT), LapConfetti.pieces(0.7, WIDTH, HEIGHT))
    }

    @Test
    fun `the draws are spread over zero to one`() {
        val draws = (0 until 26).flatMap { i -> (1..3).map { LapConfetti.unit(i, it) } }
        assertTrue(draws.all { it >= 0.0 && it < 1.0 })
        assertTrue("not all the same", draws.toSet().size > 20)
    }

    private companion object {
        const val WIDTH = 360.0
        const val HEIGHT = 260.0
    }
}
