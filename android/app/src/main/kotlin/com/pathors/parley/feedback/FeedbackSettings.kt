package com.pathors.parley.feedback

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/**
 * Its own store, like every other device setting: signing out clears the auth
 * store, and must not take this switch with it.
 */
private val Context.parleyFeedbackStore: DataStore<Preferences> by preferencesDataStore(name = "parley_feedback")

/**
 * The one feedback setting a person controls — "Send crash reports
 * automatically" — and the exit-info watermark ([CrashSelection]) that belongs
 * beside it.
 *
 * **The switch defaults to on**, by decision (spec §6): a crash nobody reports
 * is a crash nobody fixes, and the report carries only the version, the device
 * and where it crashed. An unset key reads as the default, never as off, so a
 * phone that has never opened the account sheet sends them.
 */
class FeedbackSettings(context: Context) {

    private val store = context.applicationContext.parleyFeedbackStore

    val autoSendCrashes: Flow<Boolean> =
        store.data.map { it[AUTO_SEND_CRASHES] ?: DEFAULT_AUTO_SEND_CRASHES }

    suspend fun autoSendCrashesNow(): Boolean = autoSendCrashes.first()

    suspend fun setAutoSendCrashes(on: Boolean) {
        store.edit { it[AUTO_SEND_CRASHES] = on }
    }

    /** The newest exit record already dealt with, or null before the first launch that looked. */
    suspend fun exitWatermarkMs(): Long? = store.data.first()[EXIT_WATERMARK]

    suspend fun setExitWatermarkMs(value: Long) {
        store.edit { it[EXIT_WATERMARK] = value }
    }

    companion object {
        const val DEFAULT_AUTO_SEND_CRASHES = true
        private val AUTO_SEND_CRASHES = booleanPreferencesKey("auto-send-crash-reports")
        private val EXIT_WATERMARK = longPreferencesKey("exit-info-watermark-ms")
    }
}
