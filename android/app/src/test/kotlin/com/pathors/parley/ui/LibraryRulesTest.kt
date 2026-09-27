package com.pathors.parley.ui

import com.pathors.parley.cloud.CloudFolder
import com.pathors.parley.cloud.CloudOrg
import com.pathors.parley.cloud.RecordingSource
import com.pathors.parley.cloud.RecordingSummary
import com.pathors.parley.playback.PlaybackPhase
import com.pathors.parley.screenshot.DemoMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The library's decisions that used to live inside composables: which menu
 * entries a row offers, which error a failed action reports, and when the
 * detail screen draws its player or opens the demo picker.
 */
class LibraryRulesTest {

    private val northwind = CloudFolder(id = "f-northwind", name = "Northwind")
    private val team = CloudOrg(id = ORG_ID, name = ORG_NAME)

    private val recording = RecordingSummary(
        id = "r1",
        title = "Renewal",
        source = RecordingSource.LIVE,
        createdAt = 1_700_000_000_000.0,
        durationMs = 60_000.0,
        hasAudio = true,
        folderId = northwind.id,
    )

    @Test
    fun `a personal row can always be filed and shared to every org`() {
        val state = HomeViewModel.UiState(orgs = listOf(team))
        val row = LibraryRules.recordingRow(state, recording)
        assertTrue(row.canMoveToFolder)
        assertEquals(listOf(team), row.shareTargets)
        assertTrue(row.canShare)
        assertNull("an orphaned folder id reads as unfiled", row.folderName)
    }

    @Test
    fun `an org row can be filed only when the org has folders, and never shared`() {
        val empty = HomeViewModel.UiState(scopeOrgId = team.id, orgs = listOf(team))
        assertFalse(LibraryRules.recordingRow(empty, recording).canMoveToFolder)
        assertFalse(LibraryRules.recordingRow(empty, recording).canShare)

        val withFolders = empty.copy(folders = listOf(northwind))
        val row = LibraryRules.recordingRow(withFolders, recording)
        assertTrue(row.canMoveToFolder)
        assertEquals("Northwind", row.folderName)
        assertTrue(row.shareTargets.isEmpty())
    }

    @Test
    fun `a delete or a move in flight makes the row working`() {
        val idle = LibraryRules.recordingRow(HomeViewModel.UiState(), recording)
        assertFalse(idle.working)

        val deleting = LibraryRules.recordingRow(HomeViewModel.UiState(deleting = setOf(recording.id)), recording)
        assertTrue(deleting.working)
        assertTrue(deleting.deleting)

        val busy = LibraryRules.recordingRow(HomeViewModel.UiState(busy = setOf(recording.id)), recording)
        assertTrue(busy.working)
        assertFalse(busy.deleting)
    }

    @Test
    fun `a forbidden move names the org only in an org library`() {
        assertEquals(
            LibraryActionError.MoveForbidden(ORG_NAME),
            LibraryRules.moveError(scopeOrgId = ORG_ID, forbidden = true, orgName = ORG_NAME),
        )
        assertEquals(
            LibraryActionError.MoveForbidden(""),
            LibraryRules.moveError(scopeOrgId = ORG_ID, forbidden = true, orgName = null),
        )
        assertEquals(
            LibraryActionError.MoveFailed,
            LibraryRules.moveError(scopeOrgId = null, forbidden = true, orgName = null),
        )
        assertEquals(
            LibraryActionError.MoveFailed,
            LibraryRules.moveError(scopeOrgId = ORG_ID, forbidden = false, orgName = ORG_NAME),
        )
    }

    @Test
    fun `a forbidden share names the org`() {
        assertEquals(LibraryActionError.ShareForbidden(ORG_NAME), LibraryRules.shareError(true, ORG_NAME))
        assertEquals(LibraryActionError.ShareFailed, LibraryRules.shareError(false, ORG_NAME))
    }

    @Test
    fun `the player is always drawn for a personal recording`() {
        PlaybackPhase.entries.forEach { phase ->
            assertTrue(phase.name, LibraryRules.showsPlaybackBar(orgId = null, phase = phase))
        }
    }

    @Test
    fun `an org recording's player is drawn only when its audio can play`() {
        assertTrue(LibraryRules.showsPlaybackBar(ORG_ID, PlaybackPhase.READY))
        assertTrue(LibraryRules.showsPlaybackBar(ORG_ID, PlaybackPhase.PREPARING))
        assertFalse(LibraryRules.showsPlaybackBar(ORG_ID, PlaybackPhase.ABSENT))
        assertFalse(LibraryRules.showsPlaybackBar(ORG_ID, PlaybackPhase.DOWNLOADING))
    }

    @Test
    fun `the demo picker opens once per request, over a loaded recording`() {
        val request = DemoMode.Navigation(DemoMode.Screen.MOVE_TO_FOLDER, serial = 3)
        assertTrue(LibraryRules.opensDemoPicker(request, metaLoaded = true, handledSerial = -1))
        assertFalse(LibraryRules.opensDemoPicker(request, metaLoaded = false, handledSerial = -1))
        assertFalse(LibraryRules.opensDemoPicker(request, metaLoaded = true, handledSerial = 3))
        assertFalse(
            LibraryRules.opensDemoPicker(
                DemoMode.Navigation(DemoMode.Screen.ACCOUNT, serial = 4),
                metaLoaded = true,
                handledSerial = -1,
            ),
        )
    }
}

private const val ORG_ID = "org-1"
private const val ORG_NAME = "Team"
