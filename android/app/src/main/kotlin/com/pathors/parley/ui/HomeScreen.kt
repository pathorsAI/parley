package com.pathors.parley.ui

import androidx.activity.compose.BackHandler
import androidx.annotation.StringRes
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pathors.parley.R
import com.pathors.parley.cloud.CloudFolder
import com.pathors.parley.cloud.CloudOrg
import com.pathors.parley.cloud.OrgRole
import com.pathors.parley.cloud.RecordingSummary
import com.pathors.parley.library.FolderFilter
import com.pathors.parley.library.LibraryFolders
import com.pathors.parley.library.SaveDestination
import com.pathors.parley.meeting.MeetingService
import com.pathors.parley.meeting.isInProgress
import com.pathors.parley.kit.GettingStartedState
import com.pathors.parley.kit.SampleManifest
import com.pathors.parley.playback.AudioDownloadState
import com.pathors.parley.screenshot.DemoMode
import com.pathors.parley.ui.theme.ParleyTheme
import com.pathors.parley.upload.PendingUpload
import java.io.File
import kotlinx.coroutines.launch

/**
 * The library: everything this account has in the cloud, with whatever is still
 * queued on the device pinned above it, plus the two ways to add a recording.
 *
 * It opens on an overview, like the desktop's 總覽 and iOS's Library (#741):
 * the large title with import, the scope switcher and the account level with
 * it, the search field, then — over the desktop's light bars — what needs the
 * user (the upload queue, a failure), the getting-started list, the folders as
 * cards in one sideways row, and the four newest recordings. Everything else is
 * one tap away on the full list: See all opens it with its folder chips and
 * pager, unchanged; a folder card opens that folder alone. Both are pages of
 * this one screen rather than routes of their own, because they read and act
 * on the same view model state (the scope, the folders, the dialogs); the
 * system back gesture returns to the overview.
 *
 * Queued items sit at the top on purpose — they are the only rows that need the
 * user to do anything (stay on network), and they are the newest.
 *
 * The pull refreshes, on every page; the screen also reloads whenever it comes
 * back to the front.
 */
@Composable
fun HomeScreen(
    onRecord: () -> Unit,
    onImport: () -> Unit,
    onOpenRecording: (id: String, orgId: String?, guided: Boolean) -> Unit,
) {
    val container = rememberContainer()
    val viewModel: HomeViewModel = viewModel(factory = HomeViewModel.factory(container))
    val state by viewModel.state.collectAsState()
    val sample by viewModel.sample.collectAsState()
    val audio by viewModel.audio.collectAsState()
    val importNotice by viewModel.importNotice.collectAsState()
    var showAccount by remember { mutableStateOf(false) }
    val overviewState = rememberLazyListState()
    val coroutineScope = rememberCoroutineScope()

    // The recording the user has asked to delete, held until they confirm.
    var pendingDelete by remember { mutableStateOf<RecordingSummary?>(null) }

    // The recording the folder picker is moving, while it is up.
    var moving by remember { mutableStateOf<RecordingSummary?>(null) }

    // The folder name dialog (new folder or rename), while it is up, and the
    // folder the user has asked to delete, held until they confirm.
    var namingFolder by remember { mutableStateOf<FolderNaming?>(null) }
    var confirmingFolderDelete by remember { mutableStateOf<CloudFolder?>(null) }

    // Which page is up, and the search typed into it. See [LibraryPage].
    var pageKey by rememberSaveable { mutableStateOf(LibraryPage.Overview.key) }
    val page = LibraryPage.parse(pageKey)
    var query by rememberSaveable { mutableStateOf("") }

    // The personal library with the bundled sample merged in — see
    // `SampleRecordingStore`. Everything below reads this, not the cloud's list.
    val library = remember(state.recordings, sample, state.isPersonal) {
        HomeViewModel.withSample(state.recordings, sample, state.isPersonal)
    }
    val checklist = rememberChecklist(viewModel, state, sample, query) { id ->
        onOpenRecording(id, null, true)
    }

    // The walk-through's end: the sample, loaded, opens as the lap's recording.
    val openRecording = rememberUpdatedState(onOpenRecording)
    LaunchedEffect(viewModel) {
        viewModel.lapOpens.collect { id -> openRecording.value(id, null, true) }
    }

    val meetingLive = rememberMeetingLive()

    // Reload whenever this screen comes back to the front: a meeting or an
    // import that finished while it was off-stage has a new row waiting in the
    // cloud, and so does a recording the desktop synced while the phone was in
    // a pocket. The back-stack entry's lifecycle resumes on each of those, and
    // on first entry, so this replaces both a per-visit load and a refresh
    // button in the top bar. Pull to refresh stays for the impatient.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { viewModel.refresh() }

    // Opening a page leaves the last one's search behind, and the pager's
    // folder follows the page: All for See all, the folder for its card.
    fun openPage(target: LibraryPage) {
        query = ""
        viewModel.selectFolder(
            when (target) {
                is LibraryPage.Folder -> FolderFilter.Folder(target.id)
                else -> FolderFilter.All
            },
        )
        pageKey = target.key
    }
    BackHandler(enabled = page != LibraryPage.Overview) { openPage(LibraryPage.Overview) }
    // A folder page whose folder has gone (deleted here or elsewhere, or a
    // scope switch) has nothing left to show: back to the overview.
    LaunchedEffect(page, state.folders, state.loading) {
        if (page is LibraryPage.Folder && !state.loading && state.folders.none { it.id == page.id }) {
            openPage(LibraryPage.Overview)
        }
    }

    DemoLibraryRequest { target ->
        showAccount = target.screen == DemoMode.Screen.ACCOUNT
        if (showAccount) viewModel.loadAccount()
        viewModel.selectScope(if (target.library == DemoMode.LibraryPage.ORG) DemoMode.ORG_ID else null)
        // A lap route re-seeds the fixtures under a screen that may already be
        // up, so every demo request re-reads them.
        viewModel.refresh()
        openPage(
            when (target.library) {
                DemoMode.LibraryPage.ALL -> LibraryPage.All
                DemoMode.LibraryPage.FOLDER_EMPTY -> LibraryPage.Folder(DemoMode.EMPTY_FOLDER_ID)
                DemoMode.LibraryPage.OVERVIEW, DemoMode.LibraryPage.ORG -> LibraryPage.Overview
            },
        )
    }

    val callbacks = LibraryCallbacks(
        onRecord = onRecord,
        onImport = onImport,
        onUpload = { viewModel.uploadNow() },
        onRefresh = { viewModel.refresh() },
        onSelectFolder = viewModel::selectFolder,
        folderActions = FolderChipActions(
            onCreate = { namingFolder = FolderNaming.Create },
            onRename = { namingFolder = FolderNaming.Rename(it) },
            onDelete = { confirmingFolderDelete = it },
        ),
        syncPrompt = SyncPromptActions(
            onSend = viewModel::sendSyncDiagnostics,
            onDismiss = viewModel::dismissSyncPrompt,
            onRetry = viewModel::retryUpload,
            onDelete = viewModel::deletePending,
            audioOf = viewModel::pendingAudio,
        ),
        rowActions = { recording ->
            RecordingRowActions(
                onClick = {
                    val guided = LapRules.isLapRecording(recording.id, state.scopeOrgId, state.recordings)
                    onOpenRecording(recording.id, state.scopeOrgId, guided)
                },
                onMoveToFolder = {
                    moving = recording
                    viewModel.refreshDirectory()
                },
                onShare = { org -> viewModel.shareToOrg(recording, org, thenDelete = false) },
                // The sample goes without a question: nothing is lost, and the
                // checklist can load it again.
                onDelete = {
                    if (SampleManifest.isSample(recording.id)) {
                        viewModel.deleteRecording(recording.id)
                    } else {
                        pendingDelete = recording
                    }
                },
                onDownload = { viewModel.downloadAudio(recording) },
                onRemoveDownload = { viewModel.removeDownload(recording) },
            )
        },
        audioOf = audio::stateOf,
        importNotice = importNotice?.let { notice ->
            ImportNoticeText(
                title = notice.title,
                orgName = notice.sharedToOrgId?.let { id -> state.orgs.firstOrNull { it.id == id }?.name },
            )
        },
    )

    val language = LocalConfiguration.current.locales[0].language
    val walkingThrough by viewModel.walkingThrough.collectAsState()
    val searchHint = stringResource(R.string.home_search_hint)

    Box(
        Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        // The overview's light bars reach the top edge of the window, behind
        // the status bar, the title and the search field, as the desktop's run
        // from the top of its page (iOS's `ignoresSafeArea`): this screen is
        // the one destination the root leaves the status bar's inset to, and
        // the column below takes it. Only on the overview: the full list and
        // a search's results are plain pages.
        val showsBackdrop = page == LibraryPage.Overview && query.isBlank()
        val backdropAlpha by animateFloatAsState(if (showsBackdrop) 1f else 0f, tween(250), label = "backdrop")
        if (backdropAlpha > 0f) {
            OverviewBackdrop(Modifier.graphicsLayer { alpha = backdropAlpha })
        }
        Column(
            Modifier
                .fillMaxSize()
                .underStatusBarInset(),
        ) {
            when (page) {
                LibraryPage.Overview -> LibraryPageHeader(title = stringResource(R.string.home_title)) {
                    LibraryActions(
                        state = state,
                        onImport = onImport,
                        onSelectScope = { orgId ->
                            // A search belongs to the library it was typed into.
                            query = ""
                            viewModel.selectScope(orgId)
                        },
                        onAccount = {
                            showAccount = true
                            viewModel.loadAccount()
                        },
                    )
                }

                else -> FullListHeader(
                    title = when (page) {
                        is LibraryPage.Folder -> state.folders.firstOrNull { it.id == page.id }?.name.orEmpty()
                        else -> stringResource(R.string.library_all_recordings)
                    },
                    onBack = { openPage(LibraryPage.Overview) },
                )
            }
            PageSearchField(
                query = query,
                onQueryChange = { query = it },
                hint = searchHint,
                modifier = Modifier.padding(start = 20.dp, end = 20.dp, bottom = 8.dp),
            )
            val body = Modifier
                .fillMaxWidth()
                .weight(1f)
            when {
                // Searching from the overview searches the whole library, the
                // way the Library always has.
                page == LibraryPage.All || (page == LibraryPage.Overview && query.isNotBlank()) -> LibraryBody(
                    state = state,
                    library = library,
                    query = query,
                    meetingLive = meetingLive,
                    callbacks = callbacks,
                    modifier = body,
                )

                page is LibraryPage.Folder -> FolderBody(
                    folderId = page.id,
                    state = state,
                    library = library,
                    query = query,
                    meetingLive = meetingLive,
                    callbacks = callbacks,
                    modifier = body,
                )

                else -> LibraryOverviewBody(
                    state = state,
                    library = library,
                    meetingLive = meetingLive,
                    callbacks = callbacks,
                    checklist = checklist,
                    listState = overviewState,
                    recentEmpty = RecentEmpty(
                        // The checklist already offers the sample — don't say it twice.
                        offersSample = state.isPersonal && checklist == null && viewModel.canLoadSample(language),
                        transcribing = walkingThrough,
                        onUseSample = { viewModel.walkThroughSample(language) },
                    ),
                    onOpen = ::openPage,
                    modifier = body,
                )
            }
            HomeBottomBar(onRecord = onRecord)
        }
    }

    if (showAccount) {
        AccountSheet(
            viewModel = viewModel,
            onDismiss = { showAccount = false },
            onRerunOnboarding = {
                showAccount = false
                openPage(LibraryPage.Overview)
                // The wizard covers the library; when it is left with "Try the
                // sample", the checklist is at the top of the overview.
                viewModel.rerunOnboarding()
                coroutineScope.launch { overviewState.animateScrollToItem(0) }
            },
        )
    }

    moving?.let { target ->
        MoveToFolderSheet(viewModel, state, target, onDismiss = { moving = null })
    }

    pendingDelete?.let { target ->
        DeleteRecordingDialog(
            title = target.title.ifEmpty { stringResource(R.string.recording_untitled) },
            orgName = state.scopeOrg?.name,
            onConfirm = {
                pendingDelete = null
                viewModel.deleteRecording(target.id)
            },
            onDismiss = { pendingDelete = null },
        )
    }

    namingFolder?.let { naming ->
        FolderNameDialog(
            naming = naming,
            onConfirm = { name ->
                namingFolder = null
                when (naming) {
                    FolderNaming.Create -> viewModel.createFolderFromRow(name)
                    is FolderNaming.Rename -> viewModel.renameFolder(naming.folder, name)
                }
            },
            onDismiss = { namingFolder = null },
        )
    }

    confirmingFolderDelete?.let { folder ->
        DeleteFolderDialog(
            folder = folder,
            recordingCount = HomeViewModel.folderRecordingCount(library, folder.id),
            onConfirm = {
                confirmingFolderDelete = null
                viewModel.deleteFolder(folder)
            },
            onDismiss = { confirmingFolderDelete = null },
        )
    }

    LibraryErrorDialogs(viewModel, state)
}

/**
 * Which page of the Library is up: the overview it opens on, or the full list
 * pushed over it — everything (See all), or one folder (its card). [key] is
 * what `rememberSaveable` keeps, so the page survives a rotation.
 */
private sealed interface LibraryPage {
    val key: String

    data object Overview : LibraryPage {
        override val key = "overview"
    }

    data object All : LibraryPage {
        override val key = "all"
    }

    data class Folder(val id: String) : LibraryPage {
        override val key = FOLDER_PREFIX + id
    }

    companion object {
        private const val FOLDER_PREFIX = "folder:"

        fun parse(key: String): LibraryPage = when {
            key == All.key -> All
            key.startsWith(FOLDER_PREFIX) -> Folder(key.removePrefix(FOLDER_PREFIX))
            else -> Overview
        }
    }
}

/**
 * Lets a full-width row (the folder cards) run to both edges of the screen
 * from inside a list padded by [inset] on each side.
 */
private fun Modifier.edgeToEdge(inset: Dp): Modifier = layout { measurable, constraints ->
    val extra = (inset * 2).roundToPx()
    val width = constraints.maxWidth + extra
    val placeable = measurable.measure(constraints.copy(minWidth = width, maxWidth = width))
    layout(constraints.maxWidth, placeable.height) { placeable.place(-extra / 2, 0) }
}

/**
 * What the library's banners, chips and rows call back into — and the two
 * facts from outside the library state they draw: where each recording's audio
 * is, and the import that just landed.
 */
private class LibraryCallbacks(
    val onRecord: () -> Unit,
    val onImport: () -> Unit,
    val onUpload: () -> Unit,
    val onRefresh: () -> Unit,
    val onSelectFolder: (FolderFilter) -> Unit,
    /** The folders' long-press Rename / Delete and the "+" / New folder. */
    val folderActions: FolderChipActions = FolderChipActions(),
    /** The "keeps failing to sync" prompt under a queued row: send, or ×. */
    val syncPrompt: SyncPromptActions = SyncPromptActions(),
    val rowActions: (RecordingSummary) -> RecordingRowActions,
    val audioOf: (String) -> AudioDownloadState = { AudioDownloadState.Absent },
    val importNotice: ImportNoticeText? = null,
)

/** What the sync status under a queued recording does: the prompt's send and ×, and retry. */
private class SyncPromptActions(
    val onSend: (PendingUpload) -> Unit = {},
    val onDismiss: (String) -> Unit = {},
    /** Retry one recording the cloud refused (it is parked, not gone). */
    val onRetry: (String) -> Unit = {},
    /** Delete a never-uploaded recording from the phone, after confirmation. */
    val onDelete: (String) -> Unit = {},
    /** Its queued Ogg, for the share sheet. */
    val audioOf: (String) -> File? = { null },
)

/** The import notice's parts; [orgName] null is the personal-only wording. */
private class ImportNoticeText(val title: String, val orgName: String?)

/**
 * The getting-started checklist on the overview, when it shows: the personal
 * library, no search, and then the checklist's own rule
 * ([GettingStartedState.showsInLibrary], unit-tested in parleykit).
 */
private class ChecklistModel(val state: GettingStartedState, val header: ChecklistHeader)

/** 最近錄音 with nothing in it: whether it offers the sample, and the walk-through's state. */
private class RecentEmpty(val offersSample: Boolean, val transcribing: Boolean, val onUseSample: () -> Unit)

@Composable
private fun rememberChecklist(
    viewModel: HomeViewModel,
    state: HomeViewModel.UiState,
    sample: RecordingSummary?,
    query: String,
    onContinue: (id: String) -> Unit,
): ChecklistModel? {
    val checklist by viewModel.gettingStarted.collectAsState()
    val existingUserChecked by viewModel.existingUserChecked.collectAsState()
    val walkingThrough by viewModel.walkingThrough.collectAsState()
    val language = LocalConfiguration.current.locales[0].language
    val current = checklist ?: return null
    if (!state.isPersonal || query.isNotBlank()) return null
    val shows = current.showsInLibrary(
        libraryLoaded = state.personalLoaded,
        existingUserChecked = existingUserChecked,
        libraryIsEmpty = state.recordings.isEmpty() && sample == null,
    )
    if (!shows) return null
    val lap = LapRules.lapRecording(state.recordings, sample)
    return ChecklistModel(
        state = current,
        header = ChecklistHeader(
            action = LapRules.checklistAction(current, lap, viewModel.canLoadSample(language)),
            transcribing = walkingThrough,
            onWalkThrough = { viewModel.walkThroughSample(language) },
            onContinue = { lap?.let { onContinue(it.id) } },
            onDismiss = viewModel::dismissChecklist,
        ),
    )
}

/** A meeting that is still running (the user navigated home without stopping). */
@Composable
private fun rememberMeetingLive(): Boolean {
    val session by MeetingService.activeSession.collectAsState()
    val meetingState = session?.state?.collectAsState()?.value
    return meetingState?.isInProgress == true
}

/**
 * `parley://demo/…` lands on the library: the account sheet open for the
 * account route, the organization's library for `library-org`, the full list
 * for `library-all`, an empty folder's page for `library-folder-empty`, and the
 * personal overview for everything else. [onRequest] is told about each new
 * request.
 */
@Composable
private fun DemoLibraryRequest(onRequest: (DemoMode.Navigation) -> Unit) {
    val demoNavigation by DemoMode.navigation.collectAsState()
    val latest by rememberUpdatedState(onRequest)
    LaunchedEffect(demoNavigation) {
        val target = demoNavigation ?: return@LaunchedEffect
        latest(target)
    }
}

/**
 * The Library's actions, level with its title: import (personal only), the
 * switch between the personal library and each organization's, and the
 * account. Import is a glyph — `UploadDoc`, the same one a row uses for a
 * recording that came in this way, so the button and what it makes look alike.
 *
 * Personal scope only, as on iOS: an import files into the personal library
 * first and shares from there (the default save location decides that), so
 * offering it under an org's name would promise a destination the flow does not
 * have.
 */
@Composable
private fun LibraryActions(
    state: HomeViewModel.UiState,
    onImport: () -> Unit,
    onSelectScope: (String?) -> Unit,
    onAccount: () -> Unit,
) {
    HeaderActions {
        if (state.isPersonal) {
            IconButton(onClick = onImport) {
                Icon(
                    imageVector = LibraryIcons.UploadDoc,
                    contentDescription = stringResource(R.string.library_import_audio),
                    modifier = Modifier.size(22.dp),
                )
            }
        }
        ScopeSwitcher(state = state, onSelectScope = onSelectScope, onAccount = onAccount)
    }
}

/**
 * The full list's top: back to the overview, and what this page is — 全部錄音,
 * or the folder's name. A plain Android app bar row: this page is pushed over
 * the overview, so it reads as one level down rather than as a tab root.
 */
@Composable
private fun FullListHeader(title: String, onBack: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .height(64.dp)
            .padding(start = 4.dp, end = 16.dp),
    ) {
        IconButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.action_back))
        }
        Spacer(Modifier.width(4.dp))
        Text(
            text = title,
            style = MaterialTheme.typography.titleLarge,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * Record, along the bottom. Import has moved up beside the title (iOS's
 * header), so recording — the thing this app is for — has the bar to itself.
 */
@Composable
private fun HomeBottomBar(onRecord: () -> Unit) {
    Button(
        onClick = onRecord,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 12.dp)
            .height(56.dp),
    ) {
        Text(
            text = stringResource(R.string.home_record),
            style = MaterialTheme.typography.titleMedium,
        )
    }
}

/**
 * What the Library opens on — the desktop's 總覽, iOS's overview: what needs
 * the user (an import landing, a meeting still running, a failure, the upload
 * queue), the getting-started list, the folders as cards in one sideways row,
 * and the four newest recordings. Everything follows the scope switcher.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LibraryOverviewBody(
    state: HomeViewModel.UiState,
    library: List<RecordingSummary>,
    meetingLive: Boolean,
    callbacks: LibraryCallbacks,
    checklist: ChecklistModel?,
    listState: LazyListState,
    recentEmpty: RecentEmpty,
    onOpen: (LibraryPage) -> Unit,
    modifier: Modifier = Modifier,
) {
    val recent = remember(library) { LibraryRules.recentRecordings(library) }
    PullToRefreshBox(
        isRefreshing = state.loading,
        onRefresh = callbacks.onRefresh,
        state = rememberPullToRefreshState(),
        modifier = modifier,
    ) {
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(start = OverviewInset, end = OverviewInset, top = 8.dp, bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            libraryHeader(
                meetingLive = meetingLive,
                state = state,
                searching = false,
                importNotice = callbacks.importNotice,
                onRecord = callbacks.onRecord,
                onUpload = callbacks.onUpload,
                syncPrompt = callbacks.syncPrompt,
            )
            checklist?.let {
                item(key = "getting-started") {
                    GettingStartedList(state = it.state, header = it.header, modifier = Modifier.padding(bottom = 8.dp))
                }
            }
            item(key = "folders") {
                OverviewFolders(state = state, library = library, actions = callbacks.folderActions, onOpen = onOpen)
            }
            item(key = "recent-heading") {
                OverviewHeading(
                    title = stringResource(R.string.library_overview_recent),
                    modifier = Modifier.padding(top = 16.dp),
                ) {
                    if (recent.isNotEmpty()) {
                        OverviewLink(stringResource(R.string.library_overview_see_all), leading = false) {
                            onOpen(LibraryPage.All)
                        }
                    }
                }
            }
            when {
                recent.isNotEmpty() -> itemsIndexed(recent, key = { _, rec -> "recent-" + rec.id }) { index, recording ->
                    Column {
                        if (index > 0) {
                            HorizontalDivider(thickness = 0.5.dp, color = MaterialTheme.colorScheme.outlineVariant)
                        }
                        RecordingRow(
                            model = LibraryRules.recordingRow(state, recording, callbacks.audioOf(recording.id)),
                            actions = callbacks.rowActions(recording),
                            compact = true,
                        )
                    }
                }

                state.loading -> item(key = "recent-loading") { LoadingRow() }
                else -> item(key = "recent-empty") {
                    RecentEmptyBox(
                        offersSample = recentEmpty.offersSample,
                        transcribing = recentEmpty.transcribing,
                        onUseSample = recentEmpty.onUseSample,
                    )
                }
            }
        }
    }
}

/** The overview's side margin, iOS's 20pt. */
private val OverviewInset = 20.dp

/**
 * 資料夾: the heading with + 新增資料夾 beside it (a folder is made from the
 * heading, not from a card in the row: the row is for the folders there are),
 * then a card per folder in the scope, in one row that scrolls sideways and
 * runs to both edges of the screen.
 */
@Composable
private fun OverviewFolders(
    state: HomeViewModel.UiState,
    library: List<RecordingSummary>,
    actions: FolderChipActions,
    onOpen: (LibraryPage) -> Unit,
) {
    Column(Modifier.padding(top = 8.dp)) {
        OverviewHeading(title = stringResource(R.string.library_overview_folders)) {
            OverviewLink(stringResource(R.string.library_folder_add), leading = true, onClick = actions.onCreate)
        }
        if (state.folders.isNotEmpty()) {
            LazyRow(
                contentPadding = PaddingValues(horizontal = OverviewInset, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(16.dp),
                modifier = Modifier.edgeToEdge(OverviewInset),
            ) {
                items(state.folders, key = { "folder-card-" + it.id }) { folder ->
                    FolderCard(
                        name = folder.name,
                        count = HomeViewModel.folderRecordingCount(library, folder.id),
                        onOpen = { onOpen(LibraryPage.Folder(folder.id)) },
                        onRename = { actions.onRename(folder) },
                        onDelete = { actions.onDelete(folder) },
                    )
                }
            }
        }
    }
}

/**
 * The full list from See all (or a search from the overview): the folder chips
 * and, under them, one pull-to-refresh pager with a page per chip: the finger
 * drags the pages, a fling carries them, and the pager snaps. The pager and
 * `state.folderFilter` are kept in step both ways, each effect bailing when the
 * other already agrees, so a chip tap moves the pager and a settled swipe moves
 * the chip without either echoing back.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LibraryBody(
    state: HomeViewModel.UiState,
    library: List<RecordingSummary>,
    query: String,
    meetingLive: Boolean,
    callbacks: LibraryCallbacks,
    modifier: Modifier = Modifier,
) {
    val pages = remember(state.folders) { LibraryFolders.pages(state.folders) }
    val pagerState = rememberPagerState(
        initialPage = pages.indexOf(state.folderFilter).coerceAtLeast(0),
    ) { pages.size }
    LaunchedEffect(state.folderFilter, pages) {
        val index = pages.indexOf(state.folderFilter)
        if (index < 0 || index == pagerState.targetPage) return@LaunchedEffect
        pagerState.animateScrollToPage(index)
    }
    val latestFilter by rememberUpdatedState(state.folderFilter)
    LaunchedEffect(pagerState.settledPage) {
        pages.getOrNull(pagerState.settledPage)?.let { if (it != latestFilter) callbacks.onSelectFolder(it) }
    }
    Column(modifier) {
        // The row is up whenever there is a folder, or once a load has
        // finished without one: with no folders it is only the "+", which is
        // the one place an org library can make its first folder. It waits
        // out the first load so the lone "+" does not flash up ahead of the
        // chips it belongs after (iOS `LibraryView.list`).
        if (state.folders.isNotEmpty() || !state.loading) {
            FolderChips(
                folders = state.folders,
                selected = state.folderFilter,
                onSelect = callbacks.onSelectFolder,
                actions = callbacks.folderActions,
            )
        }
        PullToRefreshBox(
            isRefreshing = state.loading,
            onRefresh = callbacks.onRefresh,
            state = rememberPullToRefreshState(),
            modifier = Modifier.fillMaxSize(),
        ) {
            HorizontalPager(
                state = pagerState,
                beyondViewportPageCount = 1,
                key = { pageKey(pages[it]) },
                modifier = Modifier.fillMaxSize(),
            ) { page ->
                val filter = pages[page]
                val visible = remember(library, state.folders, page, query) {
                    HomeViewModel.visibleRecordings(library, state.folders, filter, query)
                }
                LibraryList(
                    state = state,
                    visible = visible,
                    filter = filter,
                    query = query,
                    meetingLive = meetingLive,
                    callbacks = callbacks,
                    listState = rememberLazyListState(),
                )
            }
        }
    }
}

/**
 * One folder, opened from its card: its recordings and nothing else — no chip
 * row and no swipe to the next folder, the folders were already chosen between
 * on the overview (iOS #741).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FolderBody(
    folderId: String,
    state: HomeViewModel.UiState,
    library: List<RecordingSummary>,
    query: String,
    meetingLive: Boolean,
    callbacks: LibraryCallbacks,
    modifier: Modifier = Modifier,
) {
    val filter = FolderFilter.Folder(folderId)
    val visible = remember(library, state.folders, folderId, query) {
        HomeViewModel.visibleRecordings(library, state.folders, filter, query)
    }
    PullToRefreshBox(
        isRefreshing = state.loading,
        onRefresh = callbacks.onRefresh,
        state = rememberPullToRefreshState(),
        modifier = modifier,
    ) {
        LibraryList(
            state = state,
            visible = visible,
            filter = filter,
            query = query,
            meetingLive = meetingLive,
            callbacks = callbacks,
            listState = rememberLazyListState(),
        )
    }
}

/** One stable key per library page, shared by the chip row and the pager. */
private fun pageKey(page: FolderFilter): String = when (page) {
    FolderFilter.All -> "all"
    FolderFilter.Unfiled -> "unfiled"
    is FolderFilter.Folder -> "folder-" + page.id
}

@Composable
private fun LibraryList(
    state: HomeViewModel.UiState,
    visible: List<RecordingSummary>,
    filter: FolderFilter,
    query: String,
    meetingLive: Boolean,
    callbacks: LibraryCallbacks,
    listState: LazyListState,
) {
    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(
            start = 16.dp,
            end = 16.dp,
            top = 8.dp,
            bottom = 16.dp,
        ),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        libraryHeader(
            meetingLive = meetingLive,
            state = state,
            searching = query.isNotBlank(),
            importNotice = callbacks.importNotice,
            onRecord = callbacks.onRecord,
            onUpload = callbacks.onUpload,
            syncPrompt = callbacks.syncPrompt,
        )
        libraryPlaceholders(
            state = state,
            visible = visible,
            filter = filter,
            query = query,
            onImport = callbacks.onImport,
        )
        // Namespaced keys: a recording drained from the pending
        // queue can show up in both lists for one refresh, and two
        // items sharing a key is an IllegalArgumentException out of
        // LazyColumn, not a glitch.
        items(visible, key = { "recording-" + it.id }) { recording ->
            RecordingRow(
                model = LibraryRules.recordingRow(state, recording, callbacks.audioOf(recording.id)),
                actions = callbacks.rowActions(recording),
                modifier = Modifier.padding(vertical = RowGapPadding),
            )
        }
    }
}

/**
 * The whitespace between two recordings — iOS `RecordingRow.spacing`, 28pt —
 * made of the list's 8dp item spacing and this much above and below each row.
 * Whitespace is the only separator on the full list: no card, no fill, no
 * hairline. (The overview's four recent rows are hairline-split, as iOS's are.)
 */
private val RowGapPadding = 10.dp

/**
 * "Move to…" over the library, moving [target]: this library's folders, and
 * from the personal library every organization's too.
 */
@Composable
private fun MoveToFolderSheet(
    viewModel: HomeViewModel,
    state: HomeViewModel.UiState,
    target: RecordingSummary,
    onDismiss: () -> Unit,
) {
    val account by viewModel.account.collectAsState()
    FolderPickerSheet(
        scopes = HomeViewModel.moveScopes(state, account.directory, target),
        // The orphan rule the list renders by, so "Current folder" agrees
        // with the page the row was on.
        current = SaveDestination(
            orgId = state.scopeOrgId,
            folderId = LibraryFolders.liveFolderId(target.folderId, state.folders),
        ),
        callbacks = FolderPickerCallbacks(
            onConfirm = { destination -> viewModel.moveTo(target, destination) },
            // The sample is filed on this phone; a folder made for it would be
            // a cloud folder nothing else is in.
            onCreate = if (SampleManifest.isSample(target.id)) null else viewModel::createFolder,
            onDismiss = onDismiss,
        ),
    )
}

/** A failed delete, move or share, each answered where the user is looking. */
@Composable
private fun LibraryErrorDialogs(viewModel: HomeViewModel, state: HomeViewModel.UiState) {
    state.deleteError?.let { error ->
        DeleteRecordingErrorDialog(
            error = error,
            onDismiss = { viewModel.clearDeleteRecordingError() },
        )
    }

    state.actionError?.let { error ->
        LibraryActionErrorDialog(
            error = error,
            onDismiss = { viewModel.clearActionError() },
        )
    }
}

/**
 * The switch between the personal library and each organization's — iOS's
 * scope menu, in the header's pill: the scope's glyph (a folder for personal,
 * two people for an organization), its name, and the menu under it.
 *
 * An account in no organization has nothing to switch between, so it gets no
 * switcher at all: a menu with one entry is a control that does nothing.
 */
@Composable
private fun ScopeSwitcher(
    state: HomeViewModel.UiState,
    onSelectScope: (String?) -> Unit,
    onAccount: () -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    val personal = stringResource(R.string.library_scope_personal)
    val name = state.scopeOrg?.name ?: personal
    val chooseLabel = stringResource(R.string.library_scope_choose)
    Box {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .heightIn(min = 48.dp)
                .clickable(onClickLabel = chooseLabel, role = Role.Button) { open = true }
                .padding(start = 8.dp, end = 2.dp),
        ) {
            Icon(
                // One person for the personal library, people for an organization's.
                imageVector = if (state.isPersonal) Icons.Default.Person else LibraryIcons.Group,
                contentDescription = null,
                modifier = Modifier.size(20.dp),
            )
            Spacer(Modifier.width(6.dp))
            Text(
                text = name,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(max = 112.dp),
            )
            Icon(Icons.Default.ArrowDropDown, contentDescription = chooseLabel)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            ScopeMenuItem(
                title = personal,
                role = null,
                icon = Icons.Default.Person,
                selected = state.isPersonal,
                onClick = {
                    open = false
                    onSelectScope(null)
                },
            )
            state.orgs.forEach { org ->
                ScopeMenuItem(
                    title = org.name,
                    role = stringResource(orgRoleLabel(org.role)),
                    icon = LibraryIcons.Group,
                    selected = state.scopeOrgId == org.id,
                    onClick = {
                        open = false
                        onSelectScope(org.id)
                    },
                )
            }
            // The account sheet (sign-out, where recordings are saved, re-run
            // onboarding) lives here, under the libraries, rather than as a
            // third glyph in the header: the header keeps iOS's two actions,
            // import and the scope. Which is also why the menu is shown with
            // no organization to switch to.
            HorizontalDivider(Modifier.padding(vertical = 4.dp))
            DropdownMenuItem(
                text = { Text(stringResource(R.string.home_account_settings)) },
                leadingIcon = { Icon(Icons.Default.Settings, contentDescription = null) },
                onClick = {
                    open = false
                    onAccount()
                },
            )
        }
    }
}

@Composable
private fun ScopeMenuItem(
    title: String,
    role: String?,
    icon: ImageVector,
    selected: Boolean,
    onClick: () -> Unit,
) {
    DropdownMenuItem(
        text = {
            Column {
                Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (role != null) {
                    Text(
                        text = role,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        },
        leadingIcon = { Icon(icon, contentDescription = null, modifier = Modifier.size(20.dp)) },
        trailingIcon = {
            if (selected) {
                Icon(
                    Icons.Default.Check,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                )
            }
        },
        onClick = onClick,
        modifier = Modifier.semantics { this.selected = selected },
    )
}

/** Owner / Admin / Member; anything else reads as member, as on iOS. */
@StringRes
internal fun orgRoleLabel(role: String?): Int = when (role) {
    OrgRole.OWNER -> R.string.org_role_owner
    OrgRole.ADMIN -> R.string.org_role_admin
    else -> R.string.org_role_member
}

/**
 * All, Unfiled, then the scope's folders in the server's order — one page of
 * the library's pager each ([LibraryFolders.pages]), horizontally scrollable
 * because a folder is a customer and there are dozens.
 *
 * iOS's underlined labels rather than Material filter chips. A filled chip was
 * a fill behind content, and it made the folder row the loudest thing above the
 * list; an underline says "this one" with the same signal blue and no area at
 * all (see `docs/design/ios-visual-language.md`). Each chip is still a
 * selectable tab to TalkBack. The row scrolls itself so the selected chip is on
 * screen, which matters when the selection changes from somewhere other than a
 * tap on it (a swipe of the pager, or a scope switch resetting to All).
 */
@Composable
private fun FolderChips(
    folders: List<CloudFolder>,
    selected: FolderFilter,
    onSelect: (FolderFilter) -> Unit,
    actions: FolderChipActions,
) {
    val listState = rememberLazyListState()
    // With no folders, All and Unfiled are the same list, so the row is only
    // the "+".
    val pages = remember(folders) { if (folders.isEmpty()) emptyList() else LibraryFolders.pages(folders) }
    // Only when the chip is not already fully on screen: scrolling a visible
    // chip to the leading edge would clip "All" for no reason.
    LaunchedEffect(selected, pages) {
        val index = pages.indexOf(selected)
        if (index < 0) return@LaunchedEffect
        val layout = listState.layoutInfo
        val item = layout.visibleItemsInfo.firstOrNull { it.index == index }
        val fullyVisible = item != null && item.offset >= layout.viewportStartOffset &&
            item.offset + item.size <= layout.viewportEndOffset
        if (!fullyVisible) listState.animateScrollToItem(index)
    }
    val all = stringResource(R.string.library_folder_all)
    val unfiled = stringResource(R.string.library_folder_unfiled)
    LazyRow(
        state = listState,
        contentPadding = PaddingValues(horizontal = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        items(pages, key = ::pageKey) { page ->
            val label = when (page) {
                FolderFilter.All -> all
                FolderFilter.Unfiled -> unfiled
                is FolderFilter.Folder -> folders.firstOrNull { it.id == page.id }?.name.orEmpty()
            }
            // Long-press, the platform's door to "more about this one", so the
            // row itself stays chips and nothing else. Real folders only: All
            // and Unfiled are views of the library, not things anyone made.
            val folder = (page as? FolderFilter.Folder)?.let { f -> folders.firstOrNull { it.id == f.id } }
            FolderChip(
                label = label,
                selected = page == selected,
                onClick = { onSelect(page) },
                menu = folder?.let {
                    FolderChipMenu(onRename = { actions.onRename(it) }, onDelete = { actions.onDelete(it) })
                },
            )
        }
        item(key = "new-folder") { NewFolderButton(onClick = actions.onCreate) }
    }
}

/** A real folder's long-press menu. */
private class FolderChipMenu(val onRename: () -> Unit, val onDelete: () -> Unit)

/**
 * The trailing "+": a new folder in whatever library is showing.
 *
 * Drawn like an unselected chip — the quiet colour, a glyph over the same
 * transparent 1dp rule — so it reads as the end of the row rather than a
 * button laid on top of it, and the row keeps its height. The touch target is
 * the 48dp minimum around the small glyph. After the last folder, so an
 * overflowing row scrolls to reach it, and not one of the pager's pages.
 */
@Composable
private fun NewFolderButton(onClick: () -> Unit) {
    val label = stringResource(R.string.library_folder_new)
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier
            .widthIn(min = 48.dp)
            .clickable(onClickLabel = label, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = label }
            .padding(horizontal = 4.dp, vertical = 8.dp),
    ) {
        Icon(
            Icons.Default.Add,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(16.dp),
        )
        Spacer(Modifier.height(5.dp))
        Spacer(Modifier.height(1.dp))
    }
}

/**
 * One folder: a label over a 1dp rule, blue and semibold when selected, the
 * rule transparent otherwise — always laid out, so a chip does not change
 * height on tap. The colour change runs 0.2 s, iOS's `easeInOut(0.2)`, so the
 * underline and the blue carry across to the new chip instead of snapping.
 *
 * A real folder's chip also carries [menu]: a long-press opens Rename and
 * Delete under it (iOS's context menu). All and Unfiled get none.
 */
@Composable
private fun FolderChip(label: String, selected: Boolean, onClick: () -> Unit, menu: FolderChipMenu? = null) {
    val signal = MaterialTheme.colorScheme.primary
    val quiet = MaterialTheme.colorScheme.onSurfaceVariant
    val textColor by animateColorAsState(
        targetValue = if (selected) signal else quiet,
        animationSpec = tween(durationMillis = ChipAnimationMs),
        label = "chip-text",
    )
    val ruleColor by animateColorAsState(
        targetValue = if (selected) signal else Color.Transparent,
        animationSpec = tween(durationMillis = ChipAnimationMs),
        label = "chip-rule",
    )
    var menuOpen by remember { mutableStateOf(false) }
    val actionsLabel = stringResource(R.string.library_folder_actions)
    Box {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier
                .widthIn(max = 220.dp)
                .semantics { this.selected = selected }
                .combinedClickable(
                    role = Role.Tab,
                    onClick = onClick,
                    onLongClickLabel = menu?.let { actionsLabel },
                    onLongClick = menu?.let { { menuOpen = true } },
                )
                .padding(horizontal = 4.dp, vertical = 8.dp)
                // The rule is as wide as the label, not as the 220dp cap.
                .width(IntrinsicSize.Max),
        ) {
            Text(
                text = label,
                style = MaterialTheme.typography.bodySmall,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                color = textColor,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(5.dp))
            Canvas(
                Modifier
                    .fillMaxWidth()
                    .height(1.dp),
            ) { drawRect(ruleColor) }
        }
        if (menu != null) {
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.library_folder_rename)) },
                    leadingIcon = { Icon(Icons.Default.Edit, contentDescription = null) },
                    onClick = {
                        menuOpen = false
                        menu.onRename()
                    },
                )
                DropdownMenuItem(
                    text = {
                        Text(stringResource(R.string.library_folder_delete), color = MaterialTheme.colorScheme.error)
                    },
                    leadingIcon = {
                        Icon(Icons.Default.Delete, contentDescription = null, tint = MaterialTheme.colorScheme.error)
                    },
                    onClick = {
                        menuOpen = false
                        menu.onDelete()
                    },
                )
            }
        }
    }
}

private const val ChipAnimationMs = 200

/**
 * The second press before a recording goes away for good.
 *
 * Named in the question, not just "this recording": the list can be long, the
 * menu was opened from a row that may have scrolled, and the whole cost of
 * getting it wrong is an audio file nobody can get back.
 */
@Composable
private fun DeleteRecordingDialog(
    title: String,
    /** The organization whose library the row is in, or null for personal. */
    orgName: String?,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.home_delete_confirm_title)) },
        text = {
            Text(
                // An org delete takes the recording away from everybody in the
                // team, and the dialog says whose library it is leaving.
                text = if (orgName != null) {
                    stringResource(R.string.home_delete_confirm_body_org, title, orgName)
                } else {
                    stringResource(R.string.home_delete_confirm_body, title)
                },
                // An `AlertDialog` clips its text slot instead of scrolling it,
                // and this paragraph grows with both the font scale and the
                // recording's own title.
                modifier = Modifier.verticalScroll(rememberScrollState()),
            )
        },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(
                    text = stringResource(R.string.home_delete_confirm_action),
                    color = MaterialTheme.colorScheme.error,
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) }
        },
    )
}

/**
 * A failed deletion gets a dialog rather than the list's error banner: the user
 * just confirmed a destructive action and the row is still sitting there, so
 * "did that work?" has to be answered where they are looking.
 */
@Composable
private fun DeleteRecordingErrorDialog(error: DeleteRecordingError, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.home_delete_error_title)) },
        text = {
            Text(
                text = when (error) {
                    DeleteRecordingError.FORBIDDEN ->
                        stringResource(R.string.home_delete_error_forbidden)

                    DeleteRecordingError.FORBIDDEN_IN_ORG ->
                        stringResource(R.string.home_delete_error_forbidden_org)

                    DeleteRecordingError.FAILED ->
                        stringResource(R.string.home_delete_error_failed)
                },
                modifier = Modifier.verticalScroll(rememberScrollState()),
            )
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_close)) }
        },
    )
}

/**
 * A move or a share that did not go through. A dialog for the same reason a
 * failed delete gets one: the user just asked for something and the row is
 * still where it was, so "did that work?" is answered where they are looking.
 */
@Composable
private fun LibraryActionErrorDialog(error: LibraryActionError, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.library_action_error_title)) },
        text = {
            Text(
                text = when (error) {
                    LibraryActionError.MoveFailed -> stringResource(R.string.library_move_failed)
                    is LibraryActionError.MoveForbidden ->
                        stringResource(R.string.library_move_forbidden, error.orgName)

                    is LibraryActionError.ShareForbidden ->
                        stringResource(R.string.library_share_forbidden, error.orgName)

                    LibraryActionError.ShareFailed -> stringResource(R.string.library_share_failed)
                    is LibraryActionError.OriginalKept ->
                        stringResource(R.string.library_share_original_kept, error.orgName)

                    LibraryActionError.FolderForbidden -> stringResource(R.string.library_folder_forbidden)
                    LibraryActionError.FolderFailed -> stringResource(R.string.library_folder_failed)
                },
                modifier = Modifier.verticalScroll(rememberScrollState()),
            )
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_close)) }
        },
    )
}

/**
 * The rows pinned above the cloud library: a meeting that is still running, the
 * last refresh error, and whatever is still queued on the device.
 *
 * The running meeting and the upload queue stand down while a search is live.
 * Neither is a search result — the queue has not reached the cloud and so was
 * never searched at all — and leaving them above a "No matches." line would have
 * the screen contradicting itself. The error banner stays: an unreachable cloud
 * is exactly why a search might come back empty, and that is worth reading.
 */
private fun LazyListScope.libraryHeader(
    meetingLive: Boolean,
    state: HomeViewModel.UiState,
    searching: Boolean,
    importNotice: ImportNoticeText?,
    onRecord: () -> Unit,
    onUpload: () -> Unit,
    syncPrompt: SyncPromptActions,
) {
    // First, as on iOS, where it sits above the error row and the list: the
    // answer to "did my import work" belongs where the eye lands on return.
    importNotice?.let { notice ->
        item(key = "import-notice") { ImportNoticeLine(notice) }
    }
    if (meetingLive && !searching) {
        item {
            ActiveMeetingCard(onClick = onRecord)
        }
    }
    state.error?.let { error ->
        item { ErrorBanner(error) }
    }
    // The queue is uploads to the *personal* library, so it is shown there and
    // not over an organization's rows it will never appear among.
    if (state.pending.isNotEmpty() && !searching && state.isPersonal) {
        item {
            PendingHeader(
                count = state.pending.size,
                uploading = state.uploading,
                onUpload = onUpload,
            )
        }
        items(state.pending, key = { "pending-" + it.id }) { pending ->
            Column {
                PendingRow(
                    pending = pending,
                    uploading = state.uploading,
                    actions = syncPrompt,
                )
                // Under the row it is about: this is where sync status is
                // read, and a recording that will not go up is sync status.
                if (pending.id in state.syncPrompts) {
                    DiagnosticsPrompt(
                        text = stringResource(R.string.feedback_sync_failed),
                        onSend = { syncPrompt.onSend(pending) },
                        onDismiss = { syncPrompt.onDismiss(pending.id) },
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
            }
        }
    }
}

/**
 * What stands in for a list while it is loading, and when it has nothing to
 * show: the desktop's empty state for why ([LibraryRules.emptyState]) — a
 * search that found nothing, an empty folder, an organization with nothing
 * shared, the unfiled page with everything filed, or a library with nothing in
 * it yet. Only the last carries a button, because the way out of each is
 * different: importing something, not editing the query.
 */
private fun LazyListScope.libraryPlaceholders(
    state: HomeViewModel.UiState,
    visible: List<RecordingSummary>,
    filter: FolderFilter,
    query: String,
    onImport: () -> Unit,
) {
    if (state.loading && state.recordings.isEmpty()) {
        item { LoadingRow() }
    }
    if (state.loading || visible.isNotEmpty()) return
    val empty = LibraryRules.emptyState(query, filter, state.isPersonal)
    // Recordings still on the phone are the library's first rows; "nothing
    // yet" above them would contradict the screen.
    if (empty == EmptyLibraryState.NOTHING_YET && state.pending.isNotEmpty()) return
    item(key = "empty") { LibraryEmptyState(empty, onImport) }
}

@Composable
private fun LoadingRow() {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 32.dp),
        horizontalArrangement = Arrangement.Center,
    ) {
        CircularProgressIndicator()
    }
}

/**
 * iOS's green line above the list once an import has landed: "Imported “X”",
 * or "… and shared to “Org”" when the default save location sent a copy there.
 * The organization is named only while it is still in the membership list; a
 * name it cannot find falls back to the plain wording rather than an empty pair
 * of quotes.
 */
@Composable
private fun ImportNoticeLine(notice: ImportNoticeText) {
    Text(
        text = if (notice.orgName != null) {
            stringResource(R.string.library_import_notice_shared, notice.title, notice.orgName)
        } else {
            stringResource(R.string.library_import_notice, notice.title)
        },
        style = MaterialTheme.typography.bodySmall,
        color = ParleyTheme.colors.success,
        modifier = Modifier.padding(vertical = 4.dp),
    )
}

/**
 * A meeting still running behind the library. Words, not a tinted card: the
 * red of the running recording is the whole signal, and it is the one place on
 * this screen that colour is allowed.
 */
@Composable
private fun ActiveMeetingCard(onClick: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 8.dp),
    ) {
        Text(
            text = stringResource(R.string.home_recording_in_progress),
            style = MaterialTheme.typography.titleSmall,
            color = ParleyTheme.colors.recording,
        )
        Text(
            text = stringResource(R.string.home_recording_in_progress_action),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun ErrorBanner(error: HomeError) {
    val message = when (error) {
        HomeError.NETWORK -> stringResource(R.string.home_error_network)
        HomeError.SERVER -> stringResource(R.string.home_error_server)
        HomeError.SIGNED_OUT -> stringResource(R.string.home_error_signed_out)
        HomeError.FORBIDDEN -> stringResource(R.string.home_error_forbidden_org)
    }
    Text(
        text = message,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.error,
        modifier = Modifier.padding(vertical = 8.dp),
    )
}

@Composable
private fun PendingHeader(count: Int, uploading: Boolean, onUpload: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = stringResource(R.string.home_pending_header),
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
        )
        Spacer(Modifier.width(8.dp))
        Badge { Text(stringResource(R.string.home_pending_badge, count)) }
        Spacer(Modifier.weight(1f))
        if (uploading) {
            CircularProgressIndicator(Modifier.height(18.dp))
        } else {
            TextButton(onClick = onUpload) {
                Text(stringResource(R.string.home_pending_retry))
            }
        }
    }
}

/**
 * One recording still on the phone. A parked one — the cloud refused it — says
 * so and is tappable to retry: it is not lost and not silently waiting, and the
 * row is where sync status is read.
 */
@Composable
private fun PendingRow(pending: PendingUpload, uploading: Boolean, actions: SyncPromptActions) {
    val parked = pending.parked
    val optionsLabel = stringResource(R.string.home_pending_retry_one_a11y)
    var menuOpen by remember { mutableStateOf(false) }
    var confirmingDelete by remember { mutableStateOf(false) }
    val title = pending.title.ifEmpty { stringResource(R.string.recording_untitled) }
    // Plain like the recording rows below it: whitespace, no fill.
    Column(
        Modifier
            .fillMaxWidth()
            .then(
                if (parked != null && !uploading) {
                    Modifier.clickable(
                        onClickLabel = optionsLabel,
                        role = Role.Button,
                        onClick = { menuOpen = true },
                    )
                } else {
                    Modifier
                },
            )
            .padding(vertical = 4.dp),
    ) {
        if (parked != null) {
            PendingRowMenu(
                expanded = menuOpen,
                title = title,
                pendingId = pending.id,
                actions = actions,
                onDismiss = { menuOpen = false },
                onDelete = { confirmingDelete = true },
            )
        }
        if (confirmingDelete) {
            DeletePendingDialog(
                title = title,
                onConfirm = {
                    confirmingDelete = false
                    actions.onDelete(pending.id)
                },
                onDismiss = { confirmingDelete = false },
            )
        }
        Text(
            text = title,
            style = MaterialTheme.typography.titleSmall,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            text = "${formatTimestamp(pending.startedAtMs.toDouble())} · " +
                formatDuration(pending.durationMs),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (parked != null) {
            Text(
                text = stringResource(R.string.home_pending_not_uploaded, parked.httpStatus),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
    }
}

/**
 * What a parked recording offers: retry, get the audio out through the share
 * sheet, or delete it — so one the cloud keeps refusing (too large, say) is
 * never trapped on the phone. iOS parity (#627).
 */
@Composable
private fun PendingRowMenu(
    expanded: Boolean,
    title: String,
    pendingId: String,
    actions: SyncPromptActions,
    onDismiss: () -> Unit,
    onDelete: () -> Unit,
) {
    val context = LocalContext.current
    val chooserTitle = stringResource(R.string.home_pending_share_title, title)
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
        DropdownMenuItem(
            text = { Text(stringResource(R.string.home_pending_action_retry)) },
            onClick = {
                onDismiss()
                actions.onRetry(pendingId)
            },
        )
        DropdownMenuItem(
            text = { Text(stringResource(R.string.home_pending_action_share)) },
            onClick = {
                onDismiss()
                actions.audioOf(pendingId)?.let { audio ->
                    PendingAudioShare.share(context, audio, title, chooserTitle)
                }
            },
        )
        DropdownMenuItem(
            text = {
                Text(
                    text = stringResource(R.string.home_pending_action_delete),
                    color = MaterialTheme.colorScheme.error,
                )
            },
            onClick = {
                onDismiss()
                onDelete()
            },
        )
    }
}

/** The second press before a never-uploaded recording — the only copy — goes. */
@Composable
private fun DeletePendingDialog(title: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.home_pending_delete_title)) },
        text = {
            Text(
                text = stringResource(R.string.home_pending_delete_body, title),
                modifier = Modifier.verticalScroll(rememberScrollState()),
            )
        },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(
                    text = stringResource(R.string.home_delete_confirm_action),
                    color = MaterialTheme.colorScheme.error,
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) }
        },
    )
}

/**
 * One recording in the library, and everything that can be done to it from
 * here: file it, share or move it into an organization, delete it.
 *
 * Two doors to the same menu on purpose. The overflow button is the discoverable
 * one and the one TalkBack can reach as a control of its own; the long press is
 * the gesture people try first on a list row. A swipe was the other candidate
 * and lost: it hides the action behind a gesture with no affordance, and it puts
 * an irreversible one behind something a thumb does by accident while scrolling.
 *
 * [compact] is the overview's recent row (iOS `RecentRecordingRow`): one line
 * of title, no overflow button — it is a shortcut, so the long press alone
 * opens the menu — and its own vertical padding between the hairlines.
 *
 * iOS puts the organizations in submenus. A Material `DropdownMenu` has none, so
 * "Share to organization" opens a second page of the same menu — the org
 * names under a Back row — rather than a second popup stacked on the first.
 *
 * While a delete, move or share is in flight the row goes half-opaque and
 * stops responding — the request can take a moment on a bad connection, and a
 * row that still looks live invites a second tap on something already changing.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun RecordingRow(
    model: RecordingRowModel,
    actions: RecordingRowActions,
    modifier: Modifier = Modifier,
    compact: Boolean = false,
) {
    var menu by remember { mutableStateOf<RowMenuPage?>(null) }
    val actionsLabel = stringResource(R.string.home_recording_actions)

    Box(
        modifier = modifier
            .fillMaxWidth()
            .alpha(if (model.working) 0.5f else 1f)
            .combinedClickable(
                enabled = !model.working,
                onLongClickLabel = actionsLabel,
                onLongClick = { menu = RowMenuPage.ROOT },
                onClick = actions.onClick,
            ),
    ) {
        if (compact) {
            RecordingRowText(model, compact = true, modifier = Modifier.padding(vertical = 11.dp))
            RowMenu(page = menu, model = model, actions = actions, onPage = { menu = it })
        } else {
            Row(verticalAlignment = Alignment.Top) {
                RecordingRowText(model, compact = false, modifier = Modifier.weight(1f).padding(top = 4.dp))
                // Nudged out by the button's own inset, so the glyph — not the
                // 48dp touch target around it — lines up with the list's edge.
                Box(Modifier.offset(x = 12.dp, y = (-8).dp)) {
                    if (model.working) {
                        CircularProgressIndicator(
                            modifier = Modifier
                                .padding(12.dp)
                                .size(20.dp),
                            strokeWidth = 2.dp,
                        )
                    } else {
                        IconButton(onClick = { menu = RowMenuPage.ROOT }) {
                            Icon(Icons.Default.MoreVert, actionsLabel)
                        }
                    }
                    RowMenu(
                        page = menu,
                        model = model,
                        actions = actions,
                        onPage = { menu = it },
                    )
                }
            }
        }
    }
}

/**
 * The row's words — iOS `RecordingCard`: where it came from as a glyph
 * ([RecordingSourceIcon]; the bundled sample also says 範例, since it is
 * neither the user's meeting nor their file), the title, then one line: when
 * the meeting was and how many people spoke ([RecordingMetaLine]), and at the
 * far end where the audio is ([AudioIndicator]). No transcript snippet,
 * duration, folder or findings.
 */
@Composable
private fun RecordingRowText(model: RecordingRowModel, compact: Boolean, modifier: Modifier = Modifier) {
    val recording = model.recording
    Column(modifier) {
        Row(verticalAlignment = Alignment.Top) {
            // On the title's first line when the title wraps to two.
            RecordingSourceIcon(recording.source, Modifier.padding(top = 3.dp))
            Spacer(Modifier.width(6.dp))
            if (SampleManifest.isSample(recording.id)) {
                Text(
                    text = stringResource(R.string.recording_source_sample),
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    softWrap = false,
                    modifier = Modifier.padding(top = 3.dp),
                )
                Spacer(Modifier.width(6.dp))
            }
            Text(
                text = recording.title.ifEmpty { stringResource(R.string.recording_untitled) },
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                maxLines = if (compact) 1 else 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.height(4.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            RecordingMetaLine(recording, Modifier.weight(1f, fill = false))
            Spacer(Modifier.weight(1f).widthIn(min = 10.dp))
            AudioIndicator(model.audio)
        }
        if (model.working) {
            Spacer(Modifier.height(6.dp))
            Text(
                text = stringResource(
                    if (model.deleting) R.string.home_deleting else R.string.library_working,
                ),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/**
 * The row's menu, on whichever [page] is open (null is closed). [onPage] moves
 * between pages, and closes the menu with null.
 */
@Composable
private fun RowMenu(
    page: RowMenuPage?,
    model: RecordingRowModel,
    actions: RecordingRowActions,
    onPage: (RowMenuPage?) -> Unit,
) {
    DropdownMenu(expanded = page != null, onDismissRequest = { onPage(null) }) {
        when (page) {
            RowMenuPage.ROOT, null -> RowMenuRoot(
                download = model.downloadAction,
                onDownload = {
                    onPage(null)
                    when (model.downloadAction) {
                        DownloadAction.DOWNLOAD -> actions.onDownload()
                        DownloadAction.REMOVE -> actions.onRemoveDownload()
                        null -> Unit
                    }
                },
                canShare = model.canShare,
                onMoveToFolder = {
                    onPage(null)
                    actions.onMoveToFolder()
                },
                onOpen = onPage,
                onDelete = {
                    onPage(null)
                    actions.onDelete()
                },
            )

            RowMenuPage.SHARE -> RowMenuOrgs(
                orgs = model.shareTargets,
                onBack = { onPage(RowMenuPage.ROOT) },
                onPick = { org ->
                    onPage(null)
                    actions.onShare(org)
                },
            )
        }
    }
}

/** Which page of a row's menu is open. */
private enum class RowMenuPage { ROOT, SHARE }

/**
 * The root page. Download / Remove download leads, as in iOS's context menu:
 * both are about the copy on the phone, the cloud keeps its own, so neither is
 * drawn as destructive — red here would say a recording is about to be lost.
 */
@Composable
private fun RowMenuRoot(
    download: DownloadAction?,
    onDownload: () -> Unit,
    canShare: Boolean,
    onMoveToFolder: () -> Unit,
    onOpen: (RowMenuPage) -> Unit,
    onDelete: () -> Unit,
) {
    // First: it is what a long press on a row is most often for.
    DropdownMenuItem(
        text = { Text(stringResource(R.string.library_move_to_folder)) },
        leadingIcon = { Icon(LibraryIcons.Folder, contentDescription = null) },
        onClick = onMoveToFolder,
    )
    when (download) {
        DownloadAction.DOWNLOAD -> DropdownMenuItem(
            text = { Text(stringResource(R.string.library_download)) },
            leadingIcon = { Icon(LibraryIcons.Download, contentDescription = null) },
            onClick = onDownload,
        )

        DownloadAction.REMOVE -> DropdownMenuItem(
            text = { Text(stringResource(R.string.library_remove_download)) },
            leadingIcon = { Icon(LibraryIcons.RemoveDownload, contentDescription = null) },
            onClick = onDownload,
        )

        null -> Unit
    }
    if (canShare) {
        DropdownMenuItem(
            text = { Text(stringResource(R.string.library_share_to_org)) },
            leadingIcon = { Icon(Icons.Default.Share, contentDescription = null) },
            trailingIcon = {
                Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null)
            },
            onClick = { onOpen(RowMenuPage.SHARE) },
        )
    }
    DropdownMenuItem(
        text = {
            Text(
                text = stringResource(R.string.home_delete_recording),
                color = MaterialTheme.colorScheme.error,
            )
        },
        leadingIcon = {
            Icon(
                imageVector = Icons.Default.Delete,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.error,
            )
        },
        onClick = onDelete,
    )
}

@Composable
private fun RowMenuOrgs(
    orgs: List<CloudOrg>,
    onBack: () -> Unit,
    onPick: (CloudOrg) -> Unit,
) {
    DropdownMenuItem(
        text = { Text(stringResource(R.string.library_menu_back)) },
        leadingIcon = { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null) },
        onClick = onBack,
    )
    HorizontalDivider()
    orgs.forEach { org ->
        DropdownMenuItem(
            text = { Text(org.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            leadingIcon = { Icon(LibraryIcons.Group, contentDescription = null) },
            onClick = { onPick(org) },
        )
    }
}

/**
 * The last thing on the meta line — iOS `RecordingCard.audioIndicator`: a
 * phone glyph when the audio is here, a ring while it is arriving, words when
 * the last attempt failed, and nothing at all otherwise.
 *
 * The phone is as quiet as the glyphs beside it: a fact worth having on the
 * row and never worth reading first, and blue would claim it can be tapped. The
 * failure is words because a red glyph in a row of five is unreadable; the
 * retry itself is the row's menu, where Download is offered again.
 */
@Composable
private fun AudioIndicator(audio: AudioDownloadState) {
    when (audio) {
        AudioDownloadState.Local -> Icon(
            imageVector = LibraryIcons.Phone,
            contentDescription = stringResource(R.string.library_on_phone),
            tint = MaterialTheme.colorScheme.outline,
            modifier = Modifier.size(13.dp),
        )

        is AudioDownloadState.Downloading -> DownloadRing(audio.fraction)

        is AudioDownloadState.Failed -> Text(
            text = stringResource(R.string.library_download_failed_retry),
            style = MaterialTheme.typography.labelSmall.copy(fontSize = 12.sp),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            softWrap = false,
        )

        AudioDownloadState.Absent -> Unit
    }
}

/**
 * How far a download has got, in the width of a glyph — iOS `DownloadRing`: a
 * faint track and a blue arc filling clockwise from twelve o'clock. Blue, unlike
 * its neighbours, because it is the one thing on the row happening right now.
 * Never quite empty, so a download that has just started does not read as a
 * placeholder; a server that declared no length gets the spinning arc instead.
 */
@Composable
private fun DownloadRing(fraction: Float) {
    val label = stringResource(R.string.library_downloading)
    val track = MaterialTheme.colorScheme.outlineVariant
    val signal = MaterialTheme.colorScheme.primary
    if (fraction < 0f) {
        CircularProgressIndicator(
            color = signal,
            trackColor = track,
            strokeWidth = 2.dp,
            modifier = Modifier
                .size(12.dp)
                .semantics { contentDescription = label },
        )
        return
    }
    val percent = (fraction.coerceIn(0f, 1f) * 100).toInt()
    Canvas(
        Modifier
            .size(12.dp)
            .semantics { contentDescription = "$label $percent%" },
    ) {
        val stroke = 2.dp.toPx()
        val inset = stroke / 2
        val arcSize = Size(size.width - stroke, size.height - stroke)
        drawArc(
            color = track,
            startAngle = 0f,
            sweepAngle = 360f,
            useCenter = false,
            topLeft = Offset(inset, inset),
            size = arcSize,
            style = Stroke(width = stroke),
        )
        drawArc(
            color = signal,
            startAngle = -90f,
            sweepAngle = 360f * fraction.coerceIn(0.02f, 1f),
            useCenter = false,
            topLeft = Offset(inset, inset),
            size = arcSize,
            style = Stroke(width = stroke, cap = StrokeCap.Round),
        )
    }
}

/**
 * A list with nothing in it — the desktop's empty box, a title and a hint
 * ([EmptyRecords]), in the words [state] calls for. The hints name the phone's
 * own gestures where the desktop's name its buttons.
 *
 * A personal library with nothing in it is also the second door into import:
 * the same picker the header's glyph opens, under the same glyph.
 */
@Composable
private fun LibraryEmptyState(state: EmptyLibraryState, onImport: () -> Unit) {
    val (title, hint) = when (state) {
        EmptyLibraryState.NO_MATCH -> R.string.library_empty_search_title to R.string.library_empty_search_hint
        EmptyLibraryState.EMPTY_FOLDER -> R.string.library_empty_folder_title to R.string.library_empty_folder_hint
        EmptyLibraryState.EMPTY_ORG -> R.string.library_empty_org_title to R.string.library_empty_org_hint
        EmptyLibraryState.ALL_FILED -> R.string.library_empty_unfiled_title to R.string.library_empty_unfiled_hint
        EmptyLibraryState.NOTHING_YET -> R.string.home_empty_title to R.string.home_empty_body
    }
    EmptyRecords(
        title = stringResource(title),
        hint = stringResource(hint),
        action = if (state == EmptyLibraryState.NOTHING_YET) {
            {
                TextButton(onClick = onImport) {
                    Icon(LibraryIcons.UploadDoc, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text(stringResource(R.string.home_empty_import))
                }
            }
        } else {
            null
        },
    )
}
