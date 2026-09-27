package com.pathors.parley.ui

import com.pathors.parley.cloud.CloudOrg
import com.pathors.parley.cloud.RecordingSummary
import com.pathors.parley.library.LibraryFolders
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
) {
    /** A delete, move or share is in flight: the row dims and stops responding. */
    val working: Boolean get() = deleting || busy

    val canShare: Boolean get() = shareTargets.isNotEmpty()
}

/** What a library row's tap and menu entries do. */
internal class RecordingRowActions(
    val onClick: () -> Unit,
    val onMoveToFolder: () -> Unit,
    val onShare: (CloudOrg) -> Unit,
    val onMoveToOrg: (CloudOrg) -> Unit,
    val onDelete: () -> Unit,
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
     * has share targets.
     */
    fun recordingRow(state: HomeViewModel.UiState, recording: RecordingSummary) = RecordingRowModel(
        recording = recording,
        folderName = LibraryFolders.folderName(recording, state.folders),
        deleting = recording.id in state.deleting,
        busy = recording.id in state.busy,
        canMoveToFolder = state.isPersonal || state.folders.isNotEmpty(),
        shareTargets = if (state.isPersonal) state.orgs else emptyList(),
    )

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
