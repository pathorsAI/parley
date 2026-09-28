package com.pathors.parley.ui

import android.content.Context
import androidx.annotation.StringRes
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pathors.parley.R
import com.pathors.parley.cloud.RecordingMeta
import com.pathors.parley.cloud.TranscriptSegmentDto
import com.pathors.parley.kit.TranscriptAnchor
import com.pathors.parley.kit.TranscriptSearch
import com.pathors.parley.kit.TranscriptSegment
import com.pathors.parley.playback.PlaybackBar
import com.pathors.parley.playback.PlaybackController
import com.pathors.parley.playback.PlaybackBarActions
import com.pathors.parley.playback.PlaybackState
import com.pathors.parley.playback.rateLabel
import com.pathors.parley.screenshot.DemoMode
import com.pathors.parley.ui.theme.ParleyTextStyles
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * A synced recording, read and played back: two pages under one pinned player
 * — **Summary** (what the meeting came to: brief, action items, highlights,
 * speakers; [RecordingSummaryPage]) and **Transcript** (what was said, and
 * nothing else). iOS `RecordingDetailView` since #450; see
 * `docs/design/ios-recording-page.md`.
 *
 * The analysis is whatever the desktop (or the sample's script) left on the
 * recording — the phone never runs that pipeline itself. With none, the summary
 * page says so and offers the Share-to-AI hand-off instead.
 *
 * Playback is pinned above the scroll rather than placed in it: a scrubber that
 * scrolled away would make "go back thirty seconds" a two-gesture operation on
 * the one screen where it is the whole point. What it is playing, where the
 * audio comes from and what happens when it is not on the phone all belong to
 * `playback/` — this screen owns only the two ways the transcript answers to
 * it: following the playhead, and sending it somewhere on a tap.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RecordingDetailScreen(
    recordingId: String,
    orgId: String? = null,
    openFor: OpenFor = OpenFor.READ,
    onBack: () -> Unit,
) {
    val container = rememberContainer()
    val context = LocalContext.current
    val viewModel: RecordingDetailViewModel = viewModel(
        factory = RecordingDetailViewModel.factory(container, recordingId, orgId, context),
        key = "$recordingId@${orgId.orEmpty()}",
    )
    val state by viewModel.state.collectAsState()
    val playback by viewModel.playbackState.collectAsState()
    val retranscribe by viewModel.retranscribe.collectAsState()
    val filing by viewModel.filing.collectAsState()

    // The folder picker, while it is up. `parley://demo/movetofolder` opens it
    // over the demo transcript — a review frame for the picker, as on iOS.
    var choosingFolder by remember { mutableStateOf(false) }
    DemoFolderPickerRequest(metaLoaded = state.meta != null, onOpen = { choosingFolder = true })

    // Whether the search field is up. Held here rather than in [DetailBody]
    // because the toolbar is what summons it and the toolbar lives up here; what
    // is typed into it belongs to the body, which is the only part that cares.
    var searching by remember { mutableStateOf(false) }

    // Which page is up: chosen once, when the recording first loads (see
    // [initialFace]), and the reader's after that — a reload never flips it.
    // Saveable, so a rotation keeps the page too.
    var chosenFace by rememberSaveable { mutableStateOf<DetailFace?>(null) }
    val face = chosenFace ?: state.meta?.let {
        initialFace(
            hasAnalysis = state.hasAnalysis,
            forceTranscript = DemoMode.navigation.value?.screen == DemoMode.Screen.TRANSCRIPT,
        )
    }
    LaunchedEffect(face) {
        if (chosenFace == null && face != null) chosenFace = face
        // Search belongs to the transcript; leaving it closes the field, which
        // also clears the query.
        if (face == DetailFace.SUMMARY) searching = false
    }

    // What the screen renders, and therefore what "copy the transcript" means
    // here: the tentative tail a live session leaves behind never reaches this
    // screen, so it must not reach the clipboard either.
    val readable = state.meta?.segments?.filter { it.isFinal }.orEmpty()
    val menu = rememberDetailMenu(viewModel, state.meta, readable) { choosingFolder = true }
    DemoShareMenuRequest(metaLoaded = state.meta != null, onOpen = { menu.open = true })

    // What the checklist opened this screen for, acted on once the transcript
    // is up (iOS `handleIntent`). Saveable, so a rotation does not do it twice.
    var intentHandled by rememberSaveable { mutableStateOf(openFor == OpenFor.READ) }
    LaunchedEffect(state.meta != null) {
        if (intentHandled || state.meta == null) return@LaunchedEffect
        intentHandled = true
        // A beat for the push to settle, as iOS waits: a sheet thrown up
        // mid-transition reads as the screen glitching rather than as an answer.
        delay(INTENT_DELAY_MS)
        when {
            openFor == OpenFor.SHARE && readable.isNotEmpty() -> menu.shareToAI()
            openFor == OpenFor.FILE && menu.onMoveToFolder != null -> choosingFolder = true
        }
    }

    Scaffold(
        topBar = {
            DetailTopBar(meta = state.meta, onBack = onBack) {
                DetailToolbarActions(
                    menu = menu,
                    // Absent on the summary: what it searches is the
                    // transcript, and the field would open over a page it
                    // cannot find anything on.
                    showsSearch = face == DetailFace.TRANSCRIPT,
                    onToggleSearch = { searching = !searching },
                )
            }
        },
    ) { padding ->
        DetailContent(
            viewModel = viewModel,
            state = state,
            playback = playback,
            orgId = orgId,
            pages = PageControl(
                face = face ?: DetailFace.TRANSCRIPT,
                onFaceChange = { chosenFace = it },
                searching = searching,
                onCloseSearch = { searching = false },
            ),
            generate = menu::shareToAI,
            padding = padding,
        )
    }

    DetailDialogs(
        viewModel = viewModel,
        retranscribe = retranscribe,
        filing = filing,
        choosingFolder = choosingFolder,
        onDismissPicker = { choosingFolder = false },
    )
}

/** The transcript as "copy" and "share" hand it on: speaker-labelled final segments. */
private fun plainTranscriptOf(
    context: Context,
    meta: RecordingMeta?,
    readable: List<TranscriptSegmentDto>,
): String {
    if (meta == null) return ""
    return TranscriptClipboard.storedTranscript(readable) { segment ->
        speakerLabel(context, segment, meta.speakerName(segment))
    }
}

/**
 * `parley://demo/movetofolder` over a loaded recording calls [onOpen] — once
 * per request: the meta changes when the demo recording is moved, and that
 * must not bring the picker straight back.
 */
@Composable
private fun DemoFolderPickerRequest(metaLoaded: Boolean, onOpen: () -> Unit) {
    val demoNavigation by DemoMode.navigation.collectAsState()
    var handledDemoRequest by remember { mutableLongStateOf(-1L) }
    LaunchedEffect(demoNavigation, metaLoaded) {
        val request = demoNavigation ?: return@LaunchedEffect
        if (LibraryRules.opensDemoPicker(request, metaLoaded, handledDemoRequest)) {
            handledDemoRequest = request.serial
            onOpen()
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DetailTopBar(
    meta: RecordingMeta?,
    onBack: () -> Unit,
    actions: @Composable RowScope.() -> Unit,
) {
    TopAppBar(
        title = {
            Text(
                // "Untitled recording" once there is a recording to be
                // untitled; the neutral "Recording" while it loads or failed.
                text = when {
                    meta == null -> stringResource(R.string.detail_title)
                    meta.title.isEmpty() -> stringResource(R.string.recording_untitled)
                    else -> meta.title
                },
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        },
        navigationIcon = {
            IconButton(onClick = onBack) {
                Icon(
                    Icons.AutoMirrored.Filled.ArrowBack,
                    stringResource(R.string.action_back),
                )
            }
        },
        actions = actions,
    )
}

/**
 * Everything the toolbar's copy button and `⋯` menu act on, gathered so the
 * three composables that draw them take one value instead of eight.
 */
@Stable
private class DetailMenu(
    private val context: Context,
    /** The transcript alone. Evaluated on tap. */
    val transcript: () -> String,
    /** The analysis prompt plus the transcript — [HandoffText]. Evaluated on tap. */
    val handoff: () -> String,
    val transcriptEmpty: Boolean,
    val retranscribe: RetranscribeState,
    /** Null for an org recording or the sample: re-transcribing writes through the personal endpoints. */
    val onRetranscribe: (() -> Unit)?,
    /** Null for an org recording, as on iOS; see [RecordingDetailViewModel.canMoveToFolder]. */
    val onMoveToFolder: (() -> Unit)?,
    private val onCopiedWithPrompt: () -> Unit,
) {
    /** Whether the `⋯` menu is down. Here so a demo route can open it. */
    var open by mutableStateOf(false)

    /** Bumped by "Copy with analysis prompt", so the copy button says "Copied" for it too. */
    var promptCopies by mutableIntStateOf(0)
        private set

    /** The share sheet with the analysis prompt; the checklist ticks once a target is picked. */
    fun shareToAI() {
        TranscriptClipboard.shareToAI(
            context,
            handoff(),
            context.getString(R.string.transcript_share_title),
        )
    }

    fun copyWithPrompt() {
        val payload = handoff()
        if (payload.isEmpty()) return
        TranscriptClipboard.write(context, payload, context.getString(R.string.transcript_clip_label))
        promptCopies++
        onCopiedWithPrompt()
    }

    fun sharePlain() {
        val payload = transcript()
        if (payload.isNotEmpty()) {
            TranscriptClipboard.share(context, payload, context.getString(R.string.transcript_share_title))
        }
    }
}

@Composable
private fun rememberDetailMenu(
    viewModel: RecordingDetailViewModel,
    meta: RecordingMeta?,
    readable: List<TranscriptSegmentDto>,
    onMoveToFolder: () -> Unit,
): DetailMenu {
    val context = LocalContext.current
    val retranscribe by viewModel.retranscribe.collectAsState()
    val menu = remember(meta, retranscribe) {
        DetailMenu(
            context = context,
            transcript = { plainTranscriptOf(context, meta, readable) },
            handoff = { viewModel.handoffText(context) },
            transcriptEmpty = readable.isEmpty(),
            retranscribe = retranscribe,
            onRetranscribe = if (viewModel.canRetranscribe) viewModel::askToRetranscribe else null,
            onMoveToFolder = if (viewModel.canMoveToFolder && meta != null) onMoveToFolder else null,
            onCopiedWithPrompt = viewModel::noteCopiedWithPrompt,
        )
    }
    return menu
}

/**
 * `parley://demo/share-menu` over a loaded recording opens the `⋯` menu, once
 * per request — the review frame for the hand-off entries.
 */
@Composable
private fun DemoShareMenuRequest(metaLoaded: Boolean, onOpen: () -> Unit) {
    val demoNavigation by DemoMode.navigation.collectAsState()
    var handledDemoRequest by remember { mutableLongStateOf(-1L) }
    LaunchedEffect(demoNavigation, metaLoaded) {
        val request = demoNavigation ?: return@LaunchedEffect
        if (request.screen == DemoMode.Screen.SHARE_MENU && metaLoaded &&
            request.serial != handledDemoRequest
        ) {
            handledDemoRequest = request.serial
            onOpen()
        }
    }
}

@Composable
private fun DetailToolbarActions(menu: DetailMenu, showsSearch: Boolean, onToggleSearch: () -> Unit) {
    // Its own button rather than a row in an overflow menu, and
    // absent rather than inert when there is no transcript: the
    // same rule the copy button follows. Finding a phrase is
    // something you do *while reading*, over and over, which is
    // not a thing to put two taps away.
    if (showsSearch && !menu.transcriptEmpty) {
        IconButton(onClick = onToggleSearch) {
            Icon(
                Icons.Default.Search,
                stringResource(R.string.transcript_search),
            )
        }
    }
    CopyTranscriptButton(
        text = menu.transcript,
        isEmpty = menu.transcriptEmpty,
        externalCopies = menu.promptCopies,
    )
    DetailOverflowMenu(menu)
}

/** Loading, failed, or the player over the recording's body. */
@Composable
private fun DetailContent(
    viewModel: RecordingDetailViewModel,
    state: RecordingDetailViewModel.UiState,
    playback: PlaybackState,
    orgId: String?,
    pages: PageControl,
    generate: () -> Unit,
    padding: PaddingValues,
) {
    val meta = state.meta
    val modifier = Modifier
        .fillMaxSize()
        .padding(padding)
    when {
        state.loading -> Box(modifier, Alignment.Center) { CircularProgressIndicator() }

        state.failed || meta == null -> LoadFailure(
            failure = state.failure ?: DetailLoadFailure.SERVER,
            modifier = modifier,
        )

        else -> Column(modifier) {
            // An org recording's audio cannot be fetched from here (see
            // `downloadAudio`), so the bar is drawn only when the file is
            // already on this phone — the case where it can actually play.
            if (LibraryRules.showsPlaybackBar(orgId, playback.phase)) {
                PlaybackBar(
                    state = playback,
                    actions = remember(viewModel) {
                        PlaybackBarActions(
                            onPlayPause = viewModel::togglePlayPause,
                            onSeek = viewModel::seekTo,
                            onSetRate = viewModel::setRate,
                            onCycleRate = viewModel::cycleRate,
                            onDownload = viewModel::downloadAudio,
                        )
                    },
                    markers = state.findings.map { it.atMs },
                )
            }
            val retranscribe by viewModel.retranscribe.collectAsState()
            RetranscribeStatus(retranscribe)
            DetailBody(
                meta = meta,
                state = state,
                pages = pages,
                playback = playback,
                player = remember(viewModel) {
                    PlayerActions(jumpTo = viewModel::jumpTo, holdTwoX = viewModel::holdTwoX)
                },
                summary = remember(viewModel, generate) {
                    SummaryHooks(
                        canTickActionItems = viewModel.canTickActionItems,
                        tickActionItem = viewModel::tickActionItem,
                        generate = generate,
                    )
                },
            )
        }
    }
}

/**
 * Nothing to show, and why: an icon, "Couldn't load", and the reason under it —
 * iOS's `ContentUnavailableView`. Ink rather than error red: the screen is not
 * in an error state the reader caused, it simply has nothing to draw.
 */
@Composable
private fun LoadFailure(failure: DetailLoadFailure, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier.padding(horizontal = 32.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            Icons.Default.Warning,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(44.dp),
        )
        Text(
            text = stringResource(R.string.detail_load_failed_title),
            style = MaterialTheme.typography.titleLarge,
            color = MaterialTheme.colorScheme.onSurface,
        )
        Text(
            text = stringResource(loadFailureRes(failure)),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
    }
}

/** The reason line for each [DetailLoadFailure]. */
@StringRes
internal fun loadFailureRes(failure: DetailLoadFailure): Int = when (failure) {
    DetailLoadFailure.SAMPLE_MISSING -> R.string.sample_missing
    DetailLoadFailure.NETWORK -> R.string.detail_error_network
    DetailLoadFailure.SERVER -> R.string.detail_load_failed
    DetailLoadFailure.NOT_FOUND -> R.string.detail_error_not_found
    DetailLoadFailure.FORBIDDEN -> R.string.detail_error_forbidden
    DetailLoadFailure.SIGNED_OUT -> R.string.home_error_signed_out
}

/** The re-transcription confirmation, the folder picker, and a failed move. */
@Composable
private fun DetailDialogs(
    viewModel: RecordingDetailViewModel,
    retranscribe: RetranscribeState,
    filing: RecordingDetailViewModel.FilingState,
    choosingFolder: Boolean,
    onDismissPicker: () -> Unit,
) {
    if (retranscribe.phase == RetranscribeState.Phase.CONFIRMING) {
        RetranscribeConfirmation(
            onConfirm = viewModel::confirmRetranscribe,
            onDismiss = viewModel::dismissRetranscribe,
        )
    }

    if (choosingFolder) {
        FolderPickerSheet(
            folders = filing.folders,
            currentFolderId = viewModel.currentFolderId(),
            onSelect = viewModel::moveToFolder,
            onCreate = viewModel::createFolderAndMove,
            onDismiss = onDismissPicker,
        )
    }

    if (filing.moveFailed) {
        AlertDialog(
            onDismissRequest = viewModel::clearMoveError,
            title = { Text(stringResource(R.string.library_action_error_title)) },
            text = { Text(stringResource(R.string.library_move_failed)) },
            confirmButton = {
                TextButton(onClick = viewModel::clearMoveError) {
                    Text(stringResource(R.string.action_close))
                }
            },
        )
    }
}

/**
 * The `⋯` menu, and the one place on this screen that spends money.
 *
 * ## Why the toolbar was rearranged to make room
 *
 * Four trailing controls plus a back arrow leaves a phone title with about two
 * words, and "Copy" is a labelled `TextButton` rather than an icon, so it is the
 * width of two of them. Something had to leave, and share is what left: it is
 * the least used of the three (the transcript is far more often pasted than sent
 * on), it loses nothing by being a labelled row instead of a glyph, and unlike
 * copy it has no in-place feedback to sacrifice — [CopyTranscriptButton]'s whole
 * confirmation is the label changing to "Copied", which a menu that closes on
 * tap would throw away. Search stays out here because finding a phrase is
 * something you do *while reading*, repeatedly, where re-transcribing is a
 * once-ever action. Net effect: three trailing slots before and after.
 *
 * The `⋯` is rightmost, where Android has always put overflow.
 *
 * ## Why re-transcribing is in here rather than beside copy
 *
 * The same reason iOS gives it a menu: it spends the account's transcription
 * hours and rewrites the document on screen, and an action like that should not
 * sit one mis-tap away from "copy". The extra tap buys a confirmation the person
 * chose to walk towards.
 */
@Composable
private fun DetailOverflowMenu(menu: DetailMenu) {
    Box {
        IconButton(onClick = { menu.open = true }) {
            Icon(Icons.Default.MoreVert, stringResource(R.string.detail_more_actions))
        }
        DropdownMenu(expanded = menu.open, onDismissRequest = { menu.open = false }) {
            HandoffMenuItems(menu)
            val onMoveToFolder = menu.onMoveToFolder
            if (onMoveToFolder != null) {
                HorizontalDivider()
                // Above the paid action, and a plain row: filing is free,
                // reversible and frequent.
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.library_move_to_folder)) },
                    leadingIcon = { Icon(LibraryIcons.Folder, contentDescription = null) },
                    onClick = {
                        menu.open = false
                        onMoveToFolder()
                    },
                )
            }
            val onRetranscribe = menu.onRetranscribe
            if (onRetranscribe != null) {
                RetranscribeMenuItem(menu.retranscribe) {
                    menu.open = false
                    onRetranscribe()
                }
            }
        }
    }
}

/**
 * The hand-off to the user's own AI first, the plain share under it — iOS
 * `TranscriptShareMenu`'s order. "Copy with analysis prompt" is here rather
 * than beside the copy button because the button's whole feedback is its own
 * label; it borrows that label instead (see [DetailMenu.promptCopies]).
 */
@Composable
private fun HandoffMenuItems(menu: DetailMenu) {
    DropdownMenuItem(
        text = { Text(stringResource(R.string.transcript_share_to_ai)) },
        leadingIcon = { Icon(Icons.Default.Share, contentDescription = null) },
        enabled = !menu.transcriptEmpty,
        onClick = {
            menu.open = false
            menu.shareToAI()
        },
    )
    DropdownMenuItem(
        text = { Text(stringResource(R.string.transcript_copy_with_prompt)) },
        leadingIcon = { Icon(Icons.AutoMirrored.Filled.List, contentDescription = null) },
        enabled = !menu.transcriptEmpty,
        onClick = {
            menu.open = false
            menu.copyWithPrompt()
        },
    )
    DropdownMenuItem(
        text = { Text(stringResource(R.string.transcript_share)) },
        leadingIcon = { Icon(Icons.Default.Share, contentDescription = null) },
        enabled = !menu.transcriptEmpty,
        onClick = {
            menu.open = false
            menu.sharePlain()
        },
    )
}

/**
 * "Transcribe again", with the note under the row it is about rather than above
 * the menu, which is where iOS puts it: a Material menu is read top-down, so a
 * sentence explaining the item above it needs no rule about which way to look.
 * Always present, never only-when-disabled — "2 re-transcriptions left" is
 * exactly what somebody deciding whether to spend one wants to know, and a note
 * that appeared only on refusal would tell them after the fact.
 */
@Composable
private fun RetranscribeMenuItem(state: RetranscribeState, onClick: () -> Unit) {
    DropdownMenuItem(
        text = { Text(stringResource(R.string.retranscribe_action)) },
        leadingIcon = { Icon(Icons.Default.Refresh, contentDescription = null) },
        enabled = state.canRequest,
        onClick = onClick,
    )
    Text(
        text = state.block
            ?.let { stringResource(retranscribeNoteRes(it)) }
            ?: stringResource(
                R.string.retranscribe_remaining,
                state.retriesRemaining,
            ),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier
            .width(RETRANSCRIBE_NOTE_WIDTH)
            .padding(horizontal = 12.dp, vertical = 4.dp),
    )
}

/** The copy for each reason the action is unavailable. See [RetranscribeBlock]. */
@StringRes
internal fun retranscribeNoteRes(block: RetranscribeBlock): Int = when (block) {
    RetranscribeBlock.IN_FLIGHT -> R.string.retranscribe_queued
    RetranscribeBlock.BUDGET_SPENT -> R.string.retranscribe_budget_spent
    RetranscribeBlock.NO_AUDIO -> R.string.retranscribe_no_audio
}

/**
 * The second tap, and the only place the cost is stated.
 *
 * Three things have to be in it, because all three are irreversible surprises:
 * the whole recording goes again, the transcript on screen is replaced by what
 * comes back, and it is billed against the account's hours exactly as a new
 * meeting would be.
 */
@Composable
private fun RetranscribeConfirmation(onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.retranscribe_confirm_title)) },
        text = { Text(stringResource(R.string.retranscribe_confirm_body)) },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(stringResource(R.string.retranscribe_action))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.action_cancel))
            }
        },
    )
}

/**
 * One line under the player while a re-transcription is running, and one line if
 * the last one failed.
 *
 * Deliberately not a spinner over the screen, not a disabled state on the text,
 * and not an item inside the transcript list. The job takes minutes; the
 * transcript that is already here stays readable, searchable and playable
 * throughout, and the only thing that changes when the new one lands is the
 * words — so the honest UI is a sentence saying so, above a document that still
 * works.
 *
 * Outside the `LazyColumn` rather than its first item for two reasons: a status
 * that scrolled away would be unfindable ten turns down, and an extra list item
 * would break "turn *n* is item *n*" — the arithmetic that follow-the-audio, jumps
 * and the search chevrons all scroll by (see [TranscriptScroll]).
 */
@Composable
private fun RetranscribeStatus(state: RetranscribeState) {
    if (!state.showsStatus) return
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (state.isRunning) {
            // Top-aligned, not centre-aligned: the sentence wraps to two lines on
            // a phone, and a spinner centred against both would float in the gap
            // between them rather than sitting beside the line it belongs to.
            Row(verticalAlignment = Alignment.Top) {
                CircularProgressIndicator(
                    modifier = Modifier
                        .padding(top = 3.dp)
                        .size(14.dp),
                    strokeWidth = 2.dp,
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    text = stringResource(R.string.retranscribe_queued),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        when (val failure = state.failure) {
            null -> Unit
            is RetranscribeFailure.Cloud -> RetranscribeError(
                text = stringResource(
                    failure.problem.messageRes(),
                    *failure.problem.messageArgs(),
                ),
            )

            RetranscribeFailure.AudioUnavailable ->
                RetranscribeError(stringResource(R.string.retranscribe_audio_failed))

            RetranscribeFailure.BudgetSpent ->
                RetranscribeError(stringResource(R.string.retranscribe_budget_spent))
        }
    }
}

@Composable
private fun RetranscribeError(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.error,
    )
}

/**
 * How wide the note under the menu item is allowed to be.
 *
 * A `DropdownMenu` sizes itself to its widest child and its items do not wrap,
 * so a sentence left to its own devices would stretch the menu past the edge of
 * the screen. Constraining the only multi-line child is what lets it wrap
 * instead.
 */
private val RETRANSCRIBE_NOTE_WIDTH = 240.dp

/** How long the screen waits after arriving before acting on [OpenFor] — iOS waits the same 600 ms. */
private const val INTENT_DELAY_MS = 600L

/**
 * Which of the two pages is up — iOS `RecordingDetailView.Face`. See
 * `docs/design/ios-recording-page.md`.
 */
enum class DetailFace { SUMMARY, TRANSCRIPT }

/**
 * The page a recording opens on: the summary when there is any analysis to
 * show (a brief, a finding or an action item), the transcript otherwise.
 * Chosen once, when the recording first loads — after that the page is the
 * reader's, and a reload must not flip it out from under them.
 *
 * [forceTranscript] is the screenshot route that frames the transcript for the
 * store listing, as iOS keeps its `transcript` route on the transcript.
 */
internal fun initialFace(hasAnalysis: Boolean, forceTranscript: Boolean = false): DetailFace =
    if (hasAnalysis && !forceTranscript) DetailFace.SUMMARY else DetailFace.TRANSCRIPT

/**
 * Summary | Transcript. The segmented control, because two mutually exclusive
 * views of one thing is exactly what it is for, and it reads as that without a
 * word of explanation. Pinned under the player, so switching never needs a
 * scroll back to the top.
 */
@Composable
private fun FaceSwitcher(face: DetailFace, onFaceChange: (DetailFace) -> Unit) {
    val faces = DetailFace.entries
    Column {
        SingleChoiceSegmentedButtonRow(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 8.dp),
        ) {
            faces.forEachIndexed { index, option ->
                SegmentedButton(
                    selected = option == face,
                    onClick = { onFaceChange(option) },
                    shape = SegmentedButtonDefaults.itemShape(index = index, count = faces.size),
                    // A page switch, not a choice being confirmed: no tick.
                    icon = {},
                ) {
                    Text(
                        stringResource(
                            when (option) {
                                DetailFace.SUMMARY -> R.string.detail_face_summary
                                DetailFace.TRANSCRIPT -> R.string.detail_transcript
                            },
                        ),
                    )
                }
            }
        }
        HorizontalDivider(thickness = 0.5.dp)
    }
}

/**
 * The two pages under the pinned player, and everything that ties them
 * together.
 *
 * Only the page that is up is composed, but both scroll states live here, so
 * each page keeps its own scroll position: the reader who jumps from a
 * highlight into the transcript and comes back finds the summary where they
 * left it. (iOS stacks both and hides one; composing one is the cheaper way
 * to the same behaviour on Android, where a hidden `LazyColumn` would still
 * lay out.)
 *
 * **Jumping.** Every timestamp on the summary — a brief link, an action item, a
 * highlight — switches to the transcript, seeks there, scrolls the turn to the
 * upper third and washes it in the tint for about two seconds. The target turn
 * is [TranscriptAnchor]'s: a brief writes `[0:08]` for a turn that starts at
 * 8.9 s. A recording whose audio is not on the phone still scrolls and lights;
 * it just does not seek.
 *
 * **Following.** While the audio is playing, the turn the playhead is inside is
 * scrolled to the upper third of the viewport — context above it, and a
 * paragraph's worth of what is coming below. A seek goes there too, paused or
 * not: a seek *is* somebody asking to be taken there (iOS #381).
 *
 * **Letting go.** A hand on the transcript turns following off, because
 * somebody reading ahead while the audio runs is doing that on purpose and a
 * player that yanked the page back would make it impossible. Play and seek turn
 * it back on: both are somebody saying where they want to be.
 *
 * **Searching.** Walking matches is the third thing that moves the transcript,
 * and it takes precedence over the playhead while it is happening: every jump
 * to a hit turns following off, because somebody stepping through matches is
 * reading, not listening along. A jump to a hit deliberately does not seek —
 * search is how you find something with your eyes, often while the recording
 * plays on, and the turn's own tap is one tap away for anyone who wants to hear
 * it.
 */
@Composable
private fun DetailBody(
    meta: RecordingMeta,
    state: RecordingDetailViewModel.UiState,
    pages: PageControl,
    playback: PlaybackState,
    player: PlayerActions,
    summary: SummaryHooks,
) {
    val face = pages.face
    val onFaceChange = pages.onFaceChange
    val searching = pages.searching
    val onCloseSearch = pages.onCloseSearch
    val context = LocalContext.current
    val transcriptList = rememberLazyListState()
    val summaryList = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val segments = remember(meta) { meta.segments.filter { it.isFinal } }
    val starts = remember(segments) { segments.map { it.startMs } }
    val labels = remember(meta, segments) {
        segments.map { speakerLabel(context, it, meta.speakerName(it)) }
    }
    // The people in the transcript, in the order they first speak.
    val speakers = remember(labels) { labels.distinct() }
    val annotations = remember(state.findings, segments) {
        findingsByTurn(state.findings, starts).mapKeys { (turn, _) -> segments[turn].id }
    }

    var followsAudio by remember { mutableStateOf(true) }

    // What is being searched for. Empty is the whole of the "not searching"
    // state: no highlights, no counter bar.
    var query by remember { mutableStateOf("") }
    // Which hit the counter is pointing at, as an index into the hit list. An
    // index rather than the `Hit` itself because the list is rebuilt from
    // scratch on every keystroke, and "the third match" survives that where a
    // value naming a range in a string does not. Clamped at the point of use —
    // the list can shrink under it between renders.
    var currentHit by remember { mutableIntStateOf(0) }

    val matches = rememberTranscriptMatches(segments, query)
    val activeHit = matches.hits.getOrNull(currentHit) ?: matches.hits.firstOrNull()

    val scroll = remember(transcriptList) { TranscriptScroll(transcriptList) }
    // No playhead without audio: a turn starting at 0:00 is not "being played"
    // on a recording that cannot play (iOS answers nil at duration 0).
    val currentIndex = if (playback.isSeekable) currentTurnIndex(segments, playback.positionMs) else -1
    val lit = rememberTurnFlash(LIT_HOLD_MS)
    var jumpRequest by remember { mutableStateOf(JumpRequest()) }
    val onTranscript = face == DetailFace.TRANSCRIPT

    FollowPlayheadEffects(
        scroll = scroll,
        followsAudio = followsAudio,
        isPlaying = playback.isPlaying,
        seekGeneration = playback.seekGeneration,
        currentIndex = currentIndex,
        visible = onTranscript,
        onFollowChange = { followsAudio = it },
    )
    ClearQueryOnCloseEffect(searching = searching, onQueryChange = { query = it })
    JumpToFirstHitEffect(
        scroll = scroll,
        query = query,
        matches = matches,
        onCurrentHitChange = { currentHit = it },
        onReleaseFollow = { followsAudio = false },
    )
    JumpScrollEffect(scroll = scroll, request = jumpRequest)

    // A moment in the summary, taken to the transcript: switch pages, send the
    // audio there, scroll the turn into view and light it. The scroll is asked
    // for separately from the seek because a recording whose audio is not on the
    // phone cannot seek, and the jump must still land on the words.
    val jump: (Long) -> Unit = { ms ->
        onFaceChange(DetailFace.TRANSCRIPT)
        val turn = TranscriptAnchor.turnIndex(ms, starts)
        if (turn >= 0) {
            if (playback.isSeekable) player.jumpTo(TranscriptAnchor.seekMs(ms, starts))
            followsAudio = false
            jumpRequest = JumpRequest(turn = turn, serial = jumpRequest.serial + 1)
            lit.light(segments[turn].id)
        }
    }

    Column(Modifier.fillMaxSize()) {
        FaceSwitcher(face = face, onFaceChange = onFaceChange)
        // Under the switch rather than over the player: searching is a thing you
        // do *to the transcript*, so it belongs next to the transcript, and it
        // is not offered on the summary at all.
        if (searching && onTranscript) {
            SearchField(
                query = query,
                onQueryChange = { query = it },
                hint = stringResource(R.string.transcript_search_hint),
                onClose = onCloseSearch,
            )
        }
        when (face) {
            DetailFace.SUMMARY -> RecordingSummaryPage(
                state = state,
                speakers = speakers,
                listState = summaryList,
                actions = SummaryActions(
                    canTickActionItems = summary.canTickActionItems,
                    canGenerate = segments.isNotEmpty(),
                    jump = jump,
                    tickActionItem = summary.tickActionItem,
                    generate = summary.generate,
                ),
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
            )

            DetailFace.TRANSCRIPT -> {
                TranscriptPage(
                    content = TranscriptContent(segments, labels, annotations),
                    scroll = scroll,
                    decoration = TurnDecoration(
                        currentIndex = currentIndex,
                        isSeekable = playback.isSeekable,
                        matches = matches,
                        activeHit = activeHit,
                        onSeek = player.jumpTo,
                    ),
                    lit = lit,
                    isHoldingTwoX = playback.isHoldingTwoX,
                    onHoldTwoX = player.holdTwoX,
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f),
                )
                if (query.isNotBlank()) {
                    MatchBar(
                        hits = matches.hits,
                        currentHit = currentHit,
                        onStep = { delta ->
                            stepHit(currentHit, delta, matches.hits.size)?.let { next ->
                                currentHit = next
                                // The playhead gives way — see this function's doc.
                                followsAudio = false
                                scope.launch {
                                    scroll.toHit(matches.hits[next], matches.turnIndexById)
                                }
                            }
                        },
                    )
                }
            }
        }
    }
}

/**
 * Which page is up and whether the search field is, with the two ways to
 * change them — held by the screen, because the toolbar drives both.
 */
@Immutable
private class PageControl(
    val face: DetailFace,
    val onFaceChange: (DetailFace) -> Unit,
    val searching: Boolean,
    val onCloseSearch: () -> Unit,
)

/** The two things the transcript asks of the player. */
@Immutable
private class PlayerActions(
    /** A seek asked for from the text — a turn, a timecode, a 💡 line, a summary link. */
    val jumpTo: (Long) -> Unit,
    /** An edge of the transcript is held (2×), or let go. */
    val holdTwoX: (Boolean) -> Unit,
)

/** What the summary page can do beyond jumping, handed down from the screen. */
@Immutable
private class SummaryHooks(
    val canTickActionItems: Boolean,
    val tickActionItem: (id: String, done: Boolean) -> Unit,
    val generate: () -> Unit,
)

/** A jump the transcript has to scroll to. [serial] so the same turn twice is still two requests. */
@Immutable
private data class JumpRequest(val turn: Int = -1, val serial: Int = 0)

/**
 * Which turn each finding starts in, for the 💡 lines — by index into the turns.
 * A finding before the first turn belongs to the first turn (iOS
 * `annotations`).
 */
internal fun findingsByTurn(findings: List<FindingRow>, startsMs: List<Long>): Map<Int, List<FindingRow>> {
    val byTurn = linkedMapOf<Int, MutableList<FindingRow>>()
    for (finding in findings) {
        val turn = TranscriptAnchor.turnIndex(finding.atMs, startsMs)
        if (turn >= 0) byTurn.getOrPut(turn) { mutableListOf() } += finding
    }
    return byTurn
}

/**
 * Everything a query produces, plus the one lookup that turns a hit into
 * somewhere to scroll.
 *
 * [hits] is flat and in document order, because that is what `n of N` counts and
 * what the chevrons walk. [byTurn] is the same hits grouped, handed to each turn
 * so it can tint its own words without re-scanning the whole transcript, while
 * the flat list stays the thing the counter counts. [turnIndexById] is not about
 * the query at all — it is how a hit's segment becomes a lazy-list index.
 */
@Immutable
private class TranscriptMatches(
    val hits: List<TranscriptSearch.Hit>,
    val byTurn: Map<String, List<TranscriptSearch.Hit>>,
    val turnIndexById: Map<String, Int>,
)

/**
 * Run [query] over [segments], keeping everything that does not depend on the
 * query out of the per-keystroke path.
 *
 * The transcript is mapped into the shape the search engine reads once per
 * recording rather than once per keystroke: the search runs on every character
 * typed, and re-copying the whole transcript each time would be the only
 * expensive thing on this screen.
 */
@Composable
private fun rememberTranscriptMatches(
    segments: List<TranscriptSegmentDto>,
    query: String,
): TranscriptMatches {
    val searchable = remember(segments) {
        segments.map { segment ->
            TranscriptSegment(
                id = segment.id,
                source = segment.source,
                speaker = segment.speaker,
                text = segment.text,
                isFinal = segment.isFinal,
                startMs = segment.startMs,
                endMs = segment.endMs,
            )
        }
    }
    val turnIndexById = remember(segments) {
        segments.withIndex().associate { (index, segment) -> segment.id to index }
    }
    val hits = remember(searchable, query) { TranscriptSearch.hits(searchable, query) }
    return remember(hits, turnIndexById) {
        TranscriptMatches(
            hits = hits,
            byTurn = hits.groupBy { it.segmentId },
            turnIndexById = turnIndexById,
        )
    }
}

/**
 * Following the playhead, and the gestures that arm and disarm it.
 *
 * The follow scrolls once per turn change, not once per tick, which is what
 * keying the effect on the turn index rather than on the clock buys; and only
 * while the transcript is the page that is up — coming back to it while the
 * audio plays is itself a turn change for this effect, so the page catches up.
 *
 * A seek is not the same question as following. Following asks whether the app
 * may move the page while nobody asked it to, and while paused the answer is
 * no; a seek *is* the asking, so it takes the reader to the turn
 * unconditionally — paused as much as playing, which is the whole of dragging
 * the timeline to a point to read what was said at it (iOS #381). Unanimated:
 * a scrub seeks on every frame, and animations that pile up read as lag.
 *
 * The distinction that has to be right is *user* scroll versus programmatic
 * scroll, and `interactionSource` is exactly that line — a programmatic scroll
 * emits no drag interaction, so the follow cannot switch itself off.
 *
 * Reports through [onFollowChange] rather than owning the flag, because search
 * and jumps turn it off too: there is one answer to "is this list following the
 * audio" and it lives in [DetailBody].
 */
@Composable
private fun FollowPlayheadEffects(
    scroll: TranscriptScroll,
    followsAudio: Boolean,
    isPlaying: Boolean,
    seekGeneration: Int,
    currentIndex: Int,
    visible: Boolean,
    onFollowChange: (Boolean) -> Unit,
) {
    val listState = scroll.listState
    LaunchedEffect(listState) {
        listState.interactionSource.interactions.collect { interaction ->
            if (interaction is DragInteraction.Start) onFollowChange(false)
        }
    }

    LaunchedEffect(isPlaying) {
        // Pausing does not re-arm: the reader is probably about to scroll.
        if (isPlaying) onFollowChange(true)
    }

    // Read at the moment the seek lands, not when the effect was keyed: the
    // position and the generation move in the same state update.
    val latestIndex = rememberUpdatedState(currentIndex)
    LaunchedEffect(seekGeneration) {
        if (seekGeneration == 0) return@LaunchedEffect
        onFollowChange(true)
        val turn = latestIndex.value
        if (turn >= 0) scroll.snapToTurn(turn)
    }

    LaunchedEffect(currentIndex, followsAudio, isPlaying, visible) {
        if (!visible || !followsAudio || !isPlaying || currentIndex < 0) return@LaunchedEffect
        scroll.toTurn(currentIndex)
    }
}

/**
 * A jump from the summary, scrolled to once the transcript is on screen.
 * Unanimated: the page has just changed under the reader, and a scroll
 * animating on top of that reads as the page sliding about.
 */
@Composable
private fun JumpScrollEffect(scroll: TranscriptScroll, request: JumpRequest) {
    LaunchedEffect(request.serial) {
        if (request.serial == 0 || request.turn < 0) return@LaunchedEffect
        // A frame for the transcript page to be composed in place of the summary.
        withFrameNanos { }
        scroll.snapToTurn(request.turn)
    }
}

/**
 * Closing the field clears the query, because a search that is out of sight must
 * not leave the transcript highlighted — the reader has no bar left to explain
 * the tint, or to clear it with.
 */
@Composable
private fun ClearQueryOnCloseEffect(searching: Boolean, onQueryChange: (String) -> Unit) {
    LaunchedEffect(searching) { if (!searching) onQueryChange("") }
}

/**
 * A new query starts again from the top hit and takes the reader there.
 *
 * The jump gives the playhead up for the same reason a chevron does — see
 * [DetailBody]: somebody taken to a match is reading, and the next turn change
 * would otherwise scroll the page off the hit they just asked for.
 */
@Composable
private fun JumpToFirstHitEffect(
    scroll: TranscriptScroll,
    query: String,
    matches: TranscriptMatches,
    onCurrentHitChange: (Int) -> Unit,
    onReleaseFollow: () -> Unit,
) {
    LaunchedEffect(query) {
        onCurrentHitChange(0)
        val first = matches.hits.firstOrNull() ?: return@LaunchedEffect
        onReleaseFollow()
        scroll.toHit(first, matches.turnIndexById)
    }
}

/** The transcript as the page draws it: the turns, what each is labelled, and the 💡 lines under them. */
@Immutable
private class TranscriptContent(
    val segments: List<TranscriptSegmentDto>,
    /** [segments]' speaker labels, index for index. */
    val labels: List<String>,
    /** Segment id → the findings that start in it. */
    val annotations: Map<String, List<FindingRow>>,
)

/**
 * The transcript page: the turns, the hold-for-2× bands at either edge, and
 * the pill that says 2× is on.
 *
 * The hold lives on the page rather than on strips drawn over it, the lesson
 * iOS learned the hard way: a strip that *might* want the touch takes it away
 * from the scroll underneath, which is how 44pt of each edge stopped scrolling
 * at all there. Here the page watches the touch on the way down to the list
 * (the `Initial` pass) and only claims it once the press has lasted — a finger
 * already on its way fails the press and the list scrolls as it always did.
 */
@Composable
private fun TranscriptPage(
    content: TranscriptContent,
    scroll: TranscriptScroll,
    decoration: TurnDecoration,
    lit: TurnFlash,
    isHoldingTwoX: Boolean,
    onHoldTwoX: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val latestHoldTwoX = rememberUpdatedState(onHoldTwoX)
    // Set by the hold itself, synchronously, so a turn's long-press menu — whose
    // own timer runs out just after the hold engages — knows the press was
    // somebody asking for 2× rather than for the menu.
    var edgeHeld by remember { mutableStateOf(false) }
    val band = with(LocalDensity.current) { EDGE_BAND.toPx() }
    Box(
        modifier = modifier.pointerInput(decoration.isSeekable, band) {
            // No audio, nothing to speed up.
            if (!decoration.isSeekable) return@pointerInput
            detectEdgeHold(band) { holding ->
                edgeHeld = holding
                latestHoldTwoX.value(holding)
            }
        },
    ) {
        TranscriptList(
            content = content,
            scroll = scroll,
            decoration = decoration,
            lit = lit,
            canOpenMenu = { !edgeHeld },
            modifier = Modifier.fillMaxSize(),
        )
        if (decoration.isSeekable) EdgeZones()
        if (isHoldingTwoX) {
            TwoXPill(
                Modifier
                    .align(Alignment.TopCenter)
                    .padding(top = 8.dp),
            )
        }
    }
}

/**
 * Hold a band at either edge for 2×, released on let-go — YouTube's gesture,
 * on the only part of this screen with room for it. iOS `twoXHold`.
 *
 * Watches on the `Initial` pass, so it sees the touch before the list does,
 * and consumes nothing until the press has lasted [EDGE_HOLD_MS] without moving
 * past the touch slop: before that, a finger on its way is a scroll and is left
 * entirely to the list. Once it holds, it claims the rest of the gesture — the
 * list does not scroll and the turn under it does not take the release as a
 * tap — and the `finally` is what makes the release unmissable: a gesture that
 * is cancelled, or a page that goes away mid-hold, still lets go of 2×.
 */
private suspend fun PointerInputScope.detectEdgeHold(band: Float, onHold: (Boolean) -> Unit) {
    awaitEachGesture {
        val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
        val width = size.width
        val inBand = width > 0 && (down.position.x < band || down.position.x > width - band)
        if (!inBand) return@awaitEachGesture
        val slop = viewConfiguration.touchSlop
        val endedEarly = withTimeoutOrNull(EDGE_HOLD_MS) {
            var ended = false
            while (!ended) {
                val change = awaitPointerEvent(PointerEventPass.Initial)
                    .changes.firstOrNull { it.id == down.id }
                ended = change == null || !change.pressed ||
                    (change.position - down.position).getDistance() > slop
            }
            true
        }
        if (endedEarly != null) return@awaitEachGesture
        onHold(true)
        try {
            do {
                val event = awaitPointerEvent(PointerEventPass.Initial)
                event.changes.forEach { it.consume() }
            } while (event.changes.any { it.pressed })
        } finally {
            onHold(false)
        }
    }
}

/**
 * The two bands, for TalkBack only: they draw nothing and take no touches (the
 * hold is on the page — see [TranscriptPage]), but a screen reader user
 * exploring the page learns the gesture is there, as iOS's strips say.
 */
@Composable
private fun BoxScope.EdgeZones() {
    val label = stringResource(R.string.transcript_two_x_zone) + ". " +
        stringResource(R.string.transcript_two_x_hint)
    listOf(Alignment.CenterStart, Alignment.CenterEnd).forEach { edge ->
        Box(
            Modifier
                .align(edge)
                .fillMaxHeight()
                .width(EDGE_BAND)
                .semantics { contentDescription = label },
        )
    }
}

/**
 * What YouTube shows while the same gesture is held: a small mark saying the
 * speed is not the one you chose, so a release is obviously what ends it. A
 * plain box rather than a `Surface`, which would take touches — it appears
 * exactly where the reader is already pressing.
 */
@Composable
private fun TwoXPill(modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.background)
            .border(0.5.dp, MaterialTheme.colorScheme.outlineVariant, CircleShape)
            .clearAndSetSemantics {}
            .padding(horizontal = 10.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            text = rateLabel(PlaybackController.HELD_RATE),
            style = MaterialTheme.typography.labelMedium.copy(fontFeatureSettings = "tnum"),
            color = MaterialTheme.colorScheme.onSurface,
        )
        Icon(
            Icons.Default.PlayArrow,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.size(14.dp),
        )
    }
}

/**
 * The scroll itself: one continuous column, the way the desktop reads a
 * transcript — turn after turn separated by whitespace. No header, no cards:
 * the title is in the top bar, the analysis is on the summary page, and here it
 * appears only as a 💡 line under the turn a finding starts in.
 *
 * Turn *n* is item *n*, which is what [TranscriptScroll] scrolls by; the one
 * other item, the "no transcript" line, only exists when there are no turns.
 */
@Composable
private fun TranscriptList(
    content: TranscriptContent,
    scroll: TranscriptScroll,
    decoration: TurnDecoration,
    lit: TurnFlash,
    canOpenMenu: () -> Boolean,
    modifier: Modifier = Modifier,
) {
    val flash = rememberTurnFlash(FLASH_HOLD_MS)
    val segments = content.segments

    LazyColumn(
        state = scroll.listState,
        modifier = modifier,
        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        if (segments.isEmpty()) {
            item {
                Text(
                    text = stringResource(R.string.detail_no_transcript),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 6.dp),
                )
            }
        }
        items(segments.size) { index ->
            val segment = segments[index]
            TranscriptTurn(
                turn = TurnView(
                    label = content.labels[index],
                    segment = segment,
                    isCurrent = index == decoration.currentIndex,
                    wash = TurnWash(isFlashing = flash.isFlashing(segment.id), isLit = lit.isFlashing(segment.id)),
                    enabled = decoration.isSeekable,
                    hits = decoration.matches.byTurn[segment.id].orEmpty(),
                    activeHit = decoration.activeHit,
                    findings = content.annotations[segment.id].orEmpty(),
                ),
                actions = TurnActions(
                    canOpenMenu = canOpenMenu,
                    onTap = {
                        decoration.onSeek(segment.startMs)
                        flash.light(segment.id)
                    },
                    onFinding = { finding ->
                        // Goes to the finding's own moment, which may be inside the turn.
                        if (decoration.isSeekable) decoration.onSeek(finding.atMs)
                        lit.light(segment.id)
                    },
                ),
            )
        }
    }
}

/**
 * Which turn is washed with colour right now, and the timer that takes it away.
 *
 * One object rather than a bare id plus a coroutine at the call site because the
 * timer needs a guard: a second light elsewhere, landing inside the first one's
 * hold, must not have its own wash cancelled by the first one's timer coming
 * due. Guarding on the id is what makes the late timer a no-op.
 *
 * Two of them: the tap's acknowledgement (a quarter of a second) and a jump's
 * "here it is" (two seconds — long enough for the eye to find it).
 */
@Stable
private class TurnFlash(private val scope: CoroutineScope, private val holdMs: Long) {
    private var flashed by mutableStateOf<String?>(null)

    /** Whether [segmentId] is the turn currently lit. */
    fun isFlashing(segmentId: String): Boolean = flashed == segmentId

    /** Light [segmentId], and put it out again once the hold is up. */
    fun light(segmentId: String) {
        flashed = segmentId
        scope.launch {
            delay(holdMs)
            if (flashed == segmentId) flashed = null
        }
    }
}

@Composable
private fun rememberTurnFlash(holdMs: Long): TurnFlash {
    val scope = rememberCoroutineScope()
    return remember(scope, holdMs) { TurnFlash(scope, holdMs) }
}

/**
 * `n of N` and the two chevrons, pinned under the transcript while a query is
 * live and gone the moment it is cleared.
 *
 * Pinned rather than scrolled for the same reason the player above it is:
 * walking hits is the one activity on this screen where the control and the
 * thing it moves cannot be the same piece of paper. The transcript scrolls under
 * it; the counter stays where the thumb left it.
 *
 * Up and down, not left and right — the transcript is one column, and the
 * previous match is above the thumb rather than behind it.
 *
 * The chevrons stay in place, disabled, when nothing matched. Taking them away
 * would move the "No matches" text sideways on the keystroke that lost the last
 * hit, and a control that leaves the screen as you are reaching for it is worse
 * than one that is plainly unavailable.
 */
@Composable
private fun MatchBar(
    hits: List<TranscriptSearch.Hit>,
    currentHit: Int,
    onStep: (Int) -> Unit,
) {
    HorizontalDivider()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 20.dp, end = 8.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = if (hits.isEmpty()) {
                stringResource(R.string.transcript_search_empty)
            } else {
                stringResource(
                    R.string.transcript_search_position,
                    currentHit.coerceAtMost(hits.size - 1) + 1,
                    hits.size,
                )
            },
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.weight(1f))
        IconButton(onClick = { onStep(-1) }, enabled = hits.isNotEmpty()) {
            Icon(
                Icons.Default.KeyboardArrowUp,
                stringResource(R.string.transcript_search_previous),
            )
        }
        IconButton(onClick = { onStep(1) }, enabled = hits.isNotEmpty()) {
            Icon(
                Icons.Default.KeyboardArrowDown,
                stringResource(R.string.transcript_search_next),
            )
        }
    }
}

/**
 * Where a chevron leaves the counter: one step from [current], wrapping at both
 * ends, or null when there is no hit to walk to.
 *
 * [current] is clamped before it is stepped because the hit list is rebuilt on
 * every keystroke and may have shrunk under the index since it was set.
 */
private fun stepHit(current: Int, delta: Int, total: Int): Int? {
    if (total <= 0) return null
    val from = current.coerceAtMost(total - 1)
    return (from + delta + total) % total
}

/**
 * How to scroll to the *n*th turn of the conversation — which is item *n* of
 * the list (see [TranscriptList]).
 *
 * The one place the anchor is applied, so following the playhead, a seek, a
 * jump from the summary and walking search hits cannot drift apart about where
 * "here" is on screen.
 */
@Stable
private class TranscriptScroll(val listState: LazyListState) {

    /** Turn [turn] to the upper third of the viewport, animated. */
    suspend fun toTurn(turn: Int) {
        listState.animateScrollToItem(index = turn, scrollOffset = anchorOffset())
    }

    /**
     * The same, at once — for a seek (a scrub emits one per frame, and
     * animations that pile up read as lag) and for a jump (the page has just
     * changed under the reader).
     *
     * Waits for the list to have a height first: straight after a page switch
     * it has not been measured, and an anchor worked out against zero would put
     * the turn flush against the top.
     */
    suspend fun snapToTurn(turn: Int) {
        withTimeoutOrNull(MEASURE_WAIT_MS) {
            snapshotFlow { listState.layoutInfo.viewportSize.height }.first { it > 0 }
        }
        listState.scrollToItem(index = turn, scrollOffset = anchorOffset())
    }

    /**
     * Put a hit on screen: the turn it is in, a third of the way down, animated.
     *
     * By turn rather than by character — a `LazyListState` addresses items, and
     * a turn is the smallest thing it can be asked for. That is the right grain
     * anyway: the reader needs the sentence around the word, not the word alone.
     */
    suspend fun toHit(hit: TranscriptSearch.Hit, turnIndexById: Map<String, Int>) {
        val turn = turnIndexById[hit.segmentId] ?: return
        toTurn(turn)
    }

    /** Negative, so the turn lands a third of the way down rather than flush against the top. */
    private fun anchorOffset(): Int = -(listState.layoutInfo.viewportSize.height * FOLLOW_ANCHOR).toInt()
}

/**
 * How each turn in the list is drawn, and what a tap on one does.
 *
 * Which turn is current, whether taps do anything at all, what the query matched
 * and which match is the live one are four answers that [TranscriptList] never
 * reads for itself — it passes every one of them straight through to the turns.
 * A data class rather than a loose bundle so a render that changed none of them
 * still lets the list skip.
 */
@Stable
private data class TurnDecoration(
    val currentIndex: Int,
    val isSeekable: Boolean,
    val matches: TranscriptMatches,
    val activeHit: TranscriptSearch.Hit?,
    val onSeek: (Long) -> Unit,
)

/** The two washes a turn can be under. See [TurnFlash]. */
@Immutable
private data class TurnWash(val isFlashing: Boolean, val isLit: Boolean)

/** Everything one turn draws: its words, its label, and what is marked on it. */
@Immutable
private data class TurnView(
    val label: String,
    val segment: TranscriptSegmentDto,
    /** The playhead is inside this turn: its speaker label goes blue. */
    val isCurrent: Boolean,
    val wash: TurnWash,
    /** Whether a tap can seek — false when there is no audio to move. */
    val enabled: Boolean,
    val hits: List<TranscriptSearch.Hit>,
    val activeHit: TranscriptSearch.Hit?,
    /** The findings that start in this turn, for its 💡 lines. */
    val findings: List<FindingRow>,
)

/** What a turn does when it is touched. */
@Immutable
private class TurnActions(
    /** False while an edge hold is on, so the hold does not also open the menu. */
    val canOpenMenu: () -> Boolean,
    val onTap: () -> Unit,
    val onFinding: (FindingRow) -> Unit,
)

/**
 * One turn of the conversation, and the gestures on it.
 *
 * The split follows iOS: a tap moves the audio, a long press opens the menu that
 * copies or shares this turn. `onLongClickLabel` is what tells TalkBack the
 * gesture is there, since nobody discovers a long press on their own.
 *
 * Disabled — not just inert — when there is nothing to seek: a paragraph that
 * flashed while the player stayed put would be a lie about what just happened.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TranscriptTurn(turn: TurnView, actions: TurnActions) {
    val label = turn.label
    val segment = turn.segment
    val wash = turn.wash
    val enabled = turn.enabled
    val hits = turn.hits
    val activeHit = turn.activeHit
    val canOpenMenu = actions.canOpenMenu
    val onTap = actions.onTap
    val onFinding = actions.onFinding
    var menuOpen by remember { mutableStateOf(false) }
    val highlight = MaterialTheme.colorScheme.primary
    val text = remember(segment.text, hits, activeHit, highlight) {
        highlightedTurnText(segment.text, hits, activeHit, highlight)
    }
    val litWash = washColor(wash.isLit, LIT_ALPHA, LIT_IN_MS, LIT_OUT_MS)
    val flashWash = washColor(wash.isFlashing, FLASH_ALPHA, FLASH_IN_MS, FLASH_OUT_MS)

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.small)
            .background(litWash)
            .background(flashWash)
            // The menu does not need a player, so the long press stays live even
            // when there is nothing to seek; only the tap goes quiet.
            .combinedClickable(
                onClick = { if (enabled) onTap() },
                onClickLabel = stringResource(R.string.transcript_seek_here),
                onLongClick = { if (canOpenMenu()) menuOpen = true },
                onLongClickLabel = stringResource(R.string.transcript_segment_actions),
            )
            .padding(horizontal = 6.dp, vertical = 4.dp),
    ) {
        TurnHeading(label = label, startMs = segment.startMs, isCurrent = turn.isCurrent)
        SelectionContainer {
            Text(text = text, style = MaterialTheme.typography.bodyLarge)
        }
        turn.findings.forEach { finding ->
            FindingNote(finding = finding, onTap = { onFinding(finding) })
        }
        TurnActionsMenu(
            expanded = menuOpen,
            onDismiss = { menuOpen = false },
            segment = segment,
            label = label,
        )
    }
}

/**
 * The speaker, the timecode, and the only mark the playhead leaves in the
 * transcript.
 *
 * The speaker label goes **blue while the audio is inside this turn** — the
 * same rule as the live screen and iOS, where blue means "this is happening
 * now". On a finished recording nothing is happening until somebody presses
 * play, and then exactly one turn is. The timecode stays a plain tertiary
 * numeral: it is one of dozens on the screen, and colouring every one of them
 * would spend the signal on furniture.
 */
@Composable
private fun TurnHeading(label: String, startMs: Long, isCurrent: Boolean) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
            color = if (isCurrent) {
                MaterialTheme.colorScheme.primary
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            },
        )
        Spacer(Modifier.width(8.dp))
        Text(
            text = formatClock(startMs),
            style = ParleyTextStyles.caption2.copy(fontFeatureSettings = "tnum"),
            color = MaterialTheme.colorScheme.outline,
        )
    }
}

/**
 * The analysis as a margin note: a finding that starts in this turn, in
 * secondary ink under the words, behind a lightbulb. Tapping it goes to the
 * finding's own moment and lights the turn. iOS `annotation(_:in:)`.
 */
@Composable
private fun FindingNote(finding: FindingRow, onTap: () -> Unit) {
    val description = stringResource(R.string.transcript_highlight, finding.title)
    Row(
        modifier = Modifier
            .padding(top = 4.dp)
            .clip(MaterialTheme.shapes.small)
            .clickable(onClick = onTap)
            .clearAndSetSemantics { contentDescription = description }
            .padding(vertical = 2.dp),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Icon(
            imageVector = TranscriptIcons.Lightbulb,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier
                .padding(top = 2.dp)
                .size(14.dp),
        )
        Text(
            text = finding.title,
            style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.Normal),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/**
 * The colour behind a turn: the tap's quick flash (in fast and out slow), and
 * the softer, longer wash a jump from the summary leaves.
 *
 * The flash is the whole acknowledgement of a tap: a tap on a paragraph produces
 * no other visible change when the audio is already near it, and without one
 * the gesture reads as not having registered. It is a wash of the primary
 * colour behind the text rather than a colour change in it — the transcript is
 * a page of prose in one weight, and re-weighting a paragraph inside it makes
 * the page look mis-set.
 */
@Composable
private fun washColor(active: Boolean, alpha: Float, inMs: Int, outMs: Int): Color {
    val tint = MaterialTheme.colorScheme.primary.copy(alpha = alpha)
    val color by animateColorAsState(
        targetValue = if (active) tint else Color.Transparent,
        animationSpec = tween(durationMillis = if (active) inMs else outMs),
        label = "turnWash",
    )
    return color
}

/**
 * The turn's words with its search hits tinted, or the words alone when the
 * query found nothing in this one.
 *
 * Search hits are a wash of colour behind the glyphs rather than bold or a
 * colour change in the words. The transcript is a page of prose in one weight,
 * and re-weighting words inside it makes the paragraph look mis-set — a tint
 * leaves the text reading exactly as it does unsearched, which matters because
 * every other hit stays on screen while the reader works through them.
 *
 * Two strengths. Every hit gets the pale one, so the reader can see how the
 * matches are spread down the page; the current one gets twice that, so `n of N`
 * is pointing at something findable without needing a second kind of mark.
 *
 * Deliberately not a `@Composable`: it is a pure mapping from text plus hits to
 * spans, which is what lets the call site `remember` it against exactly those
 * inputs and do no work on the keystrokes that did not change this turn.
 */
private fun highlightedTurnText(
    text: String,
    hits: List<TranscriptSearch.Hit>,
    activeHit: TranscriptSearch.Hit?,
    highlight: Color,
): AnnotatedString {
    if (hits.isEmpty()) return AnnotatedString(text)
    return buildAnnotatedString {
        append(text)
        for (hit in hits) {
            val alpha = if (hit == activeHit) HIT_ACTIVE_ALPHA else HIT_ALPHA
            addStyle(
                SpanStyle(background = highlight.copy(alpha = alpha)),
                start = hit.start,
                end = hit.endExclusive,
            )
        }
    }
}

/**
 * The long press's menu: this turn, copied or shared *with* its speaker and
 * timecode.
 *
 * Selecting the words by hand can never reach those two — they are separate
 * `Text`s — which is why the turn-level action exists at all.
 */
@Composable
private fun TurnActionsMenu(
    expanded: Boolean,
    onDismiss: () -> Unit,
    segment: TranscriptSegmentDto,
    label: String,
) {
    val context = LocalContext.current
    val clipLabel = stringResource(R.string.transcript_clip_label)
    val shareTitle = stringResource(R.string.transcript_share_title)

    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
        DropdownMenuItem(
            text = { Text(stringResource(R.string.transcript_copy_segment)) },
            onClick = {
                onDismiss()
                TranscriptClipboard.write(
                    context,
                    TranscriptClipboard.plainText(segment, label),
                    clipLabel,
                )
            },
        )
        DropdownMenuItem(
            text = { Text(stringResource(R.string.action_share)) },
            leadingIcon = { Icon(Icons.Default.Share, contentDescription = null) },
            onClick = {
                onDismiss()
                TranscriptClipboard.share(
                    context,
                    TranscriptClipboard.plainText(segment, label),
                    shareTitle,
                )
            },
        )
    }
}

/**
 * The turn the playhead is inside: the last one that has started, or -1 before
 * the first.
 *
 * Deliberately by `startMs` alone rather than by the `startMs…endMs` range. The
 * ranges have gaps — a pause between turns belongs to neither — and during a
 * pause the turn that was just spoken is the one a reader's eye is on, so it
 * keeps the mark rather than handing it back to nobody.
 */
internal fun currentTurnIndex(segments: List<TranscriptSegmentDto>, positionMs: Long): Int {
    var found = -1
    for ((index, segment) in segments.withIndex()) {
        if (segment.startMs <= positionMs) found = index else break
    }
    return found
}

/** The glyph the core icon set lacks — see [LibraryIcons] for why these are drawn by hand. */
private object TranscriptIcons {

    /** An outlined lightbulb — a finding's margin note (iOS `lightbulb`). */
    val Lightbulb: ImageVector by lazy {
        ImageVector.Builder(
            name = "Lightbulb",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        ).addPath(
            pathData = addPathNodes(
                "M9,21c0,0.55 0.45,1 1,1h4c0.55,0 1,-0.45 1,-1v-1L9,20v1z" +
                    "M12,2C8.14,2 5,5.14 5,9c0,2.38 1.19,4.47 3,5.74L8,17c0,0.55 0.45,1 1,1h6" +
                    "c0.55,0 1,-0.45 1,-1v-2.26c1.81,-1.27 3,-3.36 3,-5.74 0,-3.86 -3.14,-7 -7,-7z" +
                    "M14.85,13.1l-0.85,0.6L14,16h-4v-2.3l-0.85,-0.6C7.8,12.16 7,10.63 7,9" +
                    "c0,-2.76 2.24,-5 5,-5s5,2.24 5,5c0,1.63 -0.8,3.16 -2.15,4.1z",
            ),
            fill = SolidColor(Color.Black),
        ).build()
    }
}

/** Where a followed turn lands in the viewport: a third of the way down. */
private const val FOLLOW_ANCHOR = 0.3f

/** How long [TranscriptScroll.snapToTurn] waits for a freshly shown list to be measured. */
private const val MEASURE_WAIT_MS = 1_000L

/** Every hit, and then the one `n of N` is pointing at, at twice the strength. */
private const val HIT_ALPHA = 0.25f
private const val HIT_ACTIVE_ALPHA = 0.50f

/** A tapped turn's acknowledgement. */
private const val FLASH_ALPHA = 0.20f
private const val FLASH_IN_MS = 100
private const val FLASH_OUT_MS = 200
private const val FLASH_HOLD_MS = 250L

/** A jump's "here it is" — iOS washes the turn at 12% for about two seconds. */
private const val LIT_ALPHA = 0.12f
private const val LIT_IN_MS = 150
private const val LIT_OUT_MS = 600
private const val LIT_HOLD_MS = 2_000L

/** The width of the hold-for-2× band at either edge — iOS `edgeBand`, 44pt. */
private val EDGE_BAND = 44.dp

/** How long a press in a band has to last to be a hold — iOS's 0.35 s. */
private const val EDGE_HOLD_MS = 350L
