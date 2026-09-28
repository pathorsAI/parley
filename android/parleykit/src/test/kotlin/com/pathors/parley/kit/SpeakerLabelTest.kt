package com.pathors.parley.kit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** iOS `SpeakerLetterTests`, plus the desktop sources `CloudModels.swift` names. */
class SpeakerLabelTest {

    private val english = SpeakerLabel.Strings(
        you = "You",
        youNumbered = "You %1\$d",
        them = "Them",
        remoteNumbered = "Remote %1\$d",
        lettered = "Speaker %1\$s",
    )

    private val chinese = SpeakerLabel.Strings(
        you = "我",
        youNumbered = "我 %1\$d",
        them = "對方",
        remoteNumbered = "對方 %1\$d",
        lettered = "講者 %1\$s",
    )

    @Test
    fun `the first twenty-six are single letters`() {
        assertEquals("A", SpeakerLabel.letter(1))
        assertEquals("B", SpeakerLabel.letter(2))
        assertEquals("C", SpeakerLabel.letter(3))
        assertEquals("Y", SpeakerLabel.letter(25))
        assertEquals("Z", SpeakerLabel.letter(26))
    }

    @Test
    fun `past Z it counts like spreadsheet columns`() {
        assertEquals("AA", SpeakerLabel.letter(27))
        assertEquals("AB", SpeakerLabel.letter(28))
        assertEquals("AZ", SpeakerLabel.letter(52))
        assertEquals("BA", SpeakerLabel.letter(53))
        assertEquals("ZZ", SpeakerLabel.letter(702))
        assertEquals("AAA", SpeakerLabel.letter(703))
    }

    @Test
    fun `non-speaker indices are empty`() {
        assertEquals("", SpeakerLabel.letter(0))
        assertEquals("", SpeakerLabel.letter(-1))
    }

    @Test
    fun `every index up to a thousand is unique and alphabetic`() {
        val seen = mutableSetOf<String>()
        for (n in 1..1_000) {
            val letters = SpeakerLabel.letter(n)
            assertTrue("speaker $n got $letters", letters.isNotEmpty() && letters.all { it in 'A'..'Z' })
            assertTrue("$letters handed out twice", seen.add(letters))
        }
    }

    @Test
    fun `a phone's mix segments are letters, and undecided is an ellipsis`() {
        assertEquals("Speaker A", SpeakerLabel.fallback("mix", 1, english))
        assertEquals("Speaker B", SpeakerLabel.fallback("mix", 2, english))
        assertEquals("講者 A", SpeakerLabel.fallback("mix", 1, chinese))
        assertEquals("…", SpeakerLabel.fallback("mix", 0, english))
        assertEquals("…", SpeakerLabel.fallback("mix", 0, chinese))
    }

    @Test
    fun `desktop me and them sources name the two sides`() {
        assertEquals("You", SpeakerLabel.fallback("me", 1, english))
        assertEquals("You", SpeakerLabel.fallback("me", 0, english))
        assertEquals("You 2", SpeakerLabel.fallback("me", 2, english))
        assertEquals("Them", SpeakerLabel.fallback("them", 1, english))
        assertEquals("Remote 3", SpeakerLabel.fallback("them", 3, english))
        assertEquals("我", SpeakerLabel.fallback("me", 1, chinese))
        assertEquals("對方 2", SpeakerLabel.fallback("them", 2, chinese))
    }

    @Test
    fun `an assigned name always wins, and an empty one does not`() {
        val names = mapOf("mix-1" to "Anna", "them-1" to "Mr. Lin", "mix-2" to "")
        assertEquals("Anna", SpeakerLabel.label("mix", 1, names, english))
        assertEquals("Mr. Lin", SpeakerLabel.label("them", 1, names, english))
        assertEquals("Speaker B", SpeakerLabel.label("mix", 2, names, english))
        // Keyed by source too: mix-1's name is not me-1's.
        assertEquals("You", SpeakerLabel.label("me", 1, names, english))
    }
}
