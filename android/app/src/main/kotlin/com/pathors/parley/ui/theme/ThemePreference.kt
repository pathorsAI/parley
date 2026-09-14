package com.pathors.parley.ui.theme

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import java.io.IOException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch

/**
 * The app's own appearance setting, matching iOS's `AppTheme` and the desktop's
 * `AppTheme` in `types.ts`. The stored strings are the same three, so the value
 * means the same thing on all three clients if it is ever synced.
 */
enum class ThemePreference(val storageValue: String) {
    /** Follow the device. The default, and what every install starts on. */
    SYSTEM("system"),
    LIGHT("light"),
    DARK("dark"),
    ;

    companion object {
        /** Unknown or missing values fall back to [SYSTEM] rather than throwing. */
        fun fromStorage(value: String?): ThemePreference =
            entries.firstOrNull { it.storageValue == value } ?: SYSTEM
    }
}

/**
 * Its own DataStore, deliberately not the auth one: appearance is not part of a
 * session, and signing out must not silently put a user who chose Dark back on
 * the system setting.
 *
 * Lands in `filesDir/datastore/parley_settings.preferences_pb`, app-private, and
 * excluded from backup along with everything else by
 * `android:allowBackup="false"`.
 */
private val Context.parleySettingsStore: DataStore<Preferences> by
    preferencesDataStore(name = "parley_settings")

/**
 * Reads and writes [ThemePreference].
 *
 * Cheap to construct — it only resolves the process-wide DataStore — so callers
 * may build one wherever they need it rather than threading it through
 * `AppContainer`.
 */
class ThemePreferenceStore(context: Context) {

    private val store = context.applicationContext.parleySettingsStore

    /** The current preference, re-emitting on every change. [ThemePreference.SYSTEM] until read. */
    val preference: Flow<ThemePreference> = store.data
        // A corrupt or unreadable file must not take the UI down with it: the
        // worst honest outcome of losing this setting is following the system.
        .catch { e -> if (e is IOException) emit(emptyPreferences()) else throw e }
        .map { prefs -> ThemePreference.fromStorage(prefs[KEY]) }
        .onEach { lastKnown = it }

    suspend fun set(value: ThemePreference) {
        // Set first so a recomposition triggered by the write already sees it.
        lastKnown = value
        store.edit { prefs -> prefs[KEY] = value.storageValue }
    }

    companion object {
        private val KEY = stringPreferencesKey("theme")

        /**
         * The last value this process has seen, used as the initial value for
         * [rememberThemePreference] so a recomposition or a new Activity does not
         * flash the system appearance before the first DataStore emission lands.
         *
         * It is still `SYSTEM` for the first frame after a cold start — DataStore's
         * first read is disk I/O and will not be done synchronously. Call [warm]
         * from `Application.onCreate` to shorten that window to nearly nothing.
         */
        @Volatile
        var lastKnown: ThemePreference = ThemePreference.SYSTEM
            internal set

        /** Start the first disk read early, so the first composition has the answer. */
        fun warm(context: Context, scope: CoroutineScope) {
            scope.launch { runCatching { ThemePreferenceStore(context).preference.first() } }
        }
    }
}

/** A store bound to the current composition's context. */
@Composable
fun rememberThemePreferenceStore(): ThemePreferenceStore {
    val context = LocalContext.current.applicationContext
    return remember(context) { ThemePreferenceStore(context) }
}

/**
 * The persisted appearance choice, live. This is what `ParleyTheme` reads by
 * default; a settings screen wanting to show the current selection should use it
 * too rather than keeping its own copy.
 */
@Composable
fun rememberThemePreference(): ThemePreference {
    val store = rememberThemePreferenceStore()
    return store.preference.collectAsState(initial = ThemePreferenceStore.lastKnown).value
}
