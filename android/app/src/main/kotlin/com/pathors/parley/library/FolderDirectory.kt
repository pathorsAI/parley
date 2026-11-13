package com.pathors.parley.library

import com.pathors.parley.cloud.CloudClient
import com.pathors.parley.cloud.CloudFolder
import com.pathors.parley.cloud.CloudOrg
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope

/** One library a recording can be filed in: the personal one ([org] null) or an organization's. */
data class FolderScope(val org: CloudOrg?, val folders: List<CloudFolder>) {
    val orgId: String? get() = org?.id
}

/**
 * Every place a recording can be filed: the personal folders, and each
 * organization with its own. What the folder picker lists, section by
 * section, and what the account sheet's "Default save location" offers.
 */
data class FolderDirectory(
    val personalFolders: List<CloudFolder> = emptyList(),
    val orgs: List<CloudOrg> = emptyList(),
    val orgFolders: Map<String, List<CloudFolder>> = emptyMap(),
) {
    /**
     * The scopes a recording that lives in [fromOrgId] (null = personal) can
     * be filed into, in the order the picker draws them.
     *
     * A personal recording can go anywhere: a personal folder is a refile, an
     * organization is a share. An organization's recording can only move
     * between that organization's folders — the cloud has no call that takes
     * one out of an organization ([MoveRules]).
     */
    fun scopesFor(fromOrgId: String?): List<FolderScope> {
        if (fromOrgId != null) {
            val org = orgs.firstOrNull { it.id == fromOrgId } ?: CloudOrg(id = fromOrgId, name = "")
            return listOf(FolderScope(org, orgFolders[fromOrgId].orEmpty()))
        }
        return listOf(FolderScope(null, personalFolders)) +
            orgs.map { FolderScope(it, orgFolders[it.id].orEmpty()) }
    }

    /** [folder] added to its scope, once — what a picker's create leaves behind. */
    fun withFolder(orgId: String?, folder: CloudFolder): FolderDirectory {
        val existing = if (orgId == null) personalFolders else orgFolders[orgId].orEmpty()
        if (existing.any { it.id == folder.id }) return this
        return if (orgId == null) {
            copy(personalFolders = personalFolders + folder)
        } else {
            copy(orgFolders = orgFolders + (orgId to existing + folder))
        }
    }

    /** Folder [folderId] of scope [orgId] renamed — what a chip-row rename leaves behind. */
    fun withFolderRenamed(orgId: String?, folderId: String, name: String): FolderDirectory =
        mapScope(orgId) { folders -> folders.map { if (it.id == folderId) it.copy(name = name) else it } }

    /** Folder [folderId] gone from scope [orgId] — what a chip-row delete leaves behind. */
    fun withoutFolder(orgId: String?, folderId: String): FolderDirectory =
        mapScope(orgId) { folders -> folders.filterNot { it.id == folderId } }

    private fun mapScope(orgId: String?, edit: (List<CloudFolder>) -> List<CloudFolder>): FolderDirectory =
        when {
            orgId == null -> copy(personalFolders = edit(personalFolders))
            // A scope this directory never loaded stays unloaded, not empty.
            orgId !in orgFolders -> this
            else -> copy(orgFolders = orgFolders + (orgId to edit(orgFolders.getValue(orgId))))
        }

    /**
     * Where [destination] is, in words: the folder's name, or null for a
     * scope's root and for a folder this directory does not know.
     */
    fun folderName(destination: SaveDestination): String? {
        val id = destination.folderId ?: return null
        val folders = if (destination.orgId == null) personalFolders else orgFolders[destination.orgId].orEmpty()
        return folders.firstOrNull { it.id == id }?.name
    }

    fun orgName(orgId: String): String? = orgs.firstOrNull { it.id == orgId }?.name

    companion object {
        /**
         * The whole directory, best-effort throughout: a list that fails to
         * load is an empty one, so a picker missing one organization's folders
         * still offers the organization itself. [knownOrgs] stands in for the
         * membership list when that request fails.
         */
        suspend fun load(cloud: CloudClient, knownOrgs: List<CloudOrg> = emptyList()): FolderDirectory =
            coroutineScope {
                val orgs = async { bestEffort { cloud.myOrgs() } ?: knownOrgs }
                val personal = async {
                    bestEffort { LibraryFolders.personalFolders(cloud.listFolders()) }.orEmpty()
                }
                val members = orgs.await()
                val perOrg = members.map { org ->
                    async { org.id to bestEffort { cloud.orgFolders(org.id) }.orEmpty() }
                }
                FolderDirectory(
                    personalFolders = personal.await(),
                    orgs = members,
                    orgFolders = perOrg.awaitAll().toMap(),
                )
            }

        private suspend fun <T> bestEffort(block: suspend () -> T): T? = try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            null
        }
    }
}

/**
 * What moving a recording to a [SaveDestination] takes, decided from where the
 * recording lives. The calls behind each are the desktop's and iOS's:
 *
 * - personal → personal: a re-push of the meta with the new folder;
 * - organization → the same organization: `PATCH …/folder`;
 * - personal → an organization: share a copy into it (into the folder, if one
 *   was picked), then delete the personal original — "Move to organization";
 * - organization → anywhere else: not offered. The cloud has no call that
 *   takes a recording out of an organization; the desktop's "save a copy to
 *   my library" downloads the whole entry and writes it to its own disk.
 */
sealed interface MovePlan {
    /** Already there. */
    data object Stay : MovePlan

    data class RefilePersonal(val folderId: String?) : MovePlan

    data class RefileInOrg(val orgId: String, val folderId: String?) : MovePlan

    data class MoveIntoOrg(val orgId: String, val folderId: String?) : MovePlan

    data object Unsupported : MovePlan
}

object MoveRules {
    /**
     * @param fromOrgId the organization the recording lives in, or null for personal.
     * @param fromFolderId its live folder (orphans already counted as the root).
     */
    fun plan(fromOrgId: String?, fromFolderId: String?, to: SaveDestination): MovePlan = when {
        fromOrgId == to.orgId && fromFolderId == to.folderId -> MovePlan.Stay
        fromOrgId == null && to.orgId == null -> MovePlan.RefilePersonal(to.folderId)
        fromOrgId == null && to.orgId != null -> MovePlan.MoveIntoOrg(to.orgId, to.folderId)
        fromOrgId != null && to.orgId == fromOrgId -> MovePlan.RefileInOrg(fromOrgId, to.folderId)
        else -> MovePlan.Unsupported
    }
}
