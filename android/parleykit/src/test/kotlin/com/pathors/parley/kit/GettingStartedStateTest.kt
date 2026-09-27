package com.pathors.parley.kit

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** The checklist's rules. A port of iOS `GettingStartedStateTests`, case for case. */
class GettingStartedStateTest {

    private fun allDone(): GettingStartedState =
        GettingStartedStep.entries.fold(GettingStartedState()) { state, step -> state.marking(step) }

    // ── marking ──────────────────────────────────────────────────────────────

    @Test
    fun `a fresh list has nothing done and is visible`() {
        val state = GettingStartedState()

        assertEquals(0, state.done)
        assertTrue(state.isVisible)
    }

    @Test
    fun `marking is idempotent`() {
        val once = GettingStartedState().marking(GettingStartedStep.RECORDED)
        val twice = once.marking(GettingStartedStep.RECORDED)

        assertSame("a repeat mark must not produce a new value to write", once, twice)
        assertEquals(1, twice.done)
        assertTrue(twice.recorded)
    }

    @Test
    fun `each step flips its own flag`() {
        for (step in GettingStartedStep.entries) {
            val state = GettingStartedState().marking(step)
            assertTrue(state[step])
            assertEquals(
                "$step touched another flag",
                listOf(step),
                GettingStartedStep.entries.filter { state[it] },
            )
        }
    }

    @Test
    fun `progress counts out of four`() {
        val state = GettingStartedState()
            .marking(GettingStartedStep.RECORDED)
            .marking(GettingStartedStep.REPLAYED)

        assertEquals(4, GettingStartedState.TOTAL)
        assertEquals(2, state.done)
    }

    // ── visibility ───────────────────────────────────────────────────────────

    @Test
    fun `finishing all four hides the list`() {
        val state = allDone()

        assertTrue(state.isComplete)
        assertFalse(state.isVisible)
    }

    @Test
    fun `dismissing hides the list with work left`() {
        val state = GettingStartedState().marking(GettingStartedStep.RECORDED).dismissed(1L)

        assertFalse(state.isVisible)
        assertEquals(1L, state.dismissedAtMs)
    }

    // ── in the library ───────────────────────────────────────────────────────

    @Test
    fun `a visible list waits for the load while the existing-user check is pending`() {
        val state = GettingStartedState()

        assertFalse(
            state.showsInLibrary(libraryLoaded = false, existingUserChecked = false, libraryIsEmpty = true),
        )
        assertTrue(
            state.showsInLibrary(libraryLoaded = true, existingUserChecked = false, libraryIsEmpty = false),
        )
    }

    /** The reset-from-the-account-sheet case: the list must be up before the reload lands. */
    @Test
    fun `a visible list shows before the load once the check has run`() {
        assertTrue(
            GettingStartedState()
                .showsInLibrary(libraryLoaded = false, existingUserChecked = true, libraryIsEmpty = true),
        )
    }

    @Test
    fun `a visible list shows whatever the recording count`() {
        for (empty in listOf(true, false)) {
            assertTrue(
                GettingStartedState()
                    .showsInLibrary(libraryLoaded = true, existingUserChecked = true, libraryIsEmpty = empty),
            )
        }
    }

    @Test
    fun `a finished list comes back only for a loaded empty library`() {
        val state = allDone()

        assertTrue(
            state.showsInLibrary(libraryLoaded = true, existingUserChecked = true, libraryIsEmpty = true),
        )
        assertFalse(
            "an empty library before the load is not known to be empty",
            state.showsInLibrary(libraryLoaded = false, existingUserChecked = true, libraryIsEmpty = true),
        )
        assertFalse(
            state.showsInLibrary(libraryLoaded = true, existingUserChecked = true, libraryIsEmpty = false),
        )
    }

    @Test
    fun `a dismissed list stays closed`() {
        val state = GettingStartedState().dismissed(5L)

        assertFalse(
            state.showsInLibrary(libraryLoaded = true, existingUserChecked = true, libraryIsEmpty = true),
        )
    }

    // ── existing users ───────────────────────────────────────────────────────

    @Test
    fun `a session from an earlier build starts dismissed`() {
        val state = GettingStartedState.initial(hadStoredSession = true, nowMs = 42L)

        assertEquals(42L, state.dismissedAtMs)
        assertFalse(state.isVisible)
    }

    @Test
    fun `a fresh install starts visible`() {
        val state = GettingStartedState.initial(hadStoredSession = false, nowMs = 42L)

        assertNull(state.dismissedAtMs)
        assertTrue(state.isVisible)
    }

    @Test
    fun `a library full of recordings made elsewhere dismisses`() {
        assertTrue(GettingStartedState().shouldDismissForExistingLibrary(recordingCount = 3))
    }

    @Test
    fun `an empty library keeps the list`() {
        assertFalse(GettingStartedState().shouldDismissForExistingLibrary(recordingCount = 0))
    }

    /** A first recording has already ticked `recorded` — that is a first lap, not history. */
    @Test
    fun `a library this user just started keeps the list`() {
        val state = GettingStartedState().marking(GettingStartedStep.RECORDED)

        assertFalse(state.shouldDismissForExistingLibrary(recordingCount = 1))
    }

    @Test
    fun `an already dismissed list is not dismissed again`() {
        assertFalse(GettingStartedState().dismissed(1L).shouldDismissForExistingLibrary(3))
    }

    // ── persistence ──────────────────────────────────────────────────────────

    @Test
    fun `round-trips through JSON`() {
        val state = GettingStartedState().marking(GettingStartedStep.FILED).dismissed(1_000L)

        val decoded = Json.decodeFromString(
            GettingStartedState.serializer(),
            Json.encodeToString(GettingStartedState.serializer(), state),
        )

        assertEquals(state, decoded)
    }

    @Test
    fun `a stored state missing newer fields still decodes`() {
        val decoded = Json { ignoreUnknownKeys = true }
            .decodeFromString(GettingStartedState.serializer(), """{"recorded":true,"later":1}""")

        assertTrue(decoded.recorded)
        assertEquals(1, decoded.done)
    }
}
