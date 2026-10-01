package com.pathors.parley.feedback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The in-memory log a report carries: bounded, scrubbed on the way in, newest kept. */
class LogRingTest {

    @Test
    fun `the oldest line goes when the ring is full`() {
        val ring = LogRing(capacity = 3)
        (1..5).forEach { ring.record('I', "T", "line $it", atMs = it.toLong()) }

        assertEquals(listOf("line 3", "line 4", "line 5"), ring.snapshot().map { it.message })
    }

    @Test
    fun `a token never reaches memory, let alone a report`() {
        val ring = LogRing()
        ring.record('W', "Auth", "refused Bearer Zx8Q2mN4pL7vR1sT9wY3bC6dF0gH5jK2 for owner@example.com")

        val stored = ring.snapshot().single().message
        assertFalse(stored, stored.contains("Zx8Q2m"))
        assertFalse(stored, stored.contains("owner@example.com"))
    }

    @Test
    fun `an exception is kept as its class, its scrubbed message and its top frames`() {
        val ring = LogRing()
        ring.record('E', "Upload", "failed", IllegalStateException("token=abc123 expired"))

        val entry = ring.snapshot().single()
        assertEquals("IllegalStateException: token=<redacted> expired", entry.error)
        assertTrue(entry.frames!!.lines().size <= 8)
        assertTrue(entry.isProblem)
    }

    @Test
    fun `rendering keeps the newest lines that fit`() {
        val entries = (1..100).map { LogRing.Entry(atMs = 0, level = 'I', tag = "T", message = "line $it") }
        val text = LogRing.render(entries, maxBytes = 200)

        assertTrue(text.toByteArray().size <= 200)
        assertTrue(text.endsWith("line 100"))
        assertFalse(text.contains("line 1\n"))
    }
}
