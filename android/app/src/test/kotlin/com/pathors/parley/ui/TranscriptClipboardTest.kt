package com.pathors.parley.ui

import com.pathors.parley.cloud.TranscriptSegmentDto
import com.pathors.parley.kit.TranscriptSegment
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The pasted shape, pinned.
 *
 * This is a cross-platform contract, not a formatting preference: iOS writes the
 * same text (`ios/App/Parley/TranscriptClipboard.swift`), and people paste
 * transcripts from both phones into the same documents and mail threads. Two
 * spaces before the clock, the words on their own line, one blank line between
 * turns — a change to any of those silently splits the two platforms apart, so
 * it has to break here first.
 */
class TranscriptClipboardTest {

    private fun live(id: String, speaker: Int, text: String, startMs: Long) = TranscriptSegment(
        id = id,
        source = "mix",
        speaker = speaker,
        text = text,
        isFinal = true,
        startMs = startMs,
        endMs = startMs + 1_000,
    )

    private fun stored(id: String, text: String, startMs: Long) = TranscriptSegmentDto(
        id = id,
        text = text,
        startMs = startMs,
        endMs = startMs + 1_000,
    )

    @Test
    fun `a turn is the label, two spaces, the clock, then the words`() {
        assertEquals(
            "Speaker 1  0:12\nLet's start with the renewal.",
            TranscriptClipboard.plainText("Speaker 1", 12_000, "Let's start with the renewal."),
        )
    }

    @Test
    fun `turns are separated by a blank line`() {
        val segments = listOf(
            live("mix-0", 1, "Let's start with the renewal.", 12_000),
            live("mix-1", 2, "Sure — the term is the part we want to revisit.", 19_400),
        )

        assertEquals(
            "Speaker 1  0:12\nLet's start with the renewal.\n\n" +
                "Speaker 2  0:19\nSure — the term is the part we want to revisit.",
            TranscriptClipboard.liveTranscript(segments) { "Speaker ${it.speaker}" },
        )
    }

    @Test
    fun `a stored transcript pastes identically to a live one`() {
        val same = "Speaker 1  1:05\nAgreed."
        assertEquals(
            same,
            TranscriptClipboard.liveTranscript(listOf(live("mix-0", 1, "Agreed.", 65_000))) {
                "Speaker 1"
            },
        )
        assertEquals(
            same,
            TranscriptClipboard.storedTranscript(listOf(stored("mix-0", "Agreed.", 65_000))) {
                "Speaker 1"
            },
        )
    }

    /** Minutes keep counting past an hour rather than rolling over to 0:xx. */
    @Test
    fun `the clock is minutes and seconds, however long the meeting ran`() {
        assertEquals(
            "Speaker 1  62:05\nStill here.",
            TranscriptClipboard.plainText("Speaker 1", 3_725_000, "Still here."),
        )
    }

    @Test
    fun `an empty transcript is an empty string, not a stray separator`() {
        assertEquals("", TranscriptClipboard.liveTranscript(emptyList()) { "Speaker 1" })
        assertEquals("", TranscriptClipboard.storedTranscript(emptyList()) { "Speaker 1" })
    }

    @Test
    fun `a single turn carries no separator`() {
        assertEquals(
            "Nadia  0:00\nMorning.",
            TranscriptClipboard.storedTranscript(listOf(stored("mix-0", "Morning.", 0))) { "Nadia" },
        )
    }
}
