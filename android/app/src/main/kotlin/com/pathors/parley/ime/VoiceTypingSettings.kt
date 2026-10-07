package com.pathors.parley.ime

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.preferencesDataStore
import java.io.IOException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/**
 * Its own DataStore file, deliberately not `parley_settings` (appearance) or
 * `parley_auth` (the session token).
 *
 * This is not tidiness: `preferencesDataStore` is a property delegate that
 * *installs* a singleton per file name, and two delegates naming the same file in
 * one process throw `IllegalStateException` at first access. Voice typing is
 * being written alongside a settings screen someone else owns, so it keeps its
 * own file and the two cannot collide.
 *
 * Lands in `filesDir/datastore/parley_voice_typing.preferences_pb`, app-private,
 * and out of cloud backup with everything else via `android:allowBackup="false"`.
 */
private val Context.parleyVoiceTypingStore: DataStore<Preferences> by
    preferencesDataStore(name = "parley_voice_typing")

/**
 * The voice keyboard's own preferences. Cheap to construct — it only resolves the
 * process-wide DataStore — so the input method, the session and the settings
 * screen each build their own rather than threading one through `AppContainer`.
 */
class VoiceTypingSettings(context: Context) {

    private val store = context.applicationContext.parleyVoiceTypingStore

    /**
     * Whether the AI cleanup pass runs after dictation ends. Default **on**: the
     * pass is what makes dictated text read like writing, and iOS ships it on.
     *
     * The switch exists because the pass is the one part of dictation that sends
     * the *transcript* (not just the audio) to a second endpoint, and because a
     * user who wants their words exactly as spoken is asking for something
     * reasonable. Off means `DictationSession` commits the raw transcript and
     * makes no chat request at all.
     */
    val polishEnabled: Flow<Boolean> = store.data
        // A corrupt or unreadable file must not take the keyboard down: the worst
        // honest outcome of losing this setting is polishing when asked not to,
        // so it is read back as the default rather than thrown.
        .catch { e -> if (e is IOException) emit(emptyPreferences()) else throw e }
        .map { prefs -> prefs[POLISH_ENABLED] ?: DEFAULT_POLISH_ENABLED }

    /** The current value, once. What the session reads when it is about to polish. */
    suspend fun polishEnabledNow(): Boolean = polishEnabled.first()

    suspend fun setPolishEnabled(enabled: Boolean) {
        store.edit { prefs -> prefs[POLISH_ENABLED] = enabled }
    }

    companion object {
        /** On, matching iOS. See [polishEnabled]. */
        const val DEFAULT_POLISH_ENABLED = true

        private val POLISH_ENABLED = booleanPreferencesKey("polish-enabled")
    }
}
