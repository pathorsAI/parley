package com.pathors.parley.audio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PlatformSilenceEdgeTest {

    @Test
    fun `our own record starting is not an interruption ending`() {
        val edge = PlatformSilenceEdge()
        assertNull(edge.observe(anyRecording = true, anySilenced = false))
    }

    @Test
    fun `our own record stopping says nothing`() {
        val edge = PlatformSilenceEdge()
        assertNull(edge.observe(anyRecording = false, anySilenced = false))
    }

    @Test
    fun `a rebuild loop produces no events at all`() {
        // The 1.13 sequence: start, then rebuild after rebuild, each one a stop
        // (empty list) followed by a start (one unsilenced configuration).
        val edge = PlatformSilenceEdge()
        assertNull(edge.observe(anyRecording = true, anySilenced = false))
        repeat(50) {
            assertNull(edge.observe(anyRecording = false, anySilenced = false))
            assertNull(edge.observe(anyRecording = true, anySilenced = false))
        }
    }

    @Test
    fun `being silenced is reported once`() {
        val edge = PlatformSilenceEdge()
        edge.observe(anyRecording = true, anySilenced = false)
        assertEquals(true, edge.observe(anyRecording = true, anySilenced = true))
        assertNull(edge.observe(anyRecording = true, anySilenced = true))
    }

    @Test
    fun `a rebuild while still silenced does not end the interruption`() {
        val edge = PlatformSilenceEdge()
        edge.observe(anyRecording = true, anySilenced = false)
        assertEquals(true, edge.observe(anyRecording = true, anySilenced = true))
        // The recovery ladder stops and reopens the record; the other app still
        // holds the microphone, so the new record is silenced as well.
        assertNull(edge.observe(anyRecording = false, anySilenced = false))
        assertNull(edge.observe(anyRecording = true, anySilenced = true))
    }

    @Test
    fun `the microphone coming back is reported once`() {
        val edge = PlatformSilenceEdge()
        edge.observe(anyRecording = true, anySilenced = false)
        edge.observe(anyRecording = true, anySilenced = true)
        assertEquals(false, edge.observe(anyRecording = true, anySilenced = false))
        assertNull(edge.observe(anyRecording = true, anySilenced = false))
    }

    @Test
    fun `silenced from the very first delivery is still reported`() {
        // The record can open straight into a takeover (another app already
        // had the microphone when the meeting started).
        val edge = PlatformSilenceEdge()
        assertEquals(true, edge.observe(anyRecording = true, anySilenced = true))
    }
}
