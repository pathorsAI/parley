package com.pathors.parley.ui

import com.pathors.parley.cloud.CloudOrg
import com.pathors.parley.cloud.RecordingSummary
import com.pathors.parley.kit.SampleManifest
import com.pathors.parley.library.FolderFilter
import com.pathors.parley.library.LibraryFolders
import com.pathors.parley.playback.AudioDownloadState
import com.pathors.parley.playback.PlaybackPhase
import com.pathors.parley.screenshot.DemoMode
import java.util.Calendar
import java.util.TimeZone

/**
 * One library row as the screen draws it: the recording, where it is filed,
 * whether a request is in flight on it, and which menu entries it offers.
 */
internal data class RecordingRowModel(
    val recording: RecordingSummary,
    val folderName: String?,
    val deleting: Boolean,
    val busy: Boolean,
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

/**
 * Which of the desktop's empty states a list with nothing in it shows — iOS
 * `LibraryView.emptyState`, the desktop's `emptyStateCopy`. Each has its own
 * title and hint; only [NOTHING_YET] in the personal library carries the
 * import button.
 */
internal enum class EmptyLibraryState {
    /** A search found nothing. */
    NO_MATCH,

    /** A folder with nothing filed in it. */
    EMPTY_FOLDER,

    /** An organization nobody has shared a recording into. */
    EMPTY_ORG,

    /** The Unfiled page with everything filed. */
    ALL_FILED,

    /** A library with nothing in it at all. */
    NOTHING_YET,
}

/** What a library row's tap and menu entries do. */
internal class RecordingRowActions(
    val onClick: () -> Unit,
    val onMoveToFolder: () -> Unit,
    val onShare: (CloudOrg) -> Unit,
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
     * Every row can be moved: both libraries can create a folder to move into.
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
        shareTargets = if (state.isPersonal && !SampleManifest.isSample(recording.id)) {
            state.orgs
        } else {
            emptyList()
        },
        audio = audio,
        canDownload = state.isPersonal && !SampleManifest.isSample(recording.id),
    )

    /**
     * The empty state for a list that shows nothing, chosen in the desktop's
     * order: a search first (the words typed are why it is empty), then a
     * folder, then an organization's library, then the personal Unfiled page,
     * and only then "nothing yet".
     */
    fun emptyState(query: String, filter: FolderFilter, isPersonal: Boolean): EmptyLibraryState = when {
        query.isNotBlank() -> EmptyLibraryState.NO_MATCH
        filter is FolderFilter.Folder -> EmptyLibraryState.EMPTY_FOLDER
        !isPersonal -> EmptyLibraryState.EMPTY_ORG
        filter == FolderFilter.Unfiled -> EmptyLibraryState.ALL_FILED
        else -> EmptyLibraryState.NOTHING_YET
    }

    /**
     * How many recordings the overview's 最近錄音 shows before See all takes
     * over — the desktop's number. Four is a shortcut, not a browser.
     */
    const val RECENT_COUNT = 4

    /** The overview's recent rows: the scope's [RECENT_COUNT] newest. */
    fun recentRecordings(library: List<RecordingSummary>): List<RecordingSummary> =
        LibraryFolders.newestFirst(library).take(RECENT_COUNT)

    /**
     * Whether a row's date needs its year: only outside the year [nowMs] is
     * in, in [zone]. See `formatRowTimestamp`.
     */
    fun showsYear(epochMs: Long, nowMs: Long, zone: TimeZone = TimeZone.getDefault()): Boolean {
        fun yearOf(ms: Long) = Calendar.getInstance(zone).apply { timeInMillis = ms }.get(Calendar.YEAR)
        return yearOf(epochMs) != yearOf(nowMs)
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

    /**
     * A folder create, rename or delete that did not land. A 403 is the org's
     * rule (creator or admin only), everything else the same retryable failure.
     */
    fun folderError(forbidden: Boolean): LibraryActionError =
        if (forbidden) LibraryActionError.FolderForbidden else LibraryActionError.FolderFailed

    /**
     * The name a folder dialog's confirm sends: [draft] trimmed, or null when
     * there is nothing to send — a blank name, or the [current] name unchanged
     * (null [current] for a new folder).
     */
    fun folderNameToCommit(draft: String, current: String?): String? {
        val name = draft.trim()
        return if (name.isEmpty() || name == current) null else name
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
