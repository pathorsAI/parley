package com.pathors.parley.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaybackRosterTest {

    /** Records what the roster asked of the service, in order. */
    private class FakeHost : PlaybackRoster.Host<String> {
        val calls = mutableListOf<String>()
        override fun host(session: String) {
            calls += "host $session"
        }
        override fun unhost(session: String) {
            calls += "unhost $session"
        }
        override fun finish() {
            calls += "finish"
        }
    }

    private val paused = mutableListOf<String>()
    private val roster = PlaybackRoster<String> { paused += it }

    @Test
    fun `a player opened before the service exists is hosted when it attaches`() {
        roster.register(FIRST)
        assertTrue(roster.needsHost)

        val host = FakeHost()
        assertTrue(roster.attach(host))

        assertEquals(listOf("host $FIRST"), host.calls)
        assertFalse(roster.needsHost)
    }

    @Test
    fun `a player opened while the service is up is hosted at once`() {
        val host = FakeHost()
        roster.attach(host)
        roster.register(FIRST)
        roster.register(FIRST)

        assertEquals(listOf("host $FIRST"), host.calls)
    }

    @Test
    fun `the last player released stops the service`() {
        val host = FakeHost()
        roster.register(FIRST)
        roster.register(SECOND)
        roster.attach(host)
        host.calls.clear()

        roster.unregister(FIRST)
        assertEquals(listOf("unhost $FIRST"), host.calls)

        roster.unregister(SECOND)
        assertEquals(listOf("unhost $FIRST", "unhost $SECOND", "finish"), host.calls)
    }

    @Test
    fun `releasing an unknown player does nothing`() {
        val host = FakeHost()
        roster.attach(host)
        roster.unregister(FIRST)

        assertTrue(host.calls.isEmpty())
    }

    @Test
    fun `a service restarted with nothing open is told to stop`() {
        assertFalse(roster.attach(FakeHost()))
        assertFalse(roster.needsHost)
    }

    @Test
    fun `a stale service detaching does not unhook the live one`() {
        val old = FakeHost()
        val live = FakeHost()
        roster.attach(old)
        roster.attach(live)
        roster.detach(old)

        roster.register(FIRST)
        assertEquals(listOf("host $FIRST"), live.calls)
        assertTrue(old.calls.isEmpty())
    }

    @Test
    fun `after the service goes away a new play needs it again`() {
        val host = FakeHost()
        roster.attach(host)
        roster.register(FIRST)
        roster.detach(host)

        assertTrue(roster.needsHost)
    }

    @Test
    fun `current is the newest open player`() {
        assertNull(roster.current)
        roster.register(FIRST)
        roster.register(SECOND)
        assertEquals(SECOND, roster.current)
        roster.unregister(SECOND)
        assertEquals(FIRST, roster.current)
    }

    @Test
    fun `a meeting starting pauses every open player`() {
        roster.register(FIRST)
        roster.register(SECOND)

        roster.pauseAll()

        assertEquals(listOf(FIRST, SECOND), paused)
    }

    private companion object {
        const val FIRST = "first"
        const val SECOND = "second"
    }
}
