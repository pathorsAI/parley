package com.pathors.parley.onboarding

import com.pathors.parley.kit.Announcement
import com.pathors.parley.kit.AnnouncementGate
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** When the sheet may come up — the timing half of iOS `WhatsNewPresenter`. */
@OptIn(ExperimentalCoroutinesApi::class)
class WhatsNewPresenterTest {

    private val announcement = Announcement(
        id = "2026-10-news",
        ships = Announcement.Ships(android = "1.16"),
        copy = emptyMap(),
    )

    private class World {
        var foreground = true
        var recording = false
        var demo = false
        var decision = AnnouncementGate.Decision.NOTHING
        val seen = mutableListOf<Set<String>>()
    }

    private fun TestScope.presenter(world: World) = WhatsNewPresenter(
        scope = backgroundScope,
        decide = { world.decision },
        markSeen = { world.seen += it },
        isForeground = { world.foreground },
        meetingHoldsMic = { world.recording },
        suppressed = { world.demo },
    )

    private fun World.withNews() = apply {
        decision = AnnouncementGate.Decision(show = announcement, retire = setOf("2026-09-older", announcement.id))
    }

    private fun TestScope.settle() {
        advanceTimeBy(WhatsNewPresenter.SETTLE_DELAY_MS + 1)
        runCurrent()
    }

    @Test
    fun `it comes up a moment after the library appears`() = runTest {
        val presenter = presenter(World().withNews())

        presenter.homeAppeared()
        advanceTimeBy(WhatsNewPresenter.SETTLE_DELAY_MS - 1)
        runCurrent()
        assertNull("not before the settle delay", presenter.presented.value)

        settle()
        assertEquals(announcement, presenter.presented.value)
    }

    @Test
    fun `nothing to say shows nothing`() = runTest {
        val presenter = presenter(World())

        presenter.homeAppeared()
        settle()

        assertNull(presenter.presented.value)
    }

    @Test
    fun `dismissing it marks everything it retires as seen, once`() = runTest {
        val world = World().withNews()
        val presenter = presenter(world)
        presenter.homeAppeared()
        settle()

        presenter.dismissed()
        presenter.dismissed()
        runCurrent()

        assertNull(presenter.presented.value)
        assertEquals(listOf(setOf("2026-09-older", announcement.id)), world.seen)
    }

    @Test
    fun `a foreground opened by a deep link is skipped until the next one`() = runTest {
        val world = World().withNews()
        val presenter = presenter(world)

        presenter.noteOpenedByDeepLink()
        presenter.homeAppeared()
        presenter.foregrounded()
        settle()
        assertNull(presenter.presented.value)

        presenter.backgrounded()
        presenter.foregrounded()
        settle()
        assertEquals(announcement, presenter.presented.value)
    }

    @Test
    fun `a link arriving within the settle delay vetoes it`() = runTest {
        val presenter = presenter(World().withNews())

        presenter.homeAppeared()
        advanceTimeBy(WhatsNewPresenter.SETTLE_DELAY_MS / 2)
        presenter.noteOpenedByDeepLink()
        settle()

        assertNull(presenter.presented.value)
    }

    @Test
    fun `a link retracts a sheet without marking it seen`() = runTest {
        val world = World().withNews()
        val presenter = presenter(world)
        presenter.homeAppeared()
        settle()

        presenter.noteOpenedByDeepLink()
        runCurrent()

        assertNull(presenter.presented.value)
        assertEquals(emptyList<Set<String>>(), world.seen)
    }

    @Test
    fun `not while a meeting holds the microphone`() = runTest {
        val world = World().withNews().apply { recording = true }
        val presenter = presenter(world)

        presenter.homeAppeared()
        settle()
        assertNull(presenter.presented.value)

        world.recording = false
        presenter.homeDisappeared()
        presenter.homeAppeared()
        settle()
        assertEquals(announcement, presenter.presented.value)
    }

    @Test
    fun `not in the background, not in demo mode, not off the library`() = runTest {
        val world = World().withNews().apply { foreground = false }
        val presenter = presenter(world)
        presenter.homeAppeared()
        settle()
        assertNull("background", presenter.presented.value)

        world.foreground = true
        world.demo = true
        presenter.foregrounded()
        settle()
        assertNull("demo mode", presenter.presented.value)

        world.demo = false
        presenter.homeDisappeared()
        presenter.foregrounded()
        settle()
        assertNull("library not on screen", presenter.presented.value)
    }

    @Test
    fun `once per foreground`() = runTest {
        val world = World().withNews()
        val presenter = presenter(world)
        presenter.homeAppeared()
        settle()
        presenter.dismissed()
        runCurrent()

        // Say the store failed to write: the same foreground still does not ask twice.
        presenter.homeDisappeared()
        presenter.homeAppeared()
        settle()
        assertNull(presenter.presented.value)
    }

    @Test
    fun `leaving the library retracts the sheet unseen`() = runTest {
        val world = World().withNews()
        val presenter = presenter(world)
        presenter.homeAppeared()
        settle()

        presenter.homeDisappeared()
        runCurrent()

        assertNull(presenter.presented.value)
        assertEquals(emptyList<Set<String>>(), world.seen)
    }
}
