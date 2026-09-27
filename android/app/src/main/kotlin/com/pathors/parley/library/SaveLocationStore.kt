package com.pathors.parley.library

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/**
 * The Preferences DataStore holding library preferences. Its own store, for
 * the reason `parley_playback` is: signing out clears the auth store, and a
 * device setting must not go with it.
 */
private val Context.parleyLibraryStore: DataStore<Preferences> by
    preferencesDataStore(name = "parley_library")

/**
 * "Default save location" — where a recording made or imported on this phone
 * ends up. See [SaveDestination] for what an organization choice means.
 *
 * Read by the upload path with no UI alive, so this is a plain class with a
 * suspend read, like `AudioRetention`. Takes the [DataStore] rather than a
 * [Context] so a JVM test can hand it a file-backed store of its own.
 */
class SaveLocationStore(private val store: DataStore<Preferences>) {

    /** Emits on every change — what the account sheet's picker binds to. */
    val destination: Flow<SaveDestination> =
        store.data.map { preferences -> SaveDestination.decode(preferences[KEY]) }

    /**
     * One-shot read for the upload path, taken when a recording is queued —
     * the destination a recording was *made* under is the one it keeps, even
     * if the setting changes while it waits for a network.
     */
    suspend fun current(): SaveDestination = destination.first()

    suspend fun set(destination: SaveDestination) {
        store.edit { preferences ->
            if (destination == SaveDestination.PERSONAL_ROOT) {
                // The default is the absence of a choice, so an install that
                // never touched this and one that went back to it read alike.
                preferences.remove(KEY)
            } else {
                preferences[KEY] = destination.encode()
            }
        }
    }

    companion object {
        private val KEY = stringPreferencesKey("default-save-location")

        fun default(context: Context): SaveLocationStore =
            SaveLocationStore(context.applicationContext.parleyLibraryStore)
    }
}
