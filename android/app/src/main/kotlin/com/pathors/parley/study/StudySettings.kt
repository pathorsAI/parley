package com.pathors.parley.study

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/**
 * Its own store, like every other device setting: signing out clears the auth
 * store and must not take this switch with it.
 */
private val Context.parleyStudyStore: DataStore<Preferences> by preferencesDataStore(name = "parley_study")

/**
 * "Analyse recordings automatically" — the desktop's `settings.autoStudyAnalysis`.
 *
 * On (the default, as on the desktop): opening a personal recording that has
 * not been analysed yet runs the study stages on the hosted model. Off: the
 * recording stays unanalysed until somebody asks from the report's analysis
 * menu — for whoever would rather have their own AI write the analysis.
 */
class StudySettings(context: Context) {

    private val store = context.applicationContext.parleyStudyStore

    val autoAnalysis: Flow<Boolean> = store.data.map { it[AUTO_ANALYSIS] ?: DEFAULT_AUTO_ANALYSIS }

    suspend fun autoAnalysisNow(): Boolean = autoAnalysis.first()

    suspend fun setAutoAnalysis(on: Boolean) {
        store.edit { it[AUTO_ANALYSIS] = on }
    }

    companion object {
        const val DEFAULT_AUTO_ANALYSIS = true
        private val AUTO_ANALYSIS = booleanPreferencesKey("auto-study-analysis")
    }
}
