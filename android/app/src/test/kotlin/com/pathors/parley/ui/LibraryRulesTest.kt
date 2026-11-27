package com.pathors.parley.ui

import com.pathors.parley.cloud.CloudFolder
import com.pathors.parley.cloud.CloudOrg
import com.pathors.parley.cloud.RecordingSource
import com.pathors.parley.cloud.RecordingSummary
import com.pathors.parley.library.FolderFilter
import com.pathors.parley.meeting.ImportFailure
import com.pathors.parley.meeting.ImportNotice
import com.pathors.parley.meeting.ImportState
import com.pathors.parley.playback.AudioDownloadState
import com.pathors.parley.playback.PlaybackFailure
import com.pathors.parley.playback.PlaybackPhase
import com.pathors.parley.screenshot.DemoMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.TimeZone

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
    fun `a personal row can be shared to every org`() {
        val state = HomeViewModel.UiState(orgs = listOf(team))
        val row = LibraryRules.recordingRow(state, recording)
        assertEquals(listOf(team), row.shareTargets)
        assertTrue(row.canShare)
        assertNull("an orphaned folder id reads as unfiled", row.folderName)
    }

    @Test
    fun `an org row is never shared`() {
        val empty = HomeViewModel.UiState(scopeOrgId = team.id, orgs = listOf(team))
        assertFalse(LibraryRules.recordingRow(empty, recording).canShare)

        val withFolders = empty.copy(folders = listOf(northwind))
        val row = LibraryRules.recordingRow(withFolders, recording)
        assertEquals("Northwind", row.folderName)
        assertTrue(row.shareTargets.isEmpty())
    }

    @Test
    fun `a personal row offers download, then remove, and nothing while one runs`() {
        val personal = HomeViewModel.UiState()
        fun action(audio: AudioDownloadState) =
            LibraryRules.recordingRow(personal, recording, audio).downloadAction

        assertEquals(DownloadAction.DOWNLOAD, action(AudioDownloadState.Absent))
        assertEquals(
            "a failure is retried from the same entry",
            DownloadAction.DOWNLOAD,
            action(AudioDownloadState.Failed(PlaybackFailure.DOWNLOAD_NETWORK)),
        )
        assertNull(action(AudioDownloadState.Downloading(0.4f)))
        assertEquals(DownloadAction.REMOVE, action(AudioDownloadState.Local))

        val silent = recording.copy(hasAudio = false)
        assertNull(
            "the cloud has no audio to send",
            LibraryRules.recordingRow(personal, silent, AudioDownloadState.Absent).downloadAction,
        )
    }

    @Test
    fun `an org row and the sample offer no download, but still say where the audio is`() {
        val org = HomeViewModel.UiState(scopeOrgId = team.id, orgs = listOf(team))
        val orgRow = LibraryRules.recordingRow(org, recording, AudioDownloadState.Local)
        assertNull(orgRow.downloadAction)
        assertEquals(AudioDownloadState.Local, orgRow.audio)

        val sample = recording.copy(id = "sample-en")
        assertNull(LibraryRules.recordingRow(HomeViewModel.UiState(), sample).downloadAction)
    }

    @Test
    fun `the library reads the sample as on the phone and everything else from the store`() {
        val audio = HomeViewModel.LibraryAudio(
            active = mapOf("r2" to AudioDownloadState.Downloading(0.5f)),
            onPhone = setOf("r1"),
        )
        assertEquals(AudioDownloadState.Local, audio.stateOf("r1"))
        assertEquals(AudioDownloadState.Downloading(0.5f), audio.stateOf("r2"))
        assertEquals(AudioDownloadState.Absent, audio.stateOf("r3"))
        assertEquals(AudioDownloadState.Local, audio.stateOf("sample-en"))
    }

    @Test
    fun `the empty state follows the desktop's order`() {
        val folder = FolderFilter.Folder(northwind.id)
        assertEquals(EmptyLibraryState.NO_MATCH, LibraryRules.emptyState("north", folder, isPersonal = false))
        assertEquals(EmptyLibraryState.EMPTY_FOLDER, LibraryRules.emptyState("", folder, isPersonal = false))
        assertEquals(EmptyLibraryState.EMPTY_FOLDER, LibraryRules.emptyState(" ", folder, isPersonal = true))
        assertEquals(EmptyLibraryState.EMPTY_ORG, LibraryRules.emptyState("", FolderFilter.All, isPersonal = false))
        assertEquals(EmptyLibraryState.EMPTY_ORG, LibraryRules.emptyState("", FolderFilter.Unfiled, isPersonal = false))
        assertEquals(EmptyLibraryState.ALL_FILED, LibraryRules.emptyState("", FolderFilter.Unfiled, isPersonal = true))
        assertEquals(EmptyLibraryState.NOTHING_YET, LibraryRules.emptyState("", FolderFilter.All, isPersonal = true))
    }

    @Test
    fun `the overview's recent rows are the four newest`() {
        val rows = (1..6).map { recording.copy(id = "r$it", createdAt = it * 1_000.0) }.shuffled()
        assertEquals(listOf("r6", "r5", "r4", "r3"), LibraryRules.recentRecordings(rows).map { it.id })
        assertEquals(listOf("r1"), LibraryRules.recentRecordings(listOf(rows.first { it.id == "r1" })).map { it.id })
    }

    @Test
    fun `a row's date carries its year only outside the current one`() {
        val utc = TimeZone.getTimeZone("UTC")
        val now = 1_786_498_800_000L // 2026-08-12
        assertFalse(LibraryRules.showsYear(1_767_225_600_000L, now, utc)) // 2026-01-01 00:00
        assertTrue(LibraryRules.showsYear(1_767_225_599_000L, now, utc)) // 2025-12-31 23:59:59
        assertTrue(LibraryRules.showsYear(1_798_761_600_000L, now, utc)) // 2027-01-01
    }

    @Test
    fun `an import is announced only once it is in the cloud`() {
        val landed = ImportState.Finished(recordingId = "r1", pendingUpload = false)
        assertEquals(ImportNotice(IMPORTED_TITLE, null), ImportNotice.of(IMPORTED_TITLE, landed))
        assertEquals(
            ImportNotice(IMPORTED_TITLE, ORG_ID),
            ImportNotice.of(IMPORTED_TITLE, landed.copy(sharedToOrgId = ORG_ID)),
        )
        assertNull(
            "still on the phone: the upload queue is already saying so",
            ImportNotice.of(IMPORTED_TITLE, landed.copy(pendingUpload = true)),
        )
        assertNull(ImportNotice.of(IMPORTED_TITLE, ImportState.Failed(ImportFailure.UNKNOWN)))
        assertNull(ImportNotice.of(IMPORTED_TITLE, ImportState.Cancelled))
        assertNull(ImportNotice.of(IMPORTED_TITLE, ImportState.Uploading))
        assertNull(ImportNotice.of(null, null))
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
private const val IMPORTED_TITLE = "Board.m4a"
