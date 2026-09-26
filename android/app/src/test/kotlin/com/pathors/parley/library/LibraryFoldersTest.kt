package com.pathors.parley.library

import com.pathors.parley.cloud.CloudFolder
import com.pathors.parley.cloud.CloudOrg
import com.pathors.parley.cloud.RecordingSource
import com.pathors.parley.cloud.RecordingSummary
import com.pathors.parley.ui.HomeViewModel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The library's folder pages and its scope, as the view model decides them.
 *
 * The orphan rule is the one that matters most: a recording filed on the
 * desktop under a folder that has since been deleted must still be somewhere
 * on the phone — under Unfiled — and not vanish from every page but All.
 */
class LibraryFoldersTest {

    private fun recording(id: String, folderId: String?, title: String = id) = RecordingSummary(
        id = id,
        title = title,
        source = RecordingSource.LIVE,
        createdAt = 1_700_000_000_000.0,
        durationMs = 60_000.0,
        hasAudio = true,
        folderId = folderId,
    )

    private val folders = listOf(
        CloudFolder(id = "renewals", name = "Renewals"),
        CloudFolder(id = "new", name = "New business"),
    )

    private val library = listOf(
        recording("a", "renewals", "Northwind renewal"),
        recording("b", null, "Halcyon discovery"),
        recording("c", "deleted-on-desktop", "Meridian review"),
        recording("d", "new", "Acme intro"),
    )

    private fun ids(filter: FolderFilter) = LibraryFolders.filter(library, folders, filter).map { it.id }

    @Test
    fun `All is every recording in the server's order`() {
        assertEquals(listOf("a", "b", "c", "d"), ids(FolderFilter.All))
    }

    @Test
    fun `a folder page shows only its own recordings`() {
        assertEquals(listOf("a"), ids(FolderFilter.Folder("renewals")))
        assertEquals(listOf("d"), ids(FolderFilter.Folder("new")))
    }

    @Test
    fun `an orphaned folder id renders as unfiled`() {
        assertEquals(listOf("b", "c"), ids(FolderFilter.Unfiled))
        assertNull(LibraryFolders.liveFolderId("deleted-on-desktop", folders))
        assertNull(LibraryFolders.folderName(library[2], folders))
        assertEquals("Renewals", LibraryFolders.folderName(library[0], folders))
    }

    @Test
    fun `a folder page for a folder nobody has is empty, not everything`() {
        assertEquals(emptyList<String>(), ids(FolderFilter.Folder("nope")))
    }

    @Test
    fun `a selected folder that disappeared falls back to All`() {
        assertEquals(
            FolderFilter.All,
            LibraryFolders.reconcile(FolderFilter.Folder("gone"), folders),
        )
        assertEquals(
            FolderFilter.Folder("new"),
            LibraryFolders.reconcile(FolderFilter.Folder("new"), folders),
        )
        assertEquals(FolderFilter.Unfiled, LibraryFolders.reconcile(FolderFilter.Unfiled, folders))
    }

    /** No chips on screen means no page but All — see [LibraryFolders.reconcile]. */
    @Test
    fun `no folders means All`() {
        assertEquals(FolderFilter.All, LibraryFolders.reconcile(FolderFilter.Unfiled, emptyList()))
    }

    @Test
    fun `personal folders exclude any org folder the endpoint returned`() {
        val mixed = folders + CloudFolder(id = "org-f", name = "Pipeline", orgId = "o1")
        assertEquals(listOf("renewals", "new"), LibraryFolders.personalFolders(mixed).map { it.id })
    }

    // ── scope ────────────────────────────────────────────────────────────────

    private val orgs = listOf(CloudOrg(id = "o1", name = "Sales", role = "admin"))

    @Test
    fun `personal stays personal`() {
        assertNull(LibraryFolders.resolveScope(null, orgs))
        assertNull(LibraryFolders.resolveScope(null, null))
    }

    @Test
    fun `an org the account still belongs to stays selected`() {
        assertEquals("o1", LibraryFolders.resolveScope("o1", orgs))
    }

    /** Removed from the team since picking it: back to personal, not a 403 banner forever. */
    @Test
    fun `an org the account left falls back to personal`() {
        assertNull(LibraryFolders.resolveScope("o2", orgs))
        assertNull(LibraryFolders.resolveScope("o1", emptyList()))
    }

    /** Offline is not the same as removed. */
    @Test
    fun `an unknown membership list keeps the selection`() {
        assertEquals("o1", LibraryFolders.resolveScope("o1", null))
    }

    // ── folder page and search together ─────────────────────────────────────

    @Test
    fun `search narrows the selected page, and one query spans the whole page`() {
        fun visible(filter: FolderFilter, query: String) =
            HomeViewModel.visibleRecordings(library, folders, filter, query).map { it.id }

        assertEquals(listOf("b", "c"), visible(FolderFilter.Unfiled, ""))
        assertEquals(listOf("c"), visible(FolderFilter.Unfiled, "meridian"))
        assertEquals(emptyList<String>(), visible(FolderFilter.Folder("renewals"), "meridian"))
        assertEquals(listOf("a", "b", "c", "d"), visible(FolderFilter.All, ""))
    }
}
