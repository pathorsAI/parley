package com.pathors.parley.ui

import com.pathors.parley.cloud.CloudFolder
import com.pathors.parley.cloud.CloudOrg
import com.pathors.parley.cloud.RecordingSource
import com.pathors.parley.cloud.RecordingSummary
import com.pathors.parley.library.FolderDirectory
import com.pathors.parley.library.FolderFilter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

/**
 * The chip row's Rename / Delete / "+" (iOS `LibraryView` parity): what the
 * library looks like once the server has said yes, which name a dialog sends,
 * and which sentence a failure gets. The dialogs themselves are composables;
 * this is the part that decides what is true on screen afterwards.
 */
class FolderManagementTest {

    private val acme = CloudFolder(id = ACME, name = ACME_NAME)
    private val globex = CloudFolder(id = GLOBEX, name = "Globex")

    private fun recording(id: String, folderId: String?) = RecordingSummary(
        id = id,
        title = id,
        source = RecordingSource.LIVE,
        createdAt = 1_700_000_000_000.0,
        durationMs = 60_000.0,
        hasAudio = true,
        folderId = folderId,
    )

    private val state = HomeViewModel.UiState(
        loading = false,
        folders = listOf(acme, globex),
        recordings = listOf(
            recording("r1", ACME),
            recording("r2", ACME),
            recording("r3", GLOBEX),
            recording("r4", null),
        ),
        folderFilter = FolderFilter.Folder(ACME),
    )

    // ── rename ──────────────────────────────────────────────────────────────

    @Test
    fun `a rename changes that folder's name and nothing else`() {
        val renamed = HomeViewModel.withFolderRenamed(state, ACME, NEW_NAME)
        assertEquals(listOf(NEW_NAME, "Globex"), renamed.folders.map { it.name })
        assertEquals(listOf(ACME, GLOBEX), renamed.folders.map { it.id })
        assertEquals(state.recordings, renamed.recordings)
        assertEquals(state.folderFilter, renamed.folderFilter)
    }

    // ── delete ──────────────────────────────────────────────────────────────

    @Test
    fun `a delete moves the folder's recordings to Unfiled and deletes none`() {
        val after = HomeViewModel.withFolderDeleted(state, ACME)
        assertEquals(listOf(globex), after.folders)
        assertEquals(state.recordings.map { it.id }, after.recordings.map { it.id })
        assertEquals(listOf(null, null, GLOBEX, null), after.recordings.map { it.folderId })
    }

    @Test
    fun `deleting the selected folder sends the page back to All`() {
        assertEquals(FolderFilter.All, HomeViewModel.withFolderDeleted(state, ACME).folderFilter)
    }

    @Test
    fun `deleting another folder keeps the page where it was`() {
        assertEquals(FolderFilter.Folder(ACME), HomeViewModel.withFolderDeleted(state, GLOBEX).folderFilter)
        val onUnfiled = state.copy(folderFilter = FolderFilter.Unfiled)
        assertEquals(FolderFilter.Unfiled, HomeViewModel.withFolderDeleted(onUnfiled, ACME).folderFilter)
    }

    @Test
    fun `the delete dialog counts what is filed in the folder`() {
        assertEquals(2, HomeViewModel.folderRecordingCount(state.recordings, ACME))
        assertEquals(1, HomeViewModel.folderRecordingCount(state.recordings, GLOBEX))
        assertEquals(0, HomeViewModel.folderRecordingCount(state.recordings, "empty"))
    }

    // ── the name a dialog sends ─────────────────────────────────────────────

    @Test
    fun `a name is trimmed and a blank one is not sent`() {
        assertEquals(NEW_NAME, LibraryRules.folderNameToCommit("  $NEW_NAME \n", current = null))
        assertNull(LibraryRules.folderNameToCommit("   ", current = null))
        assertNull(LibraryRules.folderNameToCommit("", current = ACME_NAME))
    }

    @Test
    fun `an unchanged rename is not sent`() {
        assertNull(LibraryRules.folderNameToCommit(" $ACME_NAME ", current = ACME_NAME))
        assertEquals(NEW_NAME, LibraryRules.folderNameToCommit(NEW_NAME, current = ACME_NAME))
    }

    // ── failures ────────────────────────────────────────────────────────────

    @Test
    fun `a 403 says who can change the folder, anything else is retryable`() {
        assertEquals(LibraryActionError.FolderForbidden, LibraryRules.folderError(forbidden = true))
        assertEquals(LibraryActionError.FolderFailed, LibraryRules.folderError(forbidden = false))
    }

    // ── the picker's directory follows ──────────────────────────────────────

    @Test
    fun `the directory follows a rename and a delete in the right scope`() {
        val org = CloudOrg(id = ORG, name = "Team")
        val directory = FolderDirectory(
            personalFolders = listOf(acme),
            orgs = listOf(org),
            orgFolders = mapOf(ORG to listOf(globex)),
        )

        val personal = directory.withFolderRenamed(null, ACME, NEW_NAME)
        assertEquals(listOf(NEW_NAME), personal.personalFolders.map { it.name })
        assertEquals(directory.orgFolders, personal.orgFolders)

        val inOrg = directory.withoutFolder(ORG, GLOBEX)
        assertEquals(emptyList<CloudFolder>(), inOrg.orgFolders.getValue(ORG))
        assertEquals(directory.personalFolders, inOrg.personalFolders)
    }

    @Test
    fun `an organization the directory never loaded stays unloaded`() {
        val directory = FolderDirectory(personalFolders = listOf(acme))
        assertSame(directory, directory.withoutFolder("unknown", ACME))
    }

    private companion object {
        const val ACME = "acme"
        const val ACME_NAME = "Acme"
        const val GLOBEX = "globex"
        const val ORG = "o1"
        const val NEW_NAME = "Acme Corp"
    }
}
