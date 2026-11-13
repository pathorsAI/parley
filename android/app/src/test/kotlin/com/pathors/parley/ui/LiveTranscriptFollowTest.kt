package com.pathors.parley.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The rules behind the live transcript's follow: when a reader who scrolled up
 * is left alone, when "Latest" appears, and what brings following back.
 *
 * The failure each test guards is a reader yanked back to the bottom mid-
 * sentence, or a "Latest" control nagging when nothing new has been said.
 */
class LiveTranscriptFollowTest {

    /** A reader mid-meeting who has dragged up from the end with [count] turns on screen. */
    private fun scrolledUp(count: Int): LiveTranscriptFollow =
        LiveTranscriptFollow.Start
            .dragStarted(count)
            .bottomChanged(atBottom = false, dragging = true, segmentCount = count)

    @Test
    fun `a new meeting follows and shows no control`() {
        val start = LiveTranscriptFollow.Start
        assertTrue(start.following)
        assertFalse(start.showsLatest(0))
        assertFalse(start.showsLatest(12))
    }

    @Test
    fun `dragging up from the end stops following`() {
        val left = scrolledUp(5)
        assertFalse(left.following)
        assertEquals(5, left.segmentsWhenLeft)
    }

    @Test
    fun `a drag that starts at the end does not count until it leaves it`() {
        // A nudge at the bottom, or the drag that brought the reader back down.
        val nudged = LiveTranscriptFollow.Start.dragStarted(5)
        assertTrue(nudged.following)
    }

    @Test
    fun `a drag that starts away from the end stops following at once`() {
        val awayFromEnd = LiveTranscriptFollow.Start
            .bottomChanged(atBottom = false, dragging = false, segmentCount = 3)
        val dragged = awayFromEnd.dragStarted(3)
        assertFalse(dragged.following)
        assertEquals(3, dragged.segmentsWhenLeft)
    }

    @Test
    fun `the list leaving the end on its own does not stop following`() {
        // A turn arriving before the follow catches up, or the panel resizing.
        val grown = LiveTranscriptFollow.Start
            .bottomChanged(atBottom = false, dragging = false, segmentCount = 6)
        assertTrue(grown.following)
        assertFalse(grown.atBottom)
    }

    @Test
    fun `scrolling up in a quiet moment shows no control`() {
        assertFalse(scrolledUp(5).showsLatest(5))
    }

    @Test
    fun `the control appears once something new arrives while not following`() {
        assertTrue(scrolledUp(5).showsLatest(6))
    }

    @Test
    fun `tapping Latest resumes following and hides the control`() {
        val resumed = scrolledUp(5).jumpedToLatest()
        assertTrue(resumed.following)
        assertFalse(resumed.showsLatest(9))
    }

    @Test
    fun `scrolling back down to the end resumes following`() {
        val back = scrolledUp(5)
            .bottomChanged(atBottom = true, dragging = true, segmentCount = 8)
        assertTrue(back.following)
        assertFalse(back.showsLatest(8))
    }

    @Test
    fun `a later drag records the count it left at, not the first one`() {
        val again = scrolledUp(5)
            .bottomChanged(atBottom = true, dragging = false, segmentCount = 8)
            .dragStarted(8)
            .bottomChanged(atBottom = false, dragging = true, segmentCount = 8)
        assertEquals(8, again.segmentsWhenLeft)
        assertFalse(again.showsLatest(8))
        assertTrue(again.showsLatest(9))
    }

    @Test
    fun `dragging further while already not following changes nothing`() {
        val left = scrolledUp(5)
        assertEquals(left, left.dragStarted(7))
        assertEquals(left, left.bottomChanged(atBottom = false, dragging = true, segmentCount = 7))
    }
}
