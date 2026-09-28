package com.pathors.parley.onboarding

import android.content.Context
import android.util.Log
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.pathors.parley.kit.Announcement
import com.pathors.parley.kit.AnnouncementCatalog
import com.pathors.parley.kit.AnnouncementGate
import com.pathors.parley.kit.AnnouncementState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json

private const val TAG = "Announcements"

/**
 * The Preferences DataStore behind the What's New sheet: which announcements
 * this phone is done with. Its own file, like `parley_onboarding`: it is about
 * this install, not the account, so signing out (which clears `parley_auth`)
 * must not bring an old sheet back.
 */
internal val Context.parleyAnnouncementsStore: DataStore<Preferences> by
    preferencesDataStore(name = "parley_announcements")

/**
 * Which announcements this phone is done with, persisted — iOS
 * `AnnouncementStore`.
 *
 * A thin shell over [AnnouncementGate] (parleykit, where the rules are
 * unit-tested). The announcements themselves are the repository's
 * `announcements/` folder, bundled into the APK's assets at build time
 * (`copyAnnouncementAssets` in `app/build.gradle.kts`) and read once.
 *
 * ## Who never sees one
 *
 * A fresh install. The first launch of a build with no stored state asks
 * whether a session token is *already* stored: if so, the user signed in under
 * an earlier build and is updating; if not, every bundled announcement is marked
 * seen. The store is built with the [com.pathors.parley.AppContainer], before
 * anybody could finish a browser sign-in — the same trick, for the same reason,
 * as [GettingStartedStore] — so a new user's first sign-in is never mistaken
 * for an old one.
 *
 * Unlike the checklist there is no library-based second check: a desktop user
 * signing in on a new phone is new *to this app*, and "what's new in 1.17" is a
 * sentence about the phone app they have never seen.
 *
 * ## No collector
 *
 * Nothing here holds a `store.data` collector open. The sheet asks at most
 * once per foreground, so every read is a one-shot `first()`, taken only after
 * the first-launch write has landed, and serialised with the writes by one
 * mutex: no read can start while a write is in flight, which is the window
 * DataStore 1.1.x loses updates in (see [GettingStartedStore]'s `preferences`).
 */
class AnnouncementStore(
    private val store: DataStore<Preferences>,
    scope: CoroutineScope,
    /** Everything the APK carries. Read once, off the main thread. */
    bundled: suspend () -> List<Announcement>,
    /** Whether a session token is stored right now. Asked once, at first launch. */
    hadStoredSession: suspend () -> Boolean,
    /** The running build's `versionName`. */
    private val appVersion: String,
) {

    private val mutex = Mutex()

    private val announcements: Deferred<List<Announcement>> = scope.async {
        runCatching { bundled() }
            .onFailure { Log.w(TAG, "could not read the bundled announcements", it) }
            .getOrDefault(emptyList())
    }

    /**
     * The one-time migration, started as the store is built. Every read and
     * write waits for it.
     */
    private val initialized: Deferred<Unit> = scope.async {
        val all = announcements.await()
        mutex.withLock {
            runCatching {
                store.edit { preferences ->
                    if (preferences[STATE_KEY] == null) {
                        preferences[STATE_KEY] = encode(AnnouncementGate.initial(all, hadStoredSession()))
                    }
                }
            }.onFailure { Log.w(TAG, "could not initialise the announcement state", it) }
        }
    }

    /**
     * What to show right now, if anything. See [AnnouncementGate.decide].
     *
     * A state that cannot be read shows nothing: the sheet is the app talking
     * about itself, and the one safe answer to "have they seen this?" when the
     * record is gone is yes.
     */
    suspend fun decide(): AnnouncementGate.Decision {
        initialized.await()
        val state = mutex.withLock { read() } ?: return AnnouncementGate.Decision.NOTHING
        return AnnouncementGate.decide(announcements.await(), state, appVersion)
    }

    /** Never show [ids] on this phone again. */
    suspend fun markSeen(ids: Set<String>) {
        if (ids.isEmpty()) return
        initialized.await()
        mutex.withLock {
            try {
                store.edit { preferences ->
                    val current = decode(preferences[STATE_KEY]) ?: AnnouncementState()
                    if (!current.seen.containsAll(ids)) {
                        preferences[STATE_KEY] = encode(AnnouncementState(current.seen + ids))
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "could not save the announcement state", e)
            }
        }
    }

    private suspend fun read(): AnnouncementState? =
        try {
            decode(store.data.first()[STATE_KEY])
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "could not read the announcement state", e)
            null
        }

    companion object {
        private val STATE_KEY = stringPreferencesKey("announcements.v1")

        /** Where `copyAnnouncementAssets` puts the folder inside the APK. */
        const val ASSET_FOLDER = "announcements"

        private val json = Json { ignoreUnknownKeys = true }

        internal fun encode(state: AnnouncementState): String =
            json.encodeToString(AnnouncementState.serializer(), state)

        /** A value that no longer decodes is treated as absent rather than as a crash. */
        internal fun decode(value: String?): AnnouncementState? =
            value?.let { runCatching { json.decodeFromString(AnnouncementState.serializer(), it) }.getOrNull() }

        /**
         * The bundled `announcements/` folder. Empty if it is missing, which is
         * a build without announcements rather than an error. Blocking I/O.
         */
        fun loadBundled(context: Context): List<Announcement> {
            val assets = context.assets
            val names = assets.list(ASSET_FOLDER).orEmpty()
            return AnnouncementCatalog.load(
                names.associateWith { name ->
                    assets.open("$ASSET_FOLDER/$name").bufferedReader().use { it.readText() }
                },
            )
        }
    }
}
