package com.pathors.parley.dictionary

import com.pathors.parley.feedback.Log
import com.pathors.parley.kit.DictionarySync
import com.pathors.parley.kit.DictionarySyncState
import com.pathors.parley.kit.DictionarySyncTransport
import com.pathors.parley.kit.FileDictionarySyncStorage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.job
import kotlinx.coroutines.launch

private const val TAG = "DictionarySync"

/**
 * Keeps the personal dictionary in step with the account — iOS
 * `DictionarySyncModel`. The rules live in `kit/DictionarySync`; this is when
 * they run, and what the dictionary screen says about it.
 *
 * Triggers, as on iOS:
 * - the account becoming known — launch with a stored session, or a sign-in;
 * - a few seconds after a dictionary edit ([localChange]), if it left
 *   something to send;
 * - the app coming to the foreground, at most every [FOREGROUND_INTERVAL_MS].
 *
 * Signing out, a 401, deleting the account and switching accounts all arrive
 * as [accountChanged] with the new user (or null): a run for the old account
 * that finishes afterwards is ignored, and the next account starts from its
 * own snapshot (`DictionarySync.loadState`). The local dictionary itself is
 * kept on sign-out, as iOS keeps it — it is the phone's, and the same person
 * usually signs back in.
 *
 * A failed run changes nothing and is tried again at the next trigger.
 *
 * @param canSync false in demo mode, which must not reach the network.
 * @param now the clock statuses and the foreground throttle read.
 */
class DictionarySyncModel(
    private val storage: FileDictionarySyncStorage,
    private val transport: DictionarySyncTransport,
    private val scope: CoroutineScope,
    private val canSync: () -> Boolean = { true },
    private val now: () -> Long = System::currentTimeMillis,
    private val debounceMs: Long = DEBOUNCE_MS,
    /** Where the counts-only run log goes; swapped in tests, which have no `android.util.Log`. */
    private val log: (String) -> Unit = { Log.i(TAG, it) },
) {
    /** What the status line under the dictionary's title says. */
    sealed interface Status {
        /** Signed out, or never synced on this account. */
        data object Idle : Status

        /** The first run on this account is in flight. */
        data object Syncing : Status

        data class Synced(val atMs: Long) : Status

        data class Failed(val lastSyncedMs: Long?) : Status
    }

    private val _status = MutableStateFlow<Status>(Status.Idle)
    val status: StateFlow<Status> = _status.asStateFlow()

    private val _active = MutableStateFlow(false)

    /** Whether there is an account to sync with — the status line hides without one. */
    val active: StateFlow<Boolean> = _active.asStateFlow()

    @Volatile
    private var userId: String? = null
    private var running: Job? = null

    @Volatile
    private var again = false
    private var pendingEdit: Job? = null

    @Volatile
    private var lastAttemptMs = Long.MIN_VALUE / 2

    /** The signed-in account's id, or null after a sign-out. A newly known account syncs straight away. */
    @Synchronized
    fun accountChanged(userId: String?) {
        val changed = userId != this.userId
        this.userId = userId
        _active.value = userId != null
        if (userId == null) {
            pendingEdit?.cancel()
            _status.value = Status.Idle
            return
        }
        if (!changed) return
        _status.value = statusFrom(storage.loadState(), userId)
        syncNow()
    }

    /** Throttled to [FOREGROUND_INTERVAL_MS]. */
    fun foregrounded() {
        if (userId == null || now() - lastAttemptMs < FOREGROUND_INTERVAL_MS) return
        syncNow()
    }

    /**
     * The user chose "Clear the dictionary". Recorded before the clear is
     * written, so the sync that write schedules carries it out rather than
     * reading an emptied file as a lost one.
     */
    fun noteCleared() = storage.noteCleared(now())

    /** Wired to `LexiconStore.didSave`: a debounced run, when the edit left something to send. */
    @Synchronized
    fun localChange() {
        val id = userId ?: return
        if (!DictionarySync.hasLocalChanges(storage, id)) return
        pendingEdit?.cancel()
        pendingEdit = scope.launch {
            delay(debounceMs)
            syncNow()
        }
    }

    /**
     * Overlapping requests share one run; one that arrives mid-run makes it go
     * round once more, so an edit made during a sync is not left behind.
     */
    @Synchronized
    fun syncNow() {
        if (userId == null || !canSync()) return
        if (running != null) {
            again = true
            return
        }
        running = scope.launch {
            try {
                do {
                    again = false
                    runOnce()
                } while (!finishedRound())
            } finally {
                // Only when this run is still the current one: a cancelled run
                // must not strand the flag, nor clear a newer run's.
                val self = coroutineContext.job
                synchronized(this@DictionarySyncModel) { if (running === self) running = null }
            }
        }
    }

    /** Under the same lock [syncNow] takes, so a request can never fall between the check and the exit. */
    @Synchronized
    private fun finishedRound(): Boolean {
        if (again) return false
        running = null
        return true
    }

    private suspend fun runOnce() {
        val id = userId ?: return
        lastAttemptMs = now()
        if (_status.value == Status.Idle) _status.value = Status.Syncing
        val outcome = DictionarySync.run(id, transport, storage, now)
        if (userId != id) return
        when (outcome) {
            is DictionarySync.Outcome.Synced -> {
                _status.value = Status.Synced(now())
                // Counts only. Dictionary content is the user's and never goes in a log.
                if (outcome.pulled + outcome.pushed > 0) {
                    log("synced: pulled ${outcome.pulled}, pushed ${outcome.pushed}, refused ${outcome.refused}")
                }
            }
            is DictionarySync.Outcome.Failed -> {
                _status.value = Status.Failed(lastSynced(storage.loadState(), id))
                log("sync failed, will retry")
            }
        }
    }

    companion object {
        /** Quiet period after an edit, so a burst of edits goes up together. */
        const val DEBOUNCE_MS = 3_000L

        /** Foregrounding syncs no more often than this. */
        const val FOREGROUND_INTERVAL_MS = 15 * 60 * 1000L

        internal fun lastSynced(state: DictionarySyncState?, userId: String): Long? =
            state?.takeIf { it.userId == userId }?.lastSyncedAt

        internal fun statusFrom(state: DictionarySyncState?, userId: String): Status {
            val last = lastSynced(state, userId)
            if (state?.userId == userId && state.lastFailed) return Status.Failed(last)
            return last?.let { Status.Synced(it) } ?: Status.Idle
        }
    }
}
