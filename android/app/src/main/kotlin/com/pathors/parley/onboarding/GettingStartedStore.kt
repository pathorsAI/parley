package com.pathors.parley.onboarding

import android.content.Context
import android.util.Log
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.pathors.parley.kit.GettingStartedState
import com.pathors.parley.kit.GettingStartedStep
import com.pathors.parley.screenshot.DemoMode
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json

private const val TAG = "GettingStarted"

/**
 * The Preferences DataStore behind the getting-started checklist and the sample
 * recording's library entry. Its own store, like `parley_playback`: signing out
 * clears `parley_auth`, and neither of these belongs to the account — the lap is
 * something this phone has or has not been walked through.
 */
internal val Context.parleyOnboardingStore: DataStore<Preferences> by
    preferencesDataStore(name = "parley_onboarding")

/**
 * The library's getting-started checklist, persisted — iOS `GettingStartedStore`.
 *
 * A thin shell over [GettingStartedState] (parleykit, where the rules are
 * unit-tested): it keeps the state as one JSON value in DataStore, writes it on
 * every change, and exposes it as a flow the library draws from.
 *
 * ## Who never sees it
 *
 * Existing users. Two signals, both cheap:
 *
 * 1. **A stored session at the first launch of this build.** When no state has
 *    been stored yet, this is the first time a checklist build runs on the
 *    phone; if a session token is *already* stored at that moment, the user
 *    signed in under an earlier build and the list starts dismissed. The check
 *    runs as the container is built — long before anybody could finish a
 *    browser sign-in — so a new user's first sign-in is never mistaken for an
 *    old one.
 * 2. **The library, the first time it loads.** A Mac user signing in on a new
 *    phone has no stored session yet, so (1) calls them new. The first
 *    successful personal-library load settles it — recordings already there with
 *    nothing on the list done means they were made elsewhere — and is checked
 *    once per install ([GettingStartedState.shouldDismissForExistingLibrary]).
 *
 * ## Demo mode
 *
 * Reads and writes go to [DemoMode]'s in-memory checklist instead, so a
 * screenshot run can show any state and leaves nothing on disk.
 */
class GettingStartedStore(
    private val store: DataStore<Preferences>,
    private val scope: CoroutineScope,
    /** Whether a session token is stored right now. Asked once, at first launch. */
    hadStoredSession: suspend () -> Boolean,
    private val clock: () -> Long = System::currentTimeMillis,
) {

    /**
     * The one-time migration, started as the store is built. Every write waits
     * for it: a recording rescued at launch can mark "recorded" in the same
     * instant, and that mark must land on the migrated state, not beat it to
     * the disk and make an existing user look new.
     */
    private val initialized: Deferred<Unit> = scope.async {
        runCatching {
            store.edit { preferences ->
                if (preferences[STATE_KEY] == null) {
                    val initial = GettingStartedState.initial(hadStoredSession(), clock())
                    preferences[STATE_KEY] = encode(initial)
                }
            }
        }.onFailure { Log.w(TAG, "could not initialise the checklist", it) }
    }

    private val stored: Flow<GettingStartedState?> =
        store.data.map { preferences -> decode(preferences[STATE_KEY]) }

    /**
     * The checklist, or null until the stored value has been read — the library
     * draws nothing for null rather than guessing and then changing its mind.
     */
    val state: StateFlow<GettingStartedState?> =
        combine(DemoMode.enabled, DemoMode.gettingStarted, stored) { demo, demoState, real ->
            if (demo) demoState else real
        }.stateIn(scope, SharingStarted.Eagerly, null)

    /**
     * Whether the once-per-install existing-user check has run on this phone, or
     * been settled by [reset]. Until it has, the library waits for its first
     * load before drawing the list; after, the list is drawn at once. See
     * [GettingStartedState.showsInLibrary].
     */
    val existingUserChecked: StateFlow<Boolean> =
        combine(DemoMode.enabled, store.data) { demo, preferences ->
            demo || preferences[LIBRARY_CHECKED_KEY] == true
        }.stateIn(scope, SharingStarted.Eagerly, false)

    /**
     * Tick an item, from the code path where the event actually succeeded.
     * Idempotent: a second call writes nothing. Fire-and-forget, so any caller
     * — the upload path included, with no UI alive — can say it.
     */
    fun mark(step: GettingStartedStep) {
        if (DemoMode.isActive) {
            DemoMode.updateGettingStarted { it.marking(step) }
            return
        }
        write { preferences ->
            val current = current(preferences)
            val next = current.marking(step)
            if (next !== current) preferences[STATE_KEY] = encode(next)
        }
    }

    /** "Not now". The list stays closed until the account sheet brings it back. */
    fun dismiss() {
        if (DemoMode.isActive) {
            DemoMode.updateGettingStarted { it.dismissed(clock()) }
            return
        }
        write { preferences -> preferences[STATE_KEY] = encode(current(preferences).dismissed(clock())) }
    }

    /**
     * "Show the getting-started list again": everything unticked, nothing
     * dismissed.
     *
     * Also settles the existing-user check if it has not run yet. That check
     * dismisses a list with nothing done over a library with recordings in it —
     * which is exactly what a freshly reset list over an existing user's library
     * looks like. Left pending, the first load after the reset would take back
     * what the user just asked for.
     */
    fun reset() {
        if (DemoMode.isActive) {
            DemoMode.updateGettingStarted { GettingStartedState() }
            return
        }
        write { preferences ->
            preferences[LIBRARY_CHECKED_KEY] = true
            preferences[STATE_KEY] = encode(GettingStartedState())
        }
    }

    /**
     * The second existing-user check — see the class doc. [recordingCount]
     * must exclude the sample. Runs once per install; later loads are no-ops.
     */
    fun noteLibraryLoaded(recordingCount: Int) {
        if (DemoMode.isActive) return
        write { preferences ->
            if (preferences[LIBRARY_CHECKED_KEY] == true) return@write
            preferences[LIBRARY_CHECKED_KEY] = true
            val current = current(preferences)
            if (current.shouldDismissForExistingLibrary(recordingCount)) {
                preferences[STATE_KEY] = encode(current.dismissed(clock()))
            }
        }
    }

    private fun write(transform: suspend (MutablePreferences) -> Unit) {
        scope.launch {
            initialized.await()
            runCatching { store.edit(transform) }
                .onFailure { Log.w(TAG, "could not save the checklist", it) }
        }
    }

    private fun current(preferences: Preferences): GettingStartedState =
        decode(preferences[STATE_KEY]) ?: GettingStartedState()

    companion object {
        private val STATE_KEY = stringPreferencesKey("getting-started.v1")
        private val LIBRARY_CHECKED_KEY = booleanPreferencesKey("getting-started.library-checked")

        private val json = Json { ignoreUnknownKeys = true }

        internal fun encode(state: GettingStartedState): String =
            json.encodeToString(GettingStartedState.serializer(), state)

        /** A value that no longer decodes is treated as absent rather than as a crash. */
        internal fun decode(value: String?): GettingStartedState? =
            value?.let { runCatching { json.decodeFromString(GettingStartedState.serializer(), it) }.getOrNull() }
    }
}
