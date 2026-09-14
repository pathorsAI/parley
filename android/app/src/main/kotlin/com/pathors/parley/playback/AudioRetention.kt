package com.pathors.parley.playback

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/**
 * The Preferences DataStore holding playback preferences. Its own store rather
 * than a corner of `parley_auth`: signing out must never take a device setting
 * with it, and the auth store is the one thing that gets cleared.
 */
private val Context.parleyPlaybackStore: DataStore<Preferences> by
    androidx.datastore.preferences.preferencesDataStore(name = "parley_playback")

/**
 * "Keep the audio of recordings made here on this phone."
 *
 * **Defaults to on.** A phone that has never opened the account sheet must keep
 * its recordings, or the first thing a new user does — record a meeting, open
 * it, press play — would need a download of something that was on the device
 * thirty seconds earlier. The absence of the key is therefore read as the
 * default rather than as "off", which is exactly what iOS
 * `LocalAudioStore.keepsAudioOnPhone` says about `UserDefaults.bool`.
 *
 * Off means the Ogg is deleted once the cloud has it. Nothing is lost — the
 * recording can still be played back here, it just has to be downloaded first —
 * and that is the trade the setting is offering.
 *
 * Read from the upload path with no UI alive, so this is a plain class with a
 * suspend read rather than anything Compose-shaped.
 */
class AudioRetention(context: Context) {

    private val store = context.applicationContext.parleyPlaybackStore

    /** Emits on every change — what the account sheet's switch binds to. */
    val keepsAudioOnPhone: Flow<Boolean> =
        store.data.map { preferences -> preferences[KEEP_AUDIO_KEY] ?: DEFAULT_KEEP_AUDIO }

    /** One-shot read for the upload path. Cheap — DataStore caches in memory. */
    suspend fun keepsAudioOnPhoneNow(): Boolean = keepsAudioOnPhone.first()

    suspend fun setKeepsAudioOnPhone(keep: Boolean) {
        store.edit { preferences -> preferences[KEEP_AUDIO_KEY] = keep }
    }

    companion object {
        /** See the class doc: an unset key means on, not off. */
        const val DEFAULT_KEEP_AUDIO = true

        private val KEEP_AUDIO_KEY = booleanPreferencesKey("keep-audio-on-phone")
    }
}
