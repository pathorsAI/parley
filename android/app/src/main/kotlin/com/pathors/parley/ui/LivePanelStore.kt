package com.pathors.parley.ui

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.floatPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import java.io.IOException
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/**
 * Its own store, for the reason the library and playback ones are: a layout
 * preference is a device setting, and signing out must not take it along.
 */
private val Context.parleyLivePanelStore: DataStore<Preferences> by
    preferencesDataStore(name = "parley_live_panel")

/**
 * How far open the user last left the live meeting's controls panel, as a
 * fraction (0 compact … 1 full; see [LivePanel]). The next recording opens the
 * panel there. Missing or unreadable means fully open — the layout every
 * install starts with.
 */
class LivePanelStore(private val store: DataStore<Preferences>) {

    suspend fun current(): Float = store.data
        .catch { e -> if (e is IOException) emit(emptyPreferences()) else throw e }
        .map { preferences -> (preferences[KEY] ?: 1f).coerceIn(0f, 1f) }
        .first()

    suspend fun set(fraction: Float) {
        try {
            store.edit { preferences -> preferences[KEY] = fraction.coerceIn(0f, 1f) }
        } catch (_: IOException) {
            // Losing this costs the user one drag next time; not worth a crash
            // in the middle of a meeting.
        }
    }

    companion object {
        private val KEY = floatPreferencesKey("controls-fraction")

        fun default(context: Context): LivePanelStore =
            LivePanelStore(context.applicationContext.parleyLivePanelStore)
    }
}
