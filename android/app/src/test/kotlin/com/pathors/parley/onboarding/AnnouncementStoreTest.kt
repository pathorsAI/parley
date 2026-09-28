package com.pathors.parley.onboarding

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import com.pathors.parley.kit.Announcement
import com.pathors.parley.kit.AnnouncementGate
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The announcement state's persistence: who starts with everything seen, and
 * that "seen" survives a relaunch. The rules themselves are parleykit's
 * `AnnouncementGateTest`; this is the shell.
 */
class AnnouncementStoreTest {

    @get:Rule
    val temporary = TemporaryFolder()

    private val scopes = mutableListOf<CoroutineScope>()

    @After
    fun tearDown() {
        scopes.forEach { it.cancel() }
    }

    private val bundled = listOf(announcement("2026-09-old", "1.15"), announcement("2026-10-new", "1.16"))

    private fun announcement(id: String, android: String): Announcement {
        val copy = Announcement.Copy(badge = "b", title = "t", body = "x", also = "a", button = "ok")
        return Announcement(
            id = id,
            ships = Announcement.Ships(android = android),
            copy = mapOf("en" to copy, "zh-Hant" to copy),
        )
    }

    private fun file() = File(temporary.root, "announcements.preferences_pb")

    private fun store(
        file: File,
        hadSession: Boolean,
        version: String = "1.16",
        onSessionAsked: () -> Unit = {},
    ): AnnouncementStore {
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob()).also { scopes += it }
        return AnnouncementStore(
            store = PreferenceDataStoreFactory.create(scope = scope, produceFile = { file }),
            scope = scope,
            bundled = { bundled },
            hadStoredSession = {
                onSessionAsked()
                hadSession
            },
            appVersion = version,
        )
    }

    /** A second store on the same file, after the first has let go of it. */
    private fun relaunch(file: File, hadSession: Boolean, onSessionAsked: () -> Unit = {}): AnnouncementStore {
        runBlocking { scopes.forEach { it.coroutineContext.job.cancelAndJoin() } }
        scopes.clear()
        return store(file, hadSession, onSessionAsked = onSessionAsked)
    }

    private fun <T> await(block: suspend () -> T): T = runBlocking { withTimeout(TIMEOUT_MS) { block() } }

    @Test
    fun `a fresh install is shown nothing`() {
        val store = store(file(), hadSession = false)

        assertEquals(AnnouncementGate.Decision.NOTHING, await { store.decide() })
    }

    @Test
    fun `a fresh install stays quiet after it signs in`() {
        val file = file()
        await { store(file, hadSession = false).decide() }

        // The next launch has a session now; the first launch already settled it.
        val relaunched = relaunch(file, hadSession = true)

        assertEquals(AnnouncementGate.Decision.NOTHING, await { relaunched.decide() })
    }

    @Test
    fun `an existing user updating is shown the newest, with the older one retired`() {
        val decision = await { store(file(), hadSession = true).decide() }

        assertEquals("2026-10-new", decision.show?.id)
        assertEquals(setOf("2026-09-old", "2026-10-new"), decision.retire)
    }

    @Test
    fun `seen survives a relaunch, and the session is asked about only once`() {
        val file = file()
        var asked = 0
        val first = store(file, hadSession = true, onSessionAsked = { asked++ })
        val decision = await { first.decide() }
        await { first.markSeen(decision.retire) }

        val relaunched = relaunch(file, hadSession = true, onSessionAsked = { asked++ })

        assertEquals(AnnouncementGate.Decision.NOTHING, await { relaunched.decide() })
        assertEquals(1, asked)
    }

    @Test
    fun `a newer build shows what it ships to someone who read the last one`() {
        val file = file()
        val first = store(file, hadSession = true, version = "1.15")
        val old = await { first.decide() }
        assertEquals("2026-09-old", old.show?.id)
        await { first.markSeen(old.retire) }

        runBlocking { scopes.forEach { it.coroutineContext.job.cancelAndJoin() } }
        scopes.clear()
        val updated = store(file, hadSession = true, version = "1.16")

        assertEquals("2026-10-new", await { updated.decide() }.show?.id)
    }

    private companion object {
        const val TIMEOUT_MS = 20_000L
    }
}
