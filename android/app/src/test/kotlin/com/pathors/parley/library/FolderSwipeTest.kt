package com.pathors.parley.library

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import com.pathors.parley.cloud.CloudFolder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The swipe between folder pages: which gestures turn the page, which way, and
 * which are left to the card or the scroll they started on.
 */
class FolderSwipeTest {

    private val min = 60f

    // Two cards with an 8px gap between them, the way the list lays them out.
    private val cards = listOf(
        Rect(left = 16f, top = 0f, right = 344f, bottom = 100f),
        Rect(left = 16f, top = 108f, right = 344f, bottom = 208f),
    )

    private val gap = Offset(180f, 104f)
    private val belowLast = Offset(180f, 400f)
    private val onCard = Offset(180f, 50f)

    private fun step(start: Offset, dx: Float, dy: Float = 0f, rtl: Boolean = false) =
        FolderSwipe.step(start, Offset(dx, dy), cards, min, rtl)

    @Test
    fun `towards the start from blank space is the next page`() {
        assertEquals(1, step(gap, dx = -120f))
        assertEquals(1, step(belowLast, dx = -120f))
    }

    @Test
    fun `towards the end from blank space is the previous page`() {
        assertEquals(-1, step(gap, dx = 120f))
        assertEquals(-1, step(belowLast, dx = 120f))
    }

    /** iOS hangs swipe actions on the card, so a swipe there is the card's. */
    @Test
    fun `a swipe that starts on a card never turns the page`() {
        assertEquals(0, step(onCard, dx = -300f))
        assertEquals(0, step(onCard, dx = 300f))
    }

    /** Only where it went down counts: sliding off a card is still the card's. */
    @Test
    fun `where it ends does not matter, only where it started`() {
        assertEquals(1, FolderSwipe.step(gap, Offset(-120f, -54f), cards, min))
    }

    @Test
    fun `an empty page is all blank space`() {
        assertEquals(1, FolderSwipe.step(onCard, Offset(-120f, 0f), emptyList(), min))
    }

    @Test
    fun `too short is a wobble, not a swipe`() {
        assertEquals(0, step(gap, dx = -59f))
        assertEquals(1, step(gap, dx = -60f))
    }

    @Test
    fun `a scroll that drifts sideways is still a scroll`() {
        assertEquals(0, step(belowLast, dx = -120f, dy = 80f))
        assertEquals(0, step(belowLast, dx = -150f, dy = 100f))
        assertEquals(1, step(belowLast, dx = -151f, dy = 100f))
        assertEquals(0, step(belowLast, dx = 10f, dy = -400f))
    }

    @Test
    fun `a right-to-left layout mirrors the direction`() {
        assertEquals(-1, step(gap, dx = -120f, rtl = true))
        assertEquals(1, step(gap, dx = 120f, rtl = true))
    }

    // ── when the swipe takes the gesture over ───────────────────────────────

    private val slop = 20f

    @Test
    fun `inside the touch slop nothing is decided`() {
        assertEquals(FolderSwipe.Claim.UNDECIDED, FolderSwipe.claim(Offset(0f, 0f), slop))
        assertEquals(FolderSwipe.Claim.UNDECIDED, FolderSwipe.claim(Offset(-12f, 12f), slop))
        assertEquals(FolderSwipe.Claim.UNDECIDED, FolderSwipe.claim(Offset(20f, 0f), slop))
    }

    /** Either way across: the taps and presses underneath are cancelled. */
    @Test
    fun `sideways past the slop is the swipe's`() {
        assertEquals(FolderSwipe.Claim.SWIPE, FolderSwipe.claim(Offset(-21f, 0f), slop))
        assertEquals(FolderSwipe.Claim.SWIPE, FolderSwipe.claim(Offset(30f, -19f), slop))
    }

    /** A scroll, or a slant too steep to call, is left to the list. */
    @Test
    fun `down or slanting past the slop is not the swipe's`() {
        assertEquals(FolderSwipe.Claim.NOT_OURS, FolderSwipe.claim(Offset(0f, 21f), slop))
        assertEquals(FolderSwipe.Claim.NOT_OURS, FolderSwipe.claim(Offset(-30f, -20f), slop))
        assertEquals(FolderSwipe.Claim.NOT_OURS, FolderSwipe.claim(Offset(15f, -20f), slop))
    }

    // ── which page it lands on ──────────────────────────────────────────────

    private val folders = listOf(
        CloudFolder(id = "renewals", name = "Renewals"),
        CloudFolder(id = "new", name = "New business"),
    )

    @Test
    fun `a step walks the chip row in order`() {
        assertEquals(FolderFilter.Unfiled, LibraryFolders.adjacent(folders, FolderFilter.All, 1))
        assertEquals(
            FolderFilter.Folder("renewals"),
            LibraryFolders.adjacent(folders, FolderFilter.Unfiled, 1),
        )
        assertEquals(
            FolderFilter.Folder("renewals"),
            LibraryFolders.adjacent(folders, FolderFilter.Folder("new"), -1),
        )
        assertEquals(FolderFilter.All, LibraryFolders.adjacent(folders, FolderFilter.Unfiled, -1))
    }

    @Test
    fun `the row does not wrap`() {
        assertNull(LibraryFolders.adjacent(folders, FolderFilter.All, -1))
        assertNull(LibraryFolders.adjacent(folders, FolderFilter.Folder("new"), 1))
    }

    /** No folders, no chips: the library is one page and a swipe goes nowhere. */
    @Test
    fun `no folders, nowhere to go`() {
        assertNull(LibraryFolders.adjacent(emptyList(), FolderFilter.All, 1))
        assertNull(LibraryFolders.adjacent(emptyList(), FolderFilter.All, -1))
    }

    @Test
    fun `a selection that is not a page has no neighbours`() {
        assertNull(LibraryFolders.adjacent(folders, FolderFilter.Folder("gone"), 1))
        assertNull(LibraryFolders.adjacent(folders, FolderFilter.All, 0))
    }
}
