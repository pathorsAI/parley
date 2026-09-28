package com.pathors.parley.ui

import androidx.annotation.StringRes
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
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
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
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
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.AwaitPointerEventScope
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerInputChange
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pathors.parley.R
import com.pathors.parley.cloud.CloudFolder
import com.pathors.parley.cloud.CloudOrg
import com.pathors.parley.cloud.OrgRole
import com.pathors.parley.cloud.RecordingSource
import com.pathors.parley.cloud.RecordingSummary
import com.pathors.parley.library.FolderFilter
import com.pathors.parley.library.FolderSwipe
import com.pathors.parley.library.LibraryFolders
import com.pathors.parley.meeting.MeetingService
import com.pathors.parley.meeting.MeetingState
import com.pathors.parley.kit.GettingStartedState
import com.pathors.parley.kit.SampleManifest
import com.pathors.parley.playback.AudioDownloadState
import com.pathors.parley.screenshot.DemoMode
import com.pathors.parley.ui.theme.ParleyTheme
import com.pathors.parley.upload.PendingUpload
import kotlinx.coroutines.launch
import kotlin.math.abs

/**
 * The library: everything this account has in the cloud, with whatever is still
 * queued on the device pinned above it, plus the two ways to add a recording.
 *
 * Queued items sit at the top on purpose — they are the only rows that need the
 * user to do anything (stay on network), and they are the newest.
 *
 * Two ways to reload it, deliberately. The pull is the gesture anybody arriving
 * from any other Android list already has in their thumb, and it is the one that
 * works while the list is scrolled; the toolbar button stays because it is the
 * only one TalkBack can reach as a control, and it is what a screen with nothing
 * in it to pull on still offers.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    onRecord: () -> Unit,
    onImport: () -> Unit,
    onOpenRecording: (id: String, orgId: String?, openFor: OpenFor) -> Unit,
) {
    val container = rememberContainer()
    val viewModel: HomeViewModel = viewModel(factory = HomeViewModel.factory(container))
    val state by viewModel.state.collectAsState()
    val sample by viewModel.sample.collectAsState()
    val audio by viewModel.audio.collectAsState()
    val importNotice by viewModel.importNotice.collectAsState()
    var showAccount by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()
    val coroutineScope = rememberCoroutineScope()

    // The recording the user has asked to delete, held until they confirm.
    var pendingDelete by remember { mutableStateOf<RecordingSummary?>(null) }

    // The recording the folder picker is moving, while it is up.
    var moving by remember { mutableStateOf<RecordingSummary?>(null) }

    // The search field, and what is in it. See [LibrarySearch].
    val search = remember { LibrarySearch() }
    // The personal library with the bundled sample merged in — see
    // `SampleRecordingStore`. Everything below reads this, not the cloud's list.
    val library = remember(state.recordings, sample, state.isPersonal) {
        HomeViewModel.withSample(state.recordings, sample, state.isPersonal)
    }
    val visible = remember(library, state.folders, state.folderFilter, search.query) {
        HomeViewModel.visibleRecordings(library, state.folders, state.folderFilter, search.query)
    }
    val checklist = rememberChecklist(viewModel, state, library, search.query) { id, openFor ->
        onOpenRecording(id, null, openFor)
    }

    val meetingLive = rememberMeetingLive()

    // Reload on every visit: a meeting or an import that finished while this
    // screen was off-stage has a new row waiting in the cloud.
    LaunchedEffect(Unit) { viewModel.refresh() }

    DemoAccountRequest { open ->
        showAccount = open
        if (open) viewModel.loadAccount()
        // A lap route re-seeds the fixtures under a screen that may already be
        // up, so every demo request re-reads them.
        viewModel.refresh()
    }

    val callbacks = LibraryCallbacks(
        onRecord = onRecord,
        onImport = onImport,
        onUpload = { viewModel.uploadNow() },
        onRefresh = { viewModel.refresh() },
        onSelectFolder = viewModel::selectFolder,
        rowActions = { recording ->
            RecordingRowActions(
                onClick = { onOpenRecording(recording.id, state.scopeOrgId, OpenFor.READ) },
                onMoveToFolder = { moving = recording },
                onShare = { org -> viewModel.shareToOrg(recording, org, thenDelete = false) },
                onMoveToOrg = { org -> viewModel.shareToOrg(recording, org, thenDelete = true) },
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

    Scaffold(
        topBar = {
            HomeTopBar(
                state = state,
                onSelectScope = { orgId ->
                    // A folder filter or a search belongs to the library
                    // it was typed into; the next one starts clean.
                    search.close()
                    viewModel.selectScope(orgId)
                },
                onToggleSearch = search::toggle,
                onRefresh = { viewModel.refresh() },
                onAccount = {
                    showAccount = true
                    viewModel.loadAccount()
                },
            )
        },
        bottomBar = {
            HomeBottomBar(isPersonal = state.isPersonal, onRecord = onRecord, onImport = onImport)
        },
    ) { padding ->
        LibraryBody(
            state = state,
            visible = visible,
            search = search,
            meetingLive = meetingLive,
            callbacks = callbacks,
            lap = LibraryLap(checklist, listState),
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        )
    }

    if (showAccount) {
        AccountSheet(
            viewModel = viewModel,
            onDismiss = { showAccount = false },
            onShowGettingStarted = {
                showAccount = false
                search.close()
                viewModel.showChecklistAgain()
                coroutineScope.launch { listState.animateScrollToItem(0) }
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

    LibraryErrorDialogs(viewModel, state)
}

/**
 * The library's search field, and what is in it. [query] is the whole of the
 * "is a search live" state: the field can be up with nothing typed, which is not
 * a search and must not narrow anything.
 */
@Stable
private class LibrarySearch {
    var open by mutableStateOf(false)
    var query by mutableStateOf("")

    fun toggle() {
        open = !open
    }

    /**
     * Closing clears, because a search that is out of sight must not leave the
     * library filtered — there is no field left to explain why three of eleven
     * recordings are showing.
     */
    fun close() {
        open = false
        query = ""
    }
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
    val rowActions: (RecordingSummary) -> RecordingRowActions,
    val audioOf: (String) -> AudioDownloadState = { AudioDownloadState.Absent },
    val importNotice: ImportNoticeText? = null,
)

/** The import notice's parts; [orgName] null is the personal-only wording. */
private class ImportNoticeText(val title: String, val orgName: String?)

/**
 * The getting-started checklist above the list, when it shows: the personal
 * library, no search, and then the checklist's own rule
 * ([GettingStartedState.showsInLibrary], unit-tested in parleykit).
 */
private class ChecklistModel(val state: GettingStartedState, val actions: GettingStartedActions)

/** The checklist, and the list state "Show the getting-started list again" scrolls. */
private class LibraryLap(val checklist: ChecklistModel?, val listState: LazyListState)

@Composable
private fun rememberChecklist(
    viewModel: HomeViewModel,
    state: HomeViewModel.UiState,
    library: List<RecordingSummary>,
    query: String,
    onOpen: (id: String, openFor: OpenFor) -> Unit,
): ChecklistModel? {
    val checklist by viewModel.gettingStarted.collectAsState()
    val existingUserChecked by viewModel.existingUserChecked.collectAsState()
    val language = LocalConfiguration.current.locales[0].language
    val current = checklist ?: return null
    if (!state.isPersonal || query.isNotBlank()) return null
    val shows = current.showsInLibrary(
        libraryLoaded = state.personalLoaded,
        existingUserChecked = existingUserChecked,
        libraryIsEmpty = library.isEmpty(),
    )
    if (!shows) return null
    val latest = HomeViewModel.latestRecording(library)
    return ChecklistModel(
        state = current,
        actions = GettingStartedActions(
            canLoadSample = viewModel.canLoadSample(language),
            hasRecording = latest != null,
            onLoadSample = { viewModel.loadSample(language) },
            onOpen = { step -> latest?.let { onOpen(it.id, OpenFor.of(step)) } },
            onDismiss = viewModel::dismissChecklist,
        ),
    )
}

/** A meeting that is still running (the user navigated home without stopping). */
@Composable
private fun rememberMeetingLive(): Boolean {
    val session by MeetingService.activeSession.collectAsState()
    val meetingState = session?.state?.collectAsState()?.value
    return meetingState is MeetingState.Recording || meetingState is MeetingState.Connecting
}

/**
 * `parley://demo/account` lands on the library and opens the account sheet —
 * the one screen the store listing needs that has no route of its own.
 * [onRequest] is told whether the latest demo request is for the account.
 */
@Composable
private fun DemoAccountRequest(onRequest: (Boolean) -> Unit) {
    val demoNavigation by DemoMode.navigation.collectAsState()
    LaunchedEffect(demoNavigation) {
        val target = demoNavigation ?: return@LaunchedEffect
        onRequest(target.screen == DemoMode.Screen.ACCOUNT)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HomeTopBar(
    state: HomeViewModel.UiState,
    onSelectScope: (String?) -> Unit,
    onToggleSearch: () -> Unit,
    onRefresh: () -> Unit,
    onAccount: () -> Unit,
) {
    TopAppBar(
        title = { ScopeTitle(state = state, onSelectScope = onSelectScope) },
        actions = {
            IconButton(onClick = onToggleSearch) {
                Icon(Icons.Default.Search, stringResource(R.string.home_search))
            }
            IconButton(onClick = onRefresh) {
                Icon(Icons.Default.Refresh, stringResource(R.string.action_refresh))
            }
            IconButton(onClick = onAccount) {
                Icon(Icons.Default.Person, stringResource(R.string.home_account))
            }
        },
    )
}

@Composable
private fun HomeBottomBar(isPersonal: Boolean, onRecord: () -> Unit, onImport: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Button(
            onClick = onRecord,
            modifier = Modifier
                .fillMaxWidth()
                .height(56.dp),
        ) {
            Text(
                text = stringResource(R.string.home_record),
                style = MaterialTheme.typography.titleMedium,
            )
        }
        // Personal scope only, as on iOS. An import files into the
        // personal library first and shares from there (the default
        // save location decides that), so offering it under an org's
        // name would promise a destination the flow does not have.
        if (isPersonal) {
            OutlinedButton(
                onClick = onImport,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(48.dp),
            ) {
                Text(stringResource(R.string.home_import))
            }
        }
    }
}

/** The search field, the folder chips and the pull-to-refresh list under them. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LibraryBody(
    state: HomeViewModel.UiState,
    visible: List<RecordingSummary>,
    search: LibrarySearch,
    meetingLive: Boolean,
    callbacks: LibraryCallbacks,
    lap: LibraryLap,
    modifier: Modifier = Modifier,
) {
    Column(modifier) {
        if (search.open) {
            SearchField(
                query = search.query,
                onQueryChange = { search.query = it },
                hint = stringResource(R.string.home_search_hint),
                onClose = search::close,
            )
        }
        // No folders, no chip row: "All" and "Unfiled" would be the same
        // list, and a row of two chips that change nothing is noise.
        if (state.folders.isNotEmpty()) {
            FolderChips(
                folders = state.folders,
                selected = state.folderFilter,
                onSelect = callbacks.onSelectFolder,
            )
        }
        PullToRefreshBox(
            isRefreshing = state.loading,
            onRefresh = callbacks.onRefresh,
            state = rememberPullToRefreshState(),
            modifier = Modifier.fillMaxSize(),
        ) {
            LibraryList(
                state = state,
                visible = visible,
                query = search.query,
                meetingLive = meetingLive,
                callbacks = callbacks,
                lap = lap,
            )
        }
    }
}

@Composable
private fun LibraryList(
    state: HomeViewModel.UiState,
    visible: List<RecordingSummary>,
    query: String,
    meetingLive: Boolean,
    callbacks: LibraryCallbacks,
    lap: LibraryLap,
) {
    val cards = remember { CardBounds() }
    val minDistance = with(LocalDensity.current) { FolderSwipeDistance.toPx() }
    val entranceOffset = with(LocalDensity.current) { PageEntranceOffset.toPx() }
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    val latest by rememberUpdatedState(state)
    val onSelectFolder by rememberUpdatedState(callbacks.onSelectFolder)
    val entrance = rememberPageEntrance(state.folders, state.folderFilter)
    LazyColumn(
        state = lap.listState,
        modifier = Modifier
            .fillMaxSize()
            .folderSwipe(cards, minDistance, rtl) { step ->
                LibraryFolders.adjacent(latest.folders, latest.folderFilter, step)?.let(onSelectFolder)
            }
            // After the swipe in the chain: the finger is read outside the
            // slide and the cards' bounds are measured through it, so a swipe
            // that starts mid-slide still lands where the cards are drawn.
            .graphicsLayer {
                translationX = entrance.value * entranceOffset * (if (rtl) -1 else 1)
                alpha = 1f - 0.4f * abs(entrance.value)
            },
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
        )
        lap.checklist?.let { checklist ->
            item(key = "getting-started") {
                GettingStartedList(
                    state = checklist.state,
                    actions = checklist.actions,
                    modifier = Modifier.padding(bottom = 8.dp),
                )
            }
        }
        libraryPlaceholders(
            state = state,
            visible = visible,
            query = query,
            onImport = callbacks.onImport,
            checklistShown = lap.checklist != null,
        )
        // Namespaced keys: a recording drained from the pending
        // queue can show up in both lists for one refresh, and two
        // items sharing a key is an IllegalArgumentException out of
        // LazyColumn, not a glitch.
        items(visible, key = { "recording-" + it.id }) { recording ->
            DisposableEffect(cards, recording.id) {
                onDispose { cards.remove(recording.id) }
            }
            RecordingRow(
                model = LibraryRules.recordingRow(state, recording, callbacks.audioOf(recording.id)),
                actions = callbacks.rowActions(recording),
                // The gap first, then the bounds: the whitespace between two
                // rows belongs to no row, so a swipe that starts in it turns
                // the folder page instead of being left to a row (iOS keeps
                // `RecordingRow.spacing` outside every cell for the same reason).
                modifier = Modifier
                    .padding(vertical = RowGapPadding)
                    .onGloballyPositioned { cards.put(recording.id, it) },
            )
        }
    }
}

/**
 * The whitespace between two recordings — iOS `RecordingRow.spacing`, 28pt —
 * made of the list's 8dp item spacing and this much above and below each row.
 * Whitespace is the only separator: no card, no fill, no hairline.
 */
private val RowGapPadding = 10.dp

/** How far across a finger has to travel before it is a swipe to the next page. */
private val FolderSwipeDistance = 60.dp

/** How far in from the side a new page slides. */
private val PageEntranceOffset = 32.dp

/**
 * Where the recording rows are, so a swipe that starts on one is left to it —
 * see [FolderSwipe]. Coordinates rather than rectangles, turned into bounds at
 * the moment a finger goes down, because the list scrolls under them between
 * one layout and the next. Rows leave as they leave the composition.
 */
private class CardBounds {
    var list: LayoutCoordinates? = null
    private val cards = mutableMapOf<String, LayoutCoordinates>()

    fun put(id: String, coordinates: LayoutCoordinates) {
        cards[id] = coordinates
    }

    fun remove(id: String) {
        cards.remove(id)
    }

    /** The cards' bounds in the list's coordinates, as they are now. */
    fun rects(): List<Rect> {
        val list = list?.takeIf { it.isAttached } ?: return emptyList()
        return cards.values
            .filter { it.isAttached }
            .map { list.localBoundingBoxOf(it, clipBounds = false) }
    }
}

/**
 * Swiping sideways across the library turns to the neighbouring folder page,
 * as on iOS; [onStep] gets -1 or +1 once the finger lifts on one that counts
 * ([FolderSwipe.step] decides).
 *
 * It watches first and takes over late. Until the finger is past the touch
 * slop nothing is consumed, so the list's scroll, the pull to refresh and the
 * cards' taps and long presses see every event as they did before. Past it,
 * a sideways drag is claimed ([FolderSwipe.claim]) and every event from there
 * to the lift is consumed ahead of the children — otherwise a swipe across a
 * card comes up as a tap and opens it. That holds for a swipe that started on
 * a card too: it claims the gesture but never turns the page. A drag that is
 * down rather than across is the list's and is never touched. Two fingers are
 * a pinch or an accident, never a page turn.
 */
private fun Modifier.folderSwipe(
    cards: CardBounds,
    minDistance: Float,
    rtl: Boolean,
    onStep: (Int) -> Unit,
): Modifier = onGloballyPositioned { cards.list = it }
    .pointerInput(cards, minDistance, rtl) {
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            val onCards = cards.rects()
            val end = followToLift(down, viewConfiguration.touchSlop)
            if (end.multiTouch) return@awaitEachGesture
            val step = FolderSwipe.step(down.position, end.translation, onCards, minDistance, rtl)
            if (step != 0) onStep(step)
        }
    }

/** How a gesture ended: how far the first finger got, and whether another joined it. */
private class GestureEnd(val translation: Offset, val multiTouch: Boolean)

/**
 * Follows the finger that went [down] until it lifts (or is lost), consuming
 * every event from the moment the gesture is claimed as a swipe — see
 * [folderSwipe] for why, and [FolderSwipe.claimAfter] for when.
 */
private suspend fun AwaitPointerEventScope.followToLift(
    down: PointerInputChange,
    touchSlop: Float,
): GestureEnd {
    var last = down.position
    var multiTouch = false
    var claim = FolderSwipe.Claim.UNDECIDED
    while (true) {
        val event = awaitPointerEvent(PointerEventPass.Initial)
        multiTouch = multiTouch || event.changes.size > 1
        val change = event.changes.firstOrNull { it.id == down.id } ?: break
        last = change.position
        claim = FolderSwipe.claimAfter(claim, last - down.position, touchSlop, multiTouch)
        if (claim == FolderSwipe.Claim.SWIPE) change.consume()
        if (!change.pressed) break
    }
    return GestureEnd(last - down.position, multiTouch)
}

/**
 * A short slide in from the side the new page is on, whichever way it was
 * chosen — a chip or a swipe — so a folder change reads as moving along the
 * row. A nudge on the one list rather than two lists crossing: the list keeps
 * its single scroll state, which "show the getting-started list again" and
 * rotation both rely on.
 *
 * Nothing slides when the page is not a step along the row the user can see:
 * a scope switch or a deleted folder resetting to All is a new library, not a
 * neighbouring page. The value runs from ±1 (off to that side) to 0.
 */
@Composable
private fun rememberPageEntrance(
    folders: List<CloudFolder>,
    selected: FolderFilter,
): Animatable<Float, AnimationVector1D> {
    val entrance = remember { Animatable(0f) }
    val previous = remember { arrayOf(selected) }
    LaunchedEffect(selected) {
        val pages = LibraryFolders.pages(folders)
        val from = pages.indexOf(previous[0])
        val to = pages.indexOf(selected)
        previous[0] = selected
        if (from < 0 || to < 0 || from == to) return@LaunchedEffect
        entrance.snapTo(if (to > from) 1f else -1f)
        entrance.animateTo(0f, tween(durationMillis = 220))
    }
    return entrance
}

/** The folder picker over the library, moving [target]. */
@Composable
private fun MoveToFolderSheet(
    viewModel: HomeViewModel,
    state: HomeViewModel.UiState,
    target: RecordingSummary,
    onDismiss: () -> Unit,
) {
    FolderPickerSheet(
        folders = state.folders,
        // The orphan rule the list renders by, so the tick agrees with the
        // page the row was on.
        currentFolderId = LibraryFolders.liveFolderId(target.folderId, state.folders),
        onSelect = { folderId -> viewModel.moveToFolder(target, folderId) },
        onCreate = if (state.isPersonal) {
            { name -> viewModel.createFolderAndMove(target, name) }
        } else {
            null
        },
        onDismiss = onDismiss,
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
 * The library's title, which is also the switch between the personal library
 * and each organization's — the Android place for iOS's scope menu, since a
 * trailing toolbar menu with an org name in it would crowd out the three
 * actions already there.
 *
 * An account in no organization has nothing to switch between, so it gets the
 * plain title and no menu: a switcher with one entry is a control that does
 * nothing.
 */
@Composable
private fun ScopeTitle(state: HomeViewModel.UiState, onSelectScope: (String?) -> Unit) {
    if (state.orgs.isEmpty()) {
        Text(stringResource(R.string.home_title))
        return
    }
    var open by remember { mutableStateOf(false) }
    val personal = stringResource(R.string.library_scope_personal)
    val name = state.scopeOrg?.name ?: personal
    val chooseLabel = stringResource(R.string.library_scope_choose)
    Box {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .clickable(onClickLabel = chooseLabel) { open = true }
                .padding(vertical = 4.dp),
        ) {
            Icon(
                imageVector = if (state.isPersonal) LibraryIcons.Folder else LibraryIcons.Group,
                contentDescription = null,
                modifier = Modifier.size(20.dp),
            )
            Spacer(Modifier.width(8.dp))
            Text(
                text = name,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            Icon(Icons.Default.ArrowDropDown, contentDescription = chooseLabel)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            ScopeMenuItem(
                title = personal,
                role = null,
                icon = LibraryIcons.Folder,
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
 * the library each ([LibraryFolders.pages], which a swipe across the list walks
 * too), horizontally scrollable because a folder is a customer and there are
 * dozens.
 *
 * iOS's underlined labels rather than Material filter chips. A filled chip was
 * a fill behind content, and it made the folder row the loudest thing above the
 * list; an underline says "this one" with the same signal blue and no area at
 * all (see `docs/design/ios-visual-language.md`). Each chip is still a
 * selectable tab to TalkBack. The row scrolls itself so the selected chip is on
 * screen, which matters when the selection changes from somewhere other than a
 * tap on it (a swipe across the list, or a scope switch resetting to All).
 */
@Composable
private fun FolderChips(
    folders: List<CloudFolder>,
    selected: FolderFilter,
    onSelect: (FolderFilter) -> Unit,
) {
    val listState = rememberLazyListState()
    val pages = remember(folders) { LibraryFolders.pages(folders) }
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
        items(pages, key = { page ->
            when (page) {
                FolderFilter.All -> "all"
                FolderFilter.Unfiled -> "unfiled"
                is FolderFilter.Folder -> "folder-" + page.id
            }
        }) { page ->
            val label = when (page) {
                FolderFilter.All -> all
                FolderFilter.Unfiled -> unfiled
                is FolderFilter.Folder -> folders.firstOrNull { it.id == page.id }?.name.orEmpty()
            }
            FolderChip(label = label, selected = page == selected, onClick = { onSelect(page) })
        }
    }
}

/**
 * One folder: a label over a 1dp rule, blue and semibold when selected, the
 * rule transparent otherwise — always laid out, so a chip does not change
 * height on tap. The colour change runs 0.2 s, iOS's `easeInOut(0.2)`, so the
 * underline and the blue carry across to the new chip instead of snapping.
 */
@Composable
private fun FolderChip(label: String, selected: Boolean, onClick: () -> Unit) {
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
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier
            .widthIn(max = 220.dp)
            .selectable(selected = selected, role = Role.Tab, onClick = onClick)
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
        items(state.pending, key = { "pending-" + it.id }) { pending -> PendingRow(pending) }
    }
}

/**
 * What stands in for the library while it is loading, when there is none, and
 * when a search has narrowed it to nothing.
 *
 * The last two are different states and get different words. "No recordings
 * yet" on a library of eleven that a typo has emptied is a lie, and the way out
 * of each is different too: one is answered by importing something, the other by
 * editing the query — so only the first carries a button.
 */
private fun LazyListScope.libraryPlaceholders(
    state: HomeViewModel.UiState,
    visible: List<RecordingSummary>,
    query: String,
    onImport: () -> Unit,
    /** The checklist is the first-run welcome when it is up; the empty state stands down. */
    checklistShown: Boolean,
) {
    if (state.loading && state.recordings.isEmpty()) {
        item { LoadingRow() }
    }
    if (state.loading || visible.isNotEmpty()) return
    if (query.isNotBlank()) {
        item { NoMatches() }
    } else {
        // The whole personal library being empty is a first run, and gets the
        // welcome and the import door. An empty folder page or an empty team
        // library is just a place with nothing in it yet — telling someone to
        // "record a meeting, or import" there would be answering a question
        // they did not ask.
        val wholePersonal = state.isPersonal && state.folderFilter == FolderFilter.All
        if (!wholePersonal) {
            item { EmptyLibrary(onImport = null, firstRun = false) }
        } else if (state.pending.isEmpty() && !checklistShown) {
            item { EmptyLibrary(onImport = onImport, firstRun = true) }
        }
    }
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

@Composable
private fun PendingRow(pending: PendingUpload) {
    // Plain like the recording rows below it: whitespace, no fill.
    Column(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
    ) {
        Text(
            text = pending.title.ifEmpty { stringResource(R.string.recording_untitled) },
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
    }
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
 * iOS puts the organizations in submenus. A Material `DropdownMenu` has none, so
 * the two organization entries open a second page of the same menu — the org
 * names under a Back row — rather than a second popup stacked on the first.
 *
 * While a delete, move or share is in flight the row goes half-opaque and
 * stops responding — the request can take a moment on a bad connection, and a
 * row that still looks live invites a second tap on something already changing.
 *
 * No card: iOS separates rows with whitespace alone (see [RowGapPadding]), and
 * a filled surface per row was the loudest thing on the page.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun RecordingRow(
    model: RecordingRowModel,
    actions: RecordingRowActions,
    modifier: Modifier = Modifier,
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
        Row(verticalAlignment = Alignment.Top) {
            RecordingRowText(model, Modifier.weight(1f).padding(top = 4.dp))
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

/** The row's words: source, title, snippet, the counts, and what is in flight. */
@Composable
private fun RecordingRowText(model: RecordingRowModel, modifier: Modifier = Modifier) {
    val recording = model.recording
    Column(modifier) {
        Row(verticalAlignment = Alignment.Top) {
            SourceBadge(recording)
            Spacer(Modifier.width(8.dp))
            Text(
                text = recording.title.ifEmpty {
                    stringResource(R.string.recording_untitled)
                },
                style = MaterialTheme.typography.titleMedium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        val snippet = recording.snippet.orEmpty()
        if (snippet.isNotEmpty()) {
            Spacer(Modifier.height(6.dp))
            Text(
                text = snippet,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.height(8.dp))
        RecordingMeta(recording, model.folderName, model.audio)
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
                canMoveToFolder = model.canMoveToFolder,
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

            RowMenuPage.SHARE, RowMenuPage.MOVE -> RowMenuOrgs(
                orgs = model.shareTargets,
                onBack = { onPage(RowMenuPage.ROOT) },
                onPick = { org ->
                    onPage(null)
                    if (page == RowMenuPage.SHARE) actions.onShare(org) else actions.onMoveToOrg(org)
                },
            )
        }
    }
}

/** Which page of a row's menu is open. */
private enum class RowMenuPage { ROOT, SHARE, MOVE }

/**
 * The root page. Download / Remove download leads, as in iOS's context menu:
 * both are about the copy on the phone, the cloud keeps its own, so neither is
 * drawn as destructive — red here would say a recording is about to be lost.
 */
@Composable
private fun RowMenuRoot(
    download: DownloadAction?,
    onDownload: () -> Unit,
    canMoveToFolder: Boolean,
    canShare: Boolean,
    onMoveToFolder: () -> Unit,
    onOpen: (RowMenuPage) -> Unit,
    onDelete: () -> Unit,
) {
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
    if (canMoveToFolder) {
        DropdownMenuItem(
            text = { Text(stringResource(R.string.library_move_to_folder)) },
            leadingIcon = { Icon(LibraryIcons.Folder, contentDescription = null) },
            onClick = onMoveToFolder,
        )
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
        DropdownMenuItem(
            text = { Text(stringResource(R.string.library_move_to_org)) },
            leadingIcon = { Icon(LibraryIcons.Group, contentDescription = null) },
            trailingIcon = {
                Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null)
            },
            onClick = { onOpen(RowMenuPage.MOVE) },
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
 * Where a recording came from, as small caps rather than a tinted chip.
 *
 * `LIVE` keeps the recording red — it is the one word on this screen that says
 * a microphone was open — and `UPLOAD` is secondary, because a file somebody
 * imported is the unremarkable case. A filled `Badge` was the other candidate
 * and lost: there is one on this screen already, on the upload queue, where it
 * means "these need you". Two filled badges meaning two different things is one
 * too many.
 *
 * Aligned to the title's first line by baseline-ish padding rather than by
 * `alignByBaseline`, which cannot work here: the title is allowed two lines and
 * a `Row` that aligned baselines would pin the badge to the *last* of them.
 */
@Composable
private fun SourceBadge(recording: RecordingSummary) {
    val live = recording.source != RecordingSource.UPLOAD
    Text(
        // The bundled sample says what it is, in the same quiet grey as UPLOAD.
        text = when {
            SampleManifest.isSample(recording.id) -> stringResource(R.string.recording_source_sample)
            live -> stringResource(R.string.recording_source_live)
            else -> stringResource(R.string.recording_source_upload)
        },
        style = MaterialTheme.typography.labelSmall,
        fontWeight = FontWeight.SemiBold,
        color = if (live) {
            ParleyTheme.colors.recording
        } else {
            MaterialTheme.colorScheme.onSurfaceVariant
        },
        maxLines = 1,
        softWrap = false,
        modifier = Modifier.padding(top = 4.dp),
    )
}

/**
 * The line under a recording, iOS's `RecordingCard` meta row item for item:
 * how long, how many people, how many findings, the folder, then — pushed to
 * the far edge — when it happened, whether it has audio, and whether that audio
 * is on this phone.
 *
 * One line, never two. Everything here is short and exact except the folder
 * name, so every other item is pinned (`softWrap = false`, iOS's `fixedSize`)
 * and the folder alone takes what is left and truncates in it — `weight` is
 * iOS's `layoutPriority(1)`: the folder has the first claim on the slack, so it
 * degrades only once the row is actually full rather than at one character with
 * room beside it. Without a folder a spacer takes the slack instead, so the date
 * sits at the edge either way. The previous `FlowRow` answered the same pressure
 * by wrapping to a second line, which put the date under the duration on every
 * row that had a long customer name.
 *
 * Zero counts are absent rather than shown as "0": a recording nobody has
 * analyzed has no findings line to report, and a row of zeroes reads as a
 * failure rather than as an absence.
 */
@Composable
private fun RecordingMeta(
    recording: RecordingSummary,
    folderName: String?,
    audio: AudioDownloadState,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        MetaItem(
            icon = LibraryIcons.Clock,
            label = stringResource(R.string.recording_meta_duration),
            value = formatDuration(recording.durationMs),
        )
        recording.speakerCount?.takeIf { it > 0 }?.let { speakers ->
            MetaItem(
                icon = LibraryIcons.Group,
                label = stringResource(R.string.recording_meta_speakers),
                value = speakers.toString(),
            )
        }
        recording.findingsCount?.takeIf { it > 0 }?.let { findings ->
            // The lightbulb, the glyph the detail screen's findings carry on iOS.
            MetaItem(
                icon = LibraryIcons.Lightbulb,
                label = stringResource(R.string.detail_findings),
                value = findings.toString(),
            )
        }
        if (folderName != null) {
            FolderMetaItem(folderName, Modifier.weight(1f))
        } else {
            Spacer(Modifier.weight(1f))
        }
        MetaItem(icon = null, label = null, value = formatTimestamp(recording.createdAt))
        if (recording.hasAudio) {
            MetaItem(
                icon = LibraryIcons.Speaker,
                label = stringResource(R.string.recording_meta_audio),
                value = null,
            )
        }
        AudioIndicator(audio)
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
 * The folder a recording is in. Unlike [MetaItem] it ellipsizes: the others
 * are numbers that would be wrong if cut, and a folder name is still
 * recognisable from its first dozen characters. [modifier] carries the weight
 * that gives it the row's slack — see [RecordingMeta].
 */
@Composable
private fun FolderMetaItem(name: String, modifier: Modifier = Modifier) {
    val label = stringResource(R.string.library_folder_meta)
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(3.dp),
        modifier = modifier
            .semantics(mergeDescendants = true) { contentDescription = "$label $name" },
    ) {
        Icon(
            imageVector = LibraryIcons.Folder,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.outline,
            modifier = Modifier.size(13.dp),
        )
        Text(
            text = name,
            style = MaterialTheme.typography.labelSmall.copy(fontSize = 12.sp),
            color = MaterialTheme.colorScheme.outline,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * One glyph and its number, as an indivisible unit.
 *
 * The glyph carries the meaning, so it carries the accessibility label too and
 * the number beside it is left unlabelled — TalkBack reads "Speakers, 2" rather
 * than "2" next to an unnamed image. A glyph with no value (the audio mark) is a
 * fact on its own. A value with no glyph says what it is in the row's semantics
 * instead, so the duration is still announced as a duration and not as a bare
 * pair of numbers; the date is the one item that needs neither, because a
 * formatted date reads as one.
 */
@Composable
private fun MetaItem(icon: ImageVector?, label: String?, value: String?) {
    val spoken = if (icon == null && label != null && value != null) "$label $value" else null
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(3.dp),
        modifier = if (spoken != null) {
            Modifier.semantics(mergeDescendants = true) { contentDescription = spoken }
        } else {
            Modifier
        },
    ) {
        if (icon != null) {
            Icon(
                imageVector = icon,
                contentDescription = label,
                tint = MaterialTheme.colorScheme.outline,
                modifier = Modifier.size(13.dp),
            )
        }
        if (value != null) {
            Text(
                text = value,
                // Tabular figures, so a row of counts does not reflow a digit at
                // a time when the list refreshes under it.
                style = MaterialTheme.typography.labelSmall.copy(
                    fontSize = 12.sp,
                    fontFeatureSettings = "tnum",
                ),
                color = MaterialTheme.colorScheme.outline,
                maxLines = 1,
                softWrap = false,
            )
        }
    }
}

/**
 * A library with nothing in it, and the second door into import.
 *
 * The button duplicates the one on the bottom bar on purpose: this is where
 * somebody who has just signed in is looking, and "record a meeting" is not the
 * answer for the person who already has the audio. Text, not a filled button —
 * the bottom bar's two are the primary actions on this screen, and a third
 * filled control in the middle of an empty page would outrank both.
 */
@Composable
private fun EmptyLibrary(onImport: (() -> Unit)?, firstRun: Boolean) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 48.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            imageVector = Icons.AutoMirrored.Filled.List,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.outline,
            modifier = Modifier.size(40.dp),
        )
        Spacer(Modifier.height(16.dp))
        if (!firstRun) {
            Text(
                text = stringResource(R.string.library_empty_here),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            return@Column
        }
        Text(
            text = stringResource(R.string.home_empty_title),
            style = MaterialTheme.typography.titleMedium,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = stringResource(R.string.home_empty_body),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (onImport != null) {
            Spacer(Modifier.height(8.dp))
            TextButton(onClick = onImport) {
                Text(stringResource(R.string.home_empty_import))
            }
        }
    }
}

/**
 * A search that found nothing. The same shape as [EmptyLibrary] with the glyph
 * swapped for the magnifier, so the two read as one state answering differently
 * rather than as two unrelated screens — and with no button, because the way out
 * of this one is the field the reader is already typing in.
 */
@Composable
private fun NoMatches() {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 48.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            imageVector = Icons.Default.Search,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.outline,
            modifier = Modifier.size(40.dp),
        )
        Spacer(Modifier.height(16.dp))
        Text(
            text = stringResource(R.string.home_search_empty),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
