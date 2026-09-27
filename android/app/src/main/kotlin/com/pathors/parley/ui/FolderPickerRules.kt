package com.pathors.parley.ui

import com.pathors.parley.cloud.CloudFolder
import com.pathors.parley.kit.FolderSearch

/**
 * What [FolderPickerSheet]'s rows and keys do, decided without Compose so it
 * can be tested. Matching itself is [FolderSearch]; this is what the sheet does
 * with a match, or with the lack of one.
 */
internal object FolderPickerRules {

    /** What Return in the search field does. */
    enum class SubmitAction { NOTHING, PICK_ONLY_MATCH, OPEN_CREATE }

    /**
     * Return in the search field: one match is a pick, no match is the create
     * row opened with the name already in it — where there is a create at all.
     */
    fun submitAction(trimmedQuery: String, matchCount: Int, canCreate: Boolean): SubmitAction = when {
        trimmedQuery.isEmpty() -> SubmitAction.NOTHING
        matchCount == 1 -> SubmitAction.PICK_ONLY_MATCH
        matchCount == 0 && canCreate -> SubmitAction.OPEN_CREATE
        else -> SubmitAction.NOTHING
    }

    /** What tapping Create does with the typed name. */
    sealed interface CreateAction {
        /** Nothing to do: no name, no create endpoint, or a request already out. */
        data object Ignore : CreateAction

        /** A name that already exists is a pick, not a second folder with the same customer in it. */
        data class PickExisting(val folderId: String) : CreateAction

        /** A new folder with this (normalized) name. */
        data class Create(val name: String) : CreateAction
    }

    fun createAction(
        typedName: String,
        folders: List<CloudFolder>,
        canCreate: Boolean,
        busy: Boolean,
    ): CreateAction {
        val name = FolderSearch.normalized(typedName)
        if (!canCreate || name.isEmpty() || busy) return CreateAction.Ignore
        val existing = FolderSearch.exactMatch(folders, name) { it.name }
        return if (existing != null) CreateAction.PickExisting(existing.id) else CreateAction.Create(name)
    }

    /** The create row reads "Create “…”" when the search names a folder that is not there. */
    fun offersNamedCreate(trimmedQuery: String, matchCount: Int): Boolean =
        trimmedQuery.isNotEmpty() && matchCount == 0

    /**
     * "No match" stands in for the list only when nothing else would: no
     * folder, no Unfiled, and no create row (which always has something to say).
     */
    fun showsNoMatch(matchCount: Int, showsUnfiled: Boolean, canCreate: Boolean): Boolean =
        matchCount == 0 && !showsUnfiled && !canCreate
}
