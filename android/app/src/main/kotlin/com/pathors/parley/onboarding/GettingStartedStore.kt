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
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.retryWhen
import kotlinx.coroutines.flow.shareIn
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

    /** Completed by [preferences]' first read, or by its first failure. [write]s wait for it. */
    private val firstRead = CompletableDeferred<Unit>()

    /**
     * The stored preferences: the store's one collector of `store.data`, shared
     * by [state] and [existingUserChecked], started once the migration above
     * has written.
     *
     * One collector, and no write in flight while it starts, because DataStore
     * (1.1.x) can lose a write to a collector that starts during it. The reader
     * that cannot take the file lock labels what it read with the version
     * counter it saw *before* trying the lock, and a write bumps that counter
     * before it writes the file. So a read that lands between the bump and the
     * write returns the old contents under the new version, and when the write
     * then publishes the new contents under that same version the collector
     * drops them as "not newer" — the flow simply never shows the write. That
     * is why nothing is written until this has read once (see the writer in
     * `init`), and why the migration is awaited before it starts.
     *
     * A failed read (a file another instance has not let go of yet, an I/O
     * error) is retried rather than allowed to end the flow: an ended flow
     * would leave [state] at null for good, the list never drawn.
     */
    private val preferences: SharedFlow<Preferences> =
        flow {
            initialized.await()
            emitAll(store.data)
        }
            .onEach { firstRead.complete(Unit) }
            .retryWhen { cause, attempt ->
                if (cause is CancellationException) return@retryWhen false
                firstRead.complete(Unit)
                Log.w(TAG, "could not read the checklist; retrying", cause)
                delay((attempt + 1).coerceAtMost(MAX_READ_RETRY_STEPS) * READ_RETRY_DELAY_MS)
                true
            }
            .shareIn(scope, SharingStarted.Eagerly, replay = 1)

    /**
     * The writes, in the order they were asked for. One coroutine drains it
     * (see `init`), so a [reset] followed by a [mark] can never land the other
     * way round.
     */
    private val writes = Channel<suspend (MutablePreferences) -> Unit>(Channel.UNLIMITED)

    /**
     * Suspends until the first-launch migration has written. The sample store
     * shares this DataStore and waits here before it starts reading, for the
     * reason [preferences] gives.
     */
    suspend fun awaitReady() = initialized.await()

    private val stored: Flow<GettingStartedState?> =
        preferences.map { preferences -> decode(preferences[STATE_KEY]) }

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
        combine(DemoMode.enabled, preferences) { demo, preferences ->
            demo || preferences[LIBRARY_CHECKED_KEY] == true
        }.stateIn(scope, SharingStarted.Eagerly, false)

    init {
        // The one writer. It starts after the migration (which every write must
        // land on) and after the first read (see [preferences]), then applies
        // the queue strictly in order, one edit at a time.
        scope.launch {
            initialized.await()
            firstRead.await()
            for (transform in writes) {
                try {
                    store.edit(transform)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    Log.w(TAG, "could not save the checklist", e)
                }
            }
        }
    }

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

    /** Queue [transform]. Fire-and-forget: it lands after every write queued before it. */
    private fun write(transform: suspend (MutablePreferences) -> Unit) {
        writes.trySend(transform)
    }

    private fun current(preferences: Preferences): GettingStartedState =
        decode(preferences[STATE_KEY]) ?: GettingStartedState()

    companion object {
        private val STATE_KEY = stringPreferencesKey("getting-started.v1")
        private val LIBRARY_CHECKED_KEY = booleanPreferencesKey("getting-started.library-checked")

        private const val READ_RETRY_DELAY_MS = 500L
        private const val MAX_READ_RETRY_STEPS = 10L

        private val json = Json { ignoreUnknownKeys = true }

        internal fun encode(state: GettingStartedState): String =
            json.encodeToString(GettingStartedState.serializer(), state)

        /** A value that no longer decodes is treated as absent rather than as a crash. */
        internal fun decode(value: String?): GettingStartedState? =
            value?.let { runCatching { json.decodeFromString(GettingStartedState.serializer(), it) }.getOrNull() }
    }
}
