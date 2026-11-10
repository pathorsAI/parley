package com.pathors.parley.ui

import com.pathors.parley.cloud.CloudFolder
import com.pathors.parley.cloud.CloudOrg
import com.pathors.parley.kit.FolderSearch
import com.pathors.parley.library.FolderScope
import com.pathors.parley.library.SaveDestination

/**
 * What [FolderPickerSheet]'s rows and keys do, decided without Compose so it
 * can be tested. Matching itself is [FolderSearch]; this is what the sheet does
 * with a match, or with the lack of one.
 *
 * Nothing here files anything. A tap or Return *selects* a place; only the
 * sheet's confirm button hands the selection back. A tester filed a meeting
 * into the wrong folder because one tap used to be the whole move.
 */
internal object FolderPickerRules {

    /** One row under the search field. */
    sealed interface Item {
        /** "Suggested": the filing suggestion's own folders, listed first. */
        data object SuggestedHeader : Item

        /** A scope's label: the personal library ([org] null), or an organization's name. */
        data class ScopeHeader(val org: CloudOrg?) : Item

        /** A place to put the recording: a folder, or the scope's root ([isRoot]). */
        data class Place(
            val destination: SaveDestination,
            val name: String,
            val isRoot: Boolean = false,
            /** Listed again under Suggested; keyed apart from its row in its scope. */
            val suggested: Boolean = false,
        ) : Item
    }

    /**
     * The rows for [query]: Suggested first (personal folders only), then each
     * scope under its own header, root first, then its folders in the server's
     * order. A scope with nothing matching draws no header. The root answers to
     * its own label, as a folder answers to its name.
     *
     * @param rootLabel the root's name for a scope ("Unfiled", "No folder").
     * @param showsRoot false where a root is not an answer (the filing card:
     *   "nowhere" is not where something should live).
     */
    fun items(
        scopes: List<FolderScope>,
        query: String,
        suggested: List<CloudFolder>,
        rootLabel: (FolderScope) -> String,
        showsRoot: Boolean,
    ): List<Item> = buildList {
        val personal = scopes.firstOrNull { it.org == null }?.folders.orEmpty()
        val live = personal.mapTo(HashSet()) { it.id }
        val suggestedMatches = FolderSearch.filter(suggested.filter { it.id in live }, query) { it.name }
        if (suggestedMatches.isNotEmpty()) {
            add(Item.SuggestedHeader)
            suggestedMatches.forEach { add(Item.Place(SaveDestination(folderId = it.id), it.name, suggested = true)) }
        }
        scopes.forEach { scope ->
            val root = showsRoot && FolderSearch.matches(rootLabel(scope), query)
            val folders = FolderSearch.filter(scope.folders, query) { it.name }
            if (!root && folders.isEmpty()) return@forEach
            add(Item.ScopeHeader(scope.org))
            if (root) add(Item.Place(SaveDestination(orgId = scope.orgId), rootLabel(scope), isRoot = true))
            folders.forEach { add(Item.Place(SaveDestination(orgId = scope.orgId, folderId = it.id), it.name)) }
        }
    }

    /** The folders among [items], once each — what Return counts as matches. */
    fun folderMatches(items: List<Item>): List<SaveDestination> =
        items.filterIsInstance<Item.Place>()
            .filter { !it.isRoot && !it.suggested }
            .map { it.destination }

    /** What Return in the search field does. */
    enum class SubmitAction { NOTHING, SELECT_ONLY_MATCH, OPEN_CREATE }

    /**
     * Return in the search field: one match is selected (not filed), no match
     * is the create row opened with the name already in it — where there is a
     * create at all.
     */
    fun submitAction(trimmedQuery: String, matchCount: Int, canCreate: Boolean): SubmitAction = when {
        trimmedQuery.isEmpty() -> SubmitAction.NOTHING
        matchCount == 1 -> SubmitAction.SELECT_ONLY_MATCH
        matchCount == 0 && canCreate -> SubmitAction.OPEN_CREATE
        else -> SubmitAction.NOTHING
    }

    /** What tapping Create does with the typed name. */
    sealed interface CreateAction {
        /** Nothing to do: no name, no create endpoint, or a request already out. */
        data object Ignore : CreateAction

        /** A name that already exists selects it, not a second folder with the same customer in it. */
        data class SelectExisting(val folderId: String) : CreateAction

        /** A new folder with this (normalized) name. */
        data class Create(val name: String) : CreateAction
    }

    /** @param folders the folders of the scope a create would make one in. */
    fun createAction(
        typedName: String,
        folders: List<CloudFolder>,
        canCreate: Boolean,
        busy: Boolean,
    ): CreateAction {
        val name = FolderSearch.normalized(typedName)
        if (!canCreate || name.isEmpty() || busy) return CreateAction.Ignore
        val existing = FolderSearch.exactMatch(folders, name) { it.name }
        return if (existing != null) CreateAction.SelectExisting(existing.id) else CreateAction.Create(name)
    }

    /** The create row reads "Create “…”" when the search names a folder that is not there. */
    fun offersNamedCreate(trimmedQuery: String, matchCount: Int): Boolean =
        trimmedQuery.isNotEmpty() && matchCount == 0

    /** "No match" stands in for the list only when nothing else would: no row, and no create row. */
    fun showsNoMatch(items: List<Item>, canCreate: Boolean): Boolean = items.isEmpty() && !canCreate

    /**
     * Whether the confirm button does anything: a place is selected, and it is
     * not where the recording already is.
     */
    fun canConfirm(selected: SaveDestination?, current: SaveDestination?): Boolean =
        selected != null && selected != current
}
