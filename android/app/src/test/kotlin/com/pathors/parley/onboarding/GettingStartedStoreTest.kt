package com.pathors.parley.onboarding

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import com.pathors.parley.kit.GettingStartedState
import com.pathors.parley.kit.GettingStartedStep
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.job
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The checklist's persistence: who starts with it dismissed, that ticks
 * survive a relaunch, and the once-per-install existing-user check. The rules
 * themselves are parleykit's `GettingStartedStateTest`; this is the shell.
 */
class GettingStartedStoreTest {

    @get:Rule
    val temporary = TemporaryFolder()

    private val scopes = mutableListOf<CoroutineScope>()

    @After
    fun tearDown() {
        scopes.forEach { it.cancel() }
    }

    private fun store(file: File, hadSession: Boolean = false, now: Long = NOW): GettingStartedStore {
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob()).also { scopes += it }
        return GettingStartedStore(
            store = PreferenceDataStoreFactory.create(scope = scope, produceFile = { file }),
            scope = scope,
            hadStoredSession = { hadSession },
            clock = { now },
        )
    }

    /** The first stored value that satisfies [predicate]. Writes are fire-and-forget. */
    private fun GettingStartedStore.awaitState(
        predicate: (GettingStartedState) -> Boolean,
    ): GettingStartedState = runBlocking {
        withTimeout(TIMEOUT_MS) { state.first { it != null && predicate(it) }!! }
    }

    /**
     * A second store on the same file. The first one's scope is joined, not just
     * cancelled: DataStore refuses two live instances on one file, and the old
     * one lets go of it only once its scope has actually finished.
     */
    private fun relaunch(file: File): GettingStartedStore {
        runBlocking { scopes.forEach { it.coroutineContext.job.cancelAndJoin() } }
        scopes.clear()
        return store(file, hadSession = true)
    }

    private fun file() = File(temporary.root, "onboarding.preferences_pb")

    @Test
    fun `a fresh install starts with the list open`() {
        val state = store(file()).awaitState { true }

        assertNull(state.dismissedAtMs)
        assertEquals(0, state.done)
    }

    @Test
    fun `a session stored under an earlier build starts it dismissed`() {
        val state = store(file(), hadSession = true).awaitState { true }

        assertEquals(NOW, state.dismissedAtMs)
    }

    @Test
    fun `the first-launch decision is made once, not on every launch`() {
        val file = file()
        store(file, hadSession = false).awaitState { true }

        // Signed in since: a relaunch must not now call this user "existing".
        val state = relaunch(file).awaitState { true }

        assertNull(state.dismissedAtMs)
    }

    @Test
    fun `a tick survives a relaunch`() {
        val file = file()
        val first = store(file)
        first.mark(GettingStartedStep.RECORDED)
        first.awaitState { it.recorded }

        val state = relaunch(file).awaitState { true }

        assertTrue(state.recorded)
        assertEquals(1, state.done)
    }

    @Test
    fun `not now closes it`() {
        val store = store(file())
        store.dismiss()

        assertFalse(store.awaitState { it.dismissedAtMs != null }.isVisible)
    }

    @Test
    fun `a library full of someone else's recordings dismisses it, once`() {
        val store = store(file())
        store.noteLibraryLoaded(recordingCount = 4)

        assertEquals(NOW, store.awaitState { it.dismissedAtMs != null }.dismissedAtMs)
        assertTrue(runBlocking { withTimeout(TIMEOUT_MS) { store.existingUserChecked.first { it } } })
    }

    @Test
    fun `the existing-user check does not run twice`() {
        val store = store(file())
        store.noteLibraryLoaded(recordingCount = 0)
        runBlocking { withTimeout(TIMEOUT_MS) { store.existingUserChecked.first { it } } }

        store.noteLibraryLoaded(recordingCount = 9)
        store.mark(GettingStartedStep.REPLAYED)
        val state = store.awaitState { it.replayed }

        assertNull("a later load must not dismiss the list", state.dismissedAtMs)
    }

    @Test
    fun `show it again unticks everything and settles the existing-user check`() {
        val store = store(file(), hadSession = true)
        store.mark(GettingStartedStep.FILED)
        store.awaitState { it.filed }

        store.reset()
        val state = store.awaitState { !it.filed }
        store.noteLibraryLoaded(recordingCount = 9)
        store.mark(GettingStartedStep.RECORDED)
        val after = store.awaitState { it.recorded }

        assertNull(state.dismissedAtMs)
        assertNull("the reset list must survive the next library load", after.dismissedAtMs)
    }

    @Test
    fun `a stored value that no longer decodes reads as absent`() {
        assertNull(GettingStartedStore.decode("{not json"))
        val state = GettingStartedState(recorded = true)
        assertEquals(state, GettingStartedStore.decode(GettingStartedStore.encode(state)))
    }

    private companion object {
        const val NOW = 1_786_498_800_000L
        const val TIMEOUT_MS = 5_000L
    }
}
