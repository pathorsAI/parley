package com.pathors.parley.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pathors.parley.R
import com.pathors.parley.cloud.RecordingMeta
import com.pathors.parley.cloud.TranscriptSegmentDto
import com.pathors.parley.playback.PlaybackBar
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * A synced recording: the player, then the analysis, then the transcript.
 *
 * Findings and action items are rendered when the desktop has analyzed the
 * recording — the phone never runs that pipeline itself, it only displays what
 * came back (`analyzed: false` simply means the sections are absent).
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
fun RecordingDetailScreen(recordingId: String, onBack: () -> Unit) {
    val container = rememberContainer()
    val context = LocalContext.current
    val viewModel: RecordingDetailViewModel = viewModel(
        factory = RecordingDetailViewModel.factory(container, recordingId, context),
        key = recordingId,
    )
    val state by viewModel.state.collectAsState()
    val playback by viewModel.playbackState.collectAsState()
    val untitled = stringResource(R.string.recording_untitled)

    // What the screen renders, and therefore what "copy the transcript" means
    // here: the tentative tail a live session leaves behind never reaches this
    // screen, so it must not reach the clipboard either.
    val readable = state.meta?.segments?.filter { it.isFinal }.orEmpty()
    val plainTranscript = {
        val meta = state.meta
        if (meta == null) {
            ""
        } else {
            TranscriptClipboard.storedTranscript(readable) { segment ->
                speakerLabel(context, segment, meta.speakerName(segment))
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = state.meta?.title?.takeIf { it.isNotEmpty() }
                            ?: stringResource(R.string.detail_title),
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
                actions = {
                    ShareTranscriptButton(
                        text = plainTranscript,
                        isEmpty = readable.isEmpty(),
                    )
                    CopyTranscriptButton(
                        text = plainTranscript,
                        isEmpty = readable.isEmpty(),
                    )
                },
            )
        },
    ) { padding ->
        val meta = state.meta
        when {
            state.loading -> Box(
                Modifier
                    .fillMaxSize()
                    .padding(padding),
                Alignment.Center,
            ) { CircularProgressIndicator() }

            state.failed || meta == null -> Box(
                Modifier
                    .fillMaxSize()
                    .padding(padding),
                Alignment.Center,
            ) {
                Text(
                    text = stringResource(R.string.detail_load_failed),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                )
            }

            else -> Column(
                Modifier
                    .fillMaxSize()
                    .padding(padding),
            ) {
                PlaybackBar(
                    state = playback,
                    onPlayPause = viewModel::togglePlayPause,
                    onSeek = viewModel::seekTo,
                    onSetRate = viewModel::setRate,
                    onCycleRate = viewModel::cycleRate,
                    onDownload = viewModel::downloadAudio,
                )
                DetailBody(
                    meta = meta,
                    state = state,
                    untitled = untitled,
                    positionMs = playback.positionMs,
                    isPlaying = playback.isPlaying,
                    seekGeneration = playback.seekGeneration,
                    isSeekable = playback.isSeekable,
                    onSeek = viewModel::seekTo,
                )
            }
        }
    }
}

/**
 * The scrolling half of the screen, and the two places it answers to the
 * player.
 *
 * **Following.** While the audio is playing, the turn the playhead is inside is
 * scrolled to the upper third of the viewport — context above it, and a
 * paragraph's worth of what is coming below. Once per turn change, not once per
 * tick, which is what keying the effect on the turn index rather than on the
 * clock buys.
 *
 * **Letting go.** A hand on the transcript turns following off, because
 * somebody reading ahead while the audio runs is doing that on purpose and a
 * player that yanked the page back would make it impossible. Play and seek turn
 * it back on: both are somebody saying where they want to be.
 *
 * The distinction that has to be right is *user* scroll versus programmatic
 * scroll, and `interactionSource` is exactly that line — `animateScrollToItem`
 * emits no drag interaction, so the follow cannot switch itself off.
 */
@Composable
private fun DetailBody(
    meta: RecordingMeta,
    state: RecordingDetailViewModel.UiState,
    untitled: String,
    positionMs: Long,
    isPlaying: Boolean,
    seekGeneration: Int,
    isSeekable: Boolean,
    onSeek: (Long) -> Unit,
) {
    val context = LocalContext.current
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val segments = remember(meta) { meta.segments.filter { it.isFinal } }

    var followsAudio by remember { mutableStateOf(true) }
    var flashedId by remember { mutableStateOf<String?>(null) }

    val firstSegmentItem = remember(state.findings.size, state.actionItems.size, segments.size) {
        firstSegmentItemIndex(
            findings = state.findings.size,
            actionItems = state.actionItems.size,
            hasSegments = segments.isNotEmpty(),
        )
    }
    val currentIndex = currentTurnIndex(segments, positionMs)

    LaunchedEffect(listState) {
        listState.interactionSource.interactions.collect { interaction ->
            if (interaction is DragInteraction.Start) followsAudio = false
        }
    }

    LaunchedEffect(isPlaying, seekGeneration) {
        // Both are somebody saying where they want to be, so both re-arm the
        // follow. Pausing does not: the reader is probably about to scroll.
        if (isPlaying || seekGeneration > 0) followsAudio = true
    }

    LaunchedEffect(currentIndex, followsAudio, isPlaying) {
        if (!followsAudio || !isPlaying || currentIndex < 0) return@LaunchedEffect
        val viewport = listState.layoutInfo.viewportSize.height
        listState.animateScrollToItem(
            index = firstSegmentItem + currentIndex,
            // Negative, so the turn lands a third of the way down rather than
            // flush against the player.
            scrollOffset = -(viewport * FOLLOW_ANCHOR).toInt(),
        )
    }

    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item { Header(meta, untitled) }

        if (state.findings.isNotEmpty()) {
            item { SectionTitle(stringResource(R.string.detail_findings)) }
            items(state.findings.size) { index ->
                FindingCard(state.findings[index])
            }
        }

        if (state.actionItems.isNotEmpty()) {
            item { SectionTitle(stringResource(R.string.detail_action_items)) }
            items(state.actionItems.size) { index ->
                ActionItemCard(state.actionItems[index])
            }
        }

        item { SectionTitle(stringResource(R.string.detail_transcript)) }

        if (segments.isEmpty()) {
            item {
                Text(
                    text = stringResource(R.string.detail_no_transcript),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        items(segments.size) { index ->
            val segment = segments[index]
            TranscriptTurn(
                label = speakerLabel(context, segment, meta.speakerName(segment)),
                segment = segment,
                isCurrent = index == currentIndex,
                isFlashing = flashedId == segment.id,
                enabled = isSeekable,
                onTap = {
                    onSeek(segment.startMs)
                    flashedId = segment.id
                    scope.launch {
                        delay(FLASH_HOLD_MS)
                        // Guarded on the id so a second tap elsewhere, landing
                        // inside this one's hold, does not have its own flash
                        // cancelled by the first tap's timer coming due.
                        if (flashedId == segment.id) flashedId = null
                    }
                },
            )
        }
    }
}

/**
 * One turn of the conversation, and the tap that sends the audio to it.
 *
 * The flash is the whole acknowledgement: a tap on a paragraph produces no
 * other visible change when the audio is already near it, and without one the
 * gesture reads as not having registered. It is a wash of the primary colour
 * behind the text rather than a colour change in it — the transcript is a page
 * of prose in one weight, and re-weighting a paragraph inside it makes the page
 * look mis-set.
 *
 * Disabled — not just inert — when there is nothing to seek: a paragraph that
 * flashed while the player stayed put would be a lie about what just happened.
 *
 * The long press is the other half, and the split follows iOS: a tap moves the
 * audio, a long press opens the menu that copies or shares this turn *with* its
 * speaker and timecode. Selecting the words by hand can never reach those two —
 * they are separate `Text`s — which is why the turn-level action exists at all.
 * `onLongClickLabel` is what tells TalkBack the gesture is there, since nobody
 * discovers a long press on their own.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TranscriptTurn(
    label: String,
    segment: TranscriptSegmentDto,
    isCurrent: Boolean,
    isFlashing: Boolean,
    enabled: Boolean,
    onTap: () -> Unit,
) {
    val context = LocalContext.current
    val clipLabel = stringResource(R.string.transcript_clip_label)
    val shareTitle = stringResource(R.string.transcript_share_title)
    var menuOpen by remember { mutableStateOf(false) }

    val flash = MaterialTheme.colorScheme.primary.copy(alpha = FLASH_ALPHA)
    val background by animateColorAsState(
        targetValue = if (isFlashing) flash else Color.Transparent,
        animationSpec = tween(durationMillis = if (isFlashing) FLASH_IN_MS else FLASH_OUT_MS),
        label = "turnFlash",
    )

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.small)
            .background(background)
            // The menu does not need a player, so the long press stays live even
            // when there is nothing to seek; only the tap goes quiet.
            .combinedClickable(
                onClick = { if (enabled) onTap() },
                onClickLabel = stringResource(R.string.transcript_seek_here),
                onLongClick = { menuOpen = true },
                onLongClickLabel = stringResource(R.string.transcript_segment_actions),
            )
            .padding(horizontal = 6.dp, vertical = 4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.width(8.dp))
            Text(
                text = formatClock(segment.startMs),
                style = MaterialTheme.typography.labelSmall,
                // The playhead's turn marks itself in the timecode rather than
                // in the prose, so the eye can find "here" without the
                // paragraph reading differently from the ones around it.
                color = if (isCurrent) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.outline
                },
                fontWeight = if (isCurrent) FontWeight.SemiBold else null,
            )
        }
        SelectionContainer {
            Text(text = segment.text, style = MaterialTheme.typography.bodyLarge)
        }
        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.transcript_copy_segment)) },
                onClick = {
                    menuOpen = false
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
                    menuOpen = false
                    TranscriptClipboard.share(
                        context,
                        TranscriptClipboard.plainText(segment, label),
                        shareTitle,
                    )
                },
            )
        }
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

/**
 * Where the first transcript turn sits in the lazy list, so the follow can
 * scroll to one by index.
 *
 * Counted rather than looked up because `LazyListState` addresses items by
 * position and the sections above the transcript are conditional. Header,
 * then each populated analysis section as a title plus its rows, then the
 * transcript's own title, then the "no transcript" line when there is one.
 */
internal fun firstSegmentItemIndex(
    findings: Int,
    actionItems: Int,
    hasSegments: Boolean,
): Int {
    var index = 1 // the header
    if (findings > 0) index += 1 + findings
    if (actionItems > 0) index += 1 + actionItems
    index += 1 // the transcript's section title
    if (!hasSegments) index += 1 // the "no transcript" line
    return index
}

@Composable
private fun Header(meta: RecordingMeta, untitled: String) {
    val speakers = meta.segments.map { "${it.source}-${it.speaker}" }.toSet().size
    Column {
        Text(
            text = meta.title.ifEmpty { untitled },
            style = MaterialTheme.typography.headlineSmall,
        )
        Spacer(Modifier.height(4.dp))
        Text(
            text = "${formatTimestamp(meta.createdAt)} · " +
                stringResource(R.string.detail_length, formatDuration(meta.durationMs)) + " · " +
                stringResource(R.string.detail_speakers, speakers),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(8.dp))
        HorizontalDivider()
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.titleMedium,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(top = 8.dp),
    )
}

@Composable
private fun FindingCard(finding: FindingRow) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (finding.title.isNotEmpty()) {
                    Text(
                        text = finding.title,
                        style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                }
                finding.atMs?.let { at ->
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = formatClock(at),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.outline,
                    )
                }
            }
            if (finding.detail.isNotEmpty()) {
                Spacer(Modifier.height(4.dp))
                Text(text = finding.detail, style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

@Composable
private fun ActionItemCard(item: ActionItemRow) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Column(Modifier.padding(14.dp)) {
            Text(text = item.text, style = MaterialTheme.typography.bodyLarge)
            if (item.rationale.isNotEmpty()) {
                Spacer(Modifier.height(4.dp))
                Text(
                    text = item.rationale,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/** Where a followed turn lands in the viewport: a third of the way down. */
private const val FOLLOW_ANCHOR = 0.3f

private const val FLASH_ALPHA = 0.20f
private const val FLASH_IN_MS = 100
private const val FLASH_OUT_MS = 200
private const val FLASH_HOLD_MS = 250L
