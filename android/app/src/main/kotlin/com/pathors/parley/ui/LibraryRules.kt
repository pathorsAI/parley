package com.pathors.parley.ui

import com.pathors.parley.cloud.CloudOrg
import com.pathors.parley.cloud.RecordingSummary
import com.pathors.parley.kit.SampleManifest
import com.pathors.parley.library.LibraryFolders
import com.pathors.parley.playback.AudioDownloadState
import com.pathors.parley.playback.PlaybackPhase
import com.pathors.parley.screenshot.DemoMode

/**
 * One library row as the screen draws it: the recording, where it is filed,
 * whether a request is in flight on it, and which menu entries it offers.
 */
internal data class RecordingRowModel(
    val recording: RecordingSummary,
    val folderName: String?,
    val deleting: Boolean,
    val busy: Boolean,
    val canMoveToFolder: Boolean,
    val shareTargets: List<CloudOrg>,
    /** Where the audio is — the row's last meta item says so. */
    val audio: AudioDownloadState = AudioDownloadState.Absent,
    /**
     * Whether the menu offers Download / Remove download at all: personal
     * scope, and not the bundled sample. The on-phone glyph is not gated the
     * same way — it states a fact about the file, whatever scope the row is in.
     */
    val canDownload: Boolean = false,
) {
    /** A delete, move or share is in flight: the row dims and stops responding. */
    val working: Boolean get() = deleting || busy

    val canShare: Boolean get() = shareTargets.isNotEmpty()

    /** The download entry the menu offers, or null for none. */
    val downloadAction: DownloadAction?
        get() = if (!canDownload) {
            null
        } else {
            when (audio) {
                AudioDownloadState.Local -> DownloadAction.REMOVE
                is AudioDownloadState.Downloading -> null
                // A recording the cloud says has no audio would only 404.
                AudioDownloadState.Absent, is AudioDownloadState.Failed ->
                    if (recording.hasAudio) DownloadAction.DOWNLOAD else null
            }
        }
}

/**
 * The one download entry a row's menu carries, iOS's `downloadAction(for:)`:
 * fetch it (again, after a failure), or give the phone's copy back. Nothing
 * while a download is running — the ring on the row is already the answer.
 */
internal enum class DownloadAction { DOWNLOAD, REMOVE }

/** The widths [LibraryRules.metaWidths] hands the folder and the date, in pixels. */
internal data class MetaWidths(val folder: Int, val date: Int)

/** What a library row's tap and menu entries do. */
internal class RecordingRowActions(
    val onClick: () -> Unit,
    val onMoveToFolder: () -> Unit,
    val onShare: (CloudOrg) -> Unit,
    val onMoveToOrg: (CloudOrg) -> Unit,
    val onDelete: () -> Unit,
    val onDownload: () -> Unit = {},
    val onRemoveDownload: () -> Unit = {},
)

/**
 * The library's decisions — which menu entries a row offers, which error a
 * failed action reports, when the detail screen draws its player — kept out of
 * the composables so they can be tested without a device.
 */
internal object LibraryRules {

    /**
     * The row for [recording] in [state]'s library.
     *
     * Personal scope can create a folder, so it always has somewhere to go; an
     * org scope has no create endpoint here, so it needs folders to offer.
     * Sharing is a copy *out of* the personal library, so only a personal row
     * has share targets — and never the sample, which is not in the cloud to be
     * copied (see `SampleRecordingStore`).
     */
    fun recordingRow(
        state: HomeViewModel.UiState,
        recording: RecordingSummary,
        audio: AudioDownloadState = AudioDownloadState.Absent,
    ) = RecordingRowModel(
        recording = recording,
        folderName = LibraryFolders.folderName(recording, state.folders),
        deleting = recording.id in state.deleting,
        busy = recording.id in state.busy,
        canMoveToFolder = state.isPersonal || state.folders.isNotEmpty(),
        shareTargets = if (state.isPersonal && !SampleManifest.isSample(recording.id)) {
            state.orgs
        } else {
            emptyList()
        },
        audio = audio,
        canDownload = state.isPersonal && !SampleManifest.isSample(recording.id),
    )

    /**
     * How a row's meta line shares out the width its pinned items (the counts,
     * the audio glyphs) leave: [available] pixels between the folder and the
     * date, spacing already taken off.
     *
     * Both get their natural width when they fit. When they do not, the folder
     * gives way first — but only down to [folderMin] (a few characters and the
     * glyph, never less than it needs): from there on the date shortens
     * instead. Without the floor a long date left a folder as a glyph and "…",
     * which says nothing; iOS truncates the folder only as far as it has to.
     * With too little room for even the floor the folder takes all of it and
     * the date none.
     */
    fun metaWidths(available: Int, dateNatural: Int, folderNatural: Int, folderMin: Int): MetaWidths {
        val room = available.coerceAtLeast(0)
        if (dateNatural + folderNatural <= room) return MetaWidths(folder = folderNatural, date = dateNatural)
        val floor = minOf(folderNatural, folderMin.coerceAtLeast(0))
        if (room <= floor) return MetaWidths(folder = room, date = 0)
        val folder = (room - dateNatural).coerceIn(floor, folderNatural)
        return MetaWidths(folder = folder, date = (room - folder).coerceAtMost(dateNatural))
    }

    /**
     * A folder move that did not land. A 403 names the organization, and only
     * means something in an org's library ([scopeOrgId] non-null).
     */
    fun moveError(scopeOrgId: String?, forbidden: Boolean, orgName: String?): LibraryActionError =
        if (scopeOrgId != null && forbidden) {
            LibraryActionError.MoveForbidden(orgName.orEmpty())
        } else {
            LibraryActionError.MoveFailed
        }

    /** A share into [orgName] that did not happen. */
    fun shareError(forbidden: Boolean, orgName: String): LibraryActionError =
        if (forbidden) LibraryActionError.ShareForbidden(orgName) else LibraryActionError.ShareFailed

    /**
     * Whether the detail screen draws the player. An org recording's audio
     * cannot be fetched from there, so its bar is drawn only when the file is
     * already on this phone — the case where it can actually play.
     */
    fun showsPlaybackBar(orgId: String?, phase: PlaybackPhase): Boolean =
        orgId == null || phase == PlaybackPhase.READY || phase == PlaybackPhase.PREPARING

    /**
     * Whether a demo navigation request should open the detail screen's folder
     * picker: a move-to-folder request, not yet handled, over a loaded recording.
     */
    fun opensDemoPicker(request: DemoMode.Navigation, metaLoaded: Boolean, handledSerial: Long): Boolean =
        request.screen == DemoMode.Screen.MOVE_TO_FOLDER && metaLoaded && request.serial != handledSerial
}
