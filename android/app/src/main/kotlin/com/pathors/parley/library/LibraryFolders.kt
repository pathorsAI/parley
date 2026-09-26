package com.pathors.parley.library

import com.pathors.parley.cloud.CloudFolder
import com.pathors.parley.cloud.CloudOrg
import com.pathors.parley.cloud.RecordingSummary

/**
 * Which page of the library is showing: everything, the recordings in no
 * folder, or one folder's. The chip row above the list is this, drawn.
 */
sealed interface FolderFilter {
    /** Every recording in the scope. */
    data object All : FolderFilter

    /** Recordings in no folder — including ones whose folder no longer exists. */
    data object Unfiled : FolderFilter

    data class Folder(val id: String) : FolderFilter
}

/**
 * The folder rules the library renders by, kept apart from the screen because
 * they are the contract — the same ones iOS `LibraryView` and the desktop
 * History grid apply:
 *
 * - **Orphans are unfiled.** A recording whose `folderId` names a folder that
 *   is not in the live list (deleted on the desktop, or created by a device
 *   that has not synced it yet) renders at the root: under Unfiled, with no
 *   folder name on its card. Showing it nowhere would lose it; showing it under
 *   a folder that does not exist is impossible.
 * - **Filtering narrows, it does not re-rank.** The server's order survives.
 */
object LibraryFolders {

    /** The folder a recording is in, as the library renders it: an orphan id is null. */
    fun liveFolderId(folderId: String?, folders: List<CloudFolder>): String? =
        folderId?.takeIf { id -> folders.any { it.id == id } }

    /** The name of the folder [recording] is in, or null at the root (orphans included). */
    fun folderName(recording: RecordingSummary, folders: List<CloudFolder>): String? {
        val id = recording.folderId ?: return null
        return folders.firstOrNull { it.id == id }?.name
    }

    /** [recordings] narrowed to one page of the chip row. */
    fun filter(
        recordings: List<RecordingSummary>,
        folders: List<CloudFolder>,
        filter: FolderFilter,
    ): List<RecordingSummary> = when (filter) {
        FolderFilter.All -> recordings
        FolderFilter.Unfiled -> recordings.filter { liveFolderId(it.folderId, folders) == null }
        is FolderFilter.Folder -> recordings.filter { liveFolderId(it.folderId, folders) == filter.id }
    }

    /**
     * The selected page after the folder list changed under it. A folder that
     * has gone (deleted on another device) falls back to All rather than to an
     * empty page named after nothing; a library with no folders at all has no
     * chip row, so it is All too — "Unfiled" with no chips to explain it would
     * read as the library having lost something.
     */
    fun reconcile(filter: FolderFilter, folders: List<CloudFolder>): FolderFilter = when {
        folders.isEmpty() -> FolderFilter.All
        filter is FolderFilter.Folder && folders.none { it.id == filter.id } -> FolderFilter.All
        else -> filter
    }

    /** The personal folders out of `GET /folders`, which may carry org folders too. */
    fun personalFolders(folders: List<CloudFolder>): List<CloudFolder> =
        folders.filter { it.orgId == null }

    /**
     * The scope to load, given the one selected and the organizations the
     * account turned out to belong to.
     *
     * [orgs] is null when that list could not be fetched — offline, say — and
     * then the selection stands: not knowing is not the same as having been
     * removed, and bouncing someone out of the team library because one request
     * failed would be its own kind of data loss. Only a list that came back
     * *without* the organization moves the library back to personal.
     */
    fun resolveScope(selectedOrgId: String?, orgs: List<CloudOrg>?): String? = when {
        selectedOrgId == null -> null
        orgs == null -> selectedOrgId
        orgs.any { it.id == selectedOrgId } -> selectedOrgId
        else -> null
    }
}
