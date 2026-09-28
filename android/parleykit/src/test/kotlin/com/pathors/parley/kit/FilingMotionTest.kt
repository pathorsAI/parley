package com.pathors.parley.kit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FilingMotionTest {

    @Test
    fun `the spring is iOS's response and damping in Compose's terms`() {
        // (2π / 0.5)² ≈ 157.9 × 4 — a unit mass, so stiffness is ω².
        assertEquals(157.91367f, FilingMotion.SPRING_STIFFNESS, 0.01f)
        assertEquals(0.8f, FilingMotion.SPRING_DAMPING, 0f)
    }

    @Test
    fun `a title types in one character at a time`() {
        assertEquals("", FilingMotion.typed(RENEWAL, 0))
        assertEquals("A", FilingMotion.typed(RENEWAL, 1))
        assertEquals("Acme", FilingMotion.typed(RENEWAL, 4))
        assertEquals("past the end is the whole title", RENEWAL, FilingMotion.typed(RENEWAL, 99))
        assertEquals("", FilingMotion.typed(RENEWAL, -3))
    }

    @Test
    fun `chinese and emoji type in as whole characters`() {
        val title = "客戶續約👍"
        assertEquals(5, FilingMotion.characterCount(title))
        assertEquals("客戶", FilingMotion.typed(title, 2))
        assertEquals("an emoji is one step, never half a surrogate pair", title, FilingMotion.typed(title, 5))
        assertEquals("客戶續約", FilingMotion.typed(title, 4))
    }

    @Test
    fun `typing takes 22 ms a character`() {
        assertEquals(RENEWAL.length * 22L, FilingMotion.typingDurationMs(RENEWAL))
        assertEquals(0L, FilingMotion.typingDurationMs(""))
    }

    @Test
    fun `a title types itself in once per session`() {
        val titles = FilingMotion.TypedTitles()
        assertTrue(titles.claim(RENEWAL))
        assertFalse("the second visit shows it whole", titles.claim(RENEWAL))
        assertTrue(titles.contains(RENEWAL))
        assertTrue("another title is its own first time", titles.claim("Globex kickoff"))
        assertFalse("nothing to type", titles.claim(""))
    }

    private companion object {
        const val RENEWAL = "Acme renewal terms"
    }
}
