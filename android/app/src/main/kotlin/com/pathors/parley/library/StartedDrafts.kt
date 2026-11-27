package com.pathors.parley.library

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * The meeting drafts a meeting has been started from on this phone — iOS
 * `TabRouter.startedDraftIDs`.
 *
 * The desktop deletes a draft it records ("taking a draft is recording it",
 * `takeDraft` in `src/lib/store/prep.ts`), but the phone only reads drafts and
 * never writes them, so it hides the one it took instead; the cloud copy
 * stays for the desktop to settle. Kept across launches in
 * `SharedPreferences`, and pruned to the drafts the cloud still lists
 * ([prune]), so the set never outgrows the draft list.
 *
 * [persist] is false in demo mode, which promises no residue on the phone.
 */
class StartedDrafts(
    private val preferences: SharedPreferences,
    private val persist: () -> Boolean = { true },
) {
    private val _ids = MutableStateFlow(load())

    /** The ids of the drafts hidden on this phone. */
    val ids: StateFlow<Set<String>> = _ids.asStateFlow()

    /** A meeting was started from [id]: hide it on this phone. */
    fun markStarted(id: String) {
        if (id in _ids.value) return
        _ids.update { it + id }
        save()
    }

    /**
     * Forget hidden drafts the cloud no longer lists. Only with a list that
     * actually loaded: the empty answer of a failed request would lose every
     * id and bring the started drafts back.
     */
    fun prune(listed: Set<String>) {
        val kept = _ids.value intersect listed
        if (kept == _ids.value) return
        _ids.value = kept
        save()
    }

    private fun load(): Set<String> =
        preferences.getStringSet(KEY, null)?.toSet().orEmpty()

    private fun save() {
        if (!persist()) return
        // A copy: SharedPreferences must not be handed a set it may see change.
        preferences.edit { putStringSet(KEY, HashSet(_ids.value)) }
    }

    companion object {
        private const val FILE = "parley_meeting_drafts"
        private const val KEY = "startedDraftIds"

        /** The device's store. */
        fun device(context: Context, persist: () -> Boolean = { true }): StartedDrafts =
            StartedDrafts(
                context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE),
                persist,
            )
    }
}
