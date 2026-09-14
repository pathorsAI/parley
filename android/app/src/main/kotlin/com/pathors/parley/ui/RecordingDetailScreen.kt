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
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Search
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
import androidx.compose.runtime.mutableIntStateOf
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
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pathors.parley.R
import com.pathors.parley.cloud.RecordingMeta
import com.pathors.parley.cloud.TranscriptSegmentDto
import com.pathors.parley.kit.TranscriptSearch
import com.pathors.parley.kit.TranscriptSegment
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

    // Whether the search field is up. Held here rather than in [DetailBody]
    // because the toolbar is what summons it and the toolbar lives up here; what
    // is typed into it belongs to the body, which is the only part that cares.
    var searching by remember { mutableStateOf(false) }

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
                    // Its own button rather than a row in an overflow menu, and
                    // absent rather than inert when there is no transcript: the
                    // same rule the copy button follows. Finding a phrase is
                    // something you do *while reading*, over and over, which is
                    // not a thing to put two taps away.
                    if (readable.isNotEmpty()) {
                        IconButton(onClick = { searching = !searching }) {
                            Icon(
                                Icons.Default.Search,
                                stringResource(R.string.transcript_search),
                            )
                        }
                    }
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
                    searching = searching,
                    onCloseSearch = { searching = false },
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
 *
 * **Searching.** Walking matches is the third thing that moves this list, and it
 * takes precedence over the playhead while it is happening: every jump to a hit
 * turns following off, because somebody stepping through matches is reading, not
 * listening along, and the next turn change would otherwise scroll the page off
 * the hit they just asked to be taken to.
 *
 * What a jump deliberately does *not* do is seek. The audio stays exactly where
 * it was. Search is how you find something with your eyes — often while the
 * recording plays on in the background — and a player that leapt to a different
 * minute every time a chevron was pressed would make reading ahead and listening
 * mutually exclusive. The turn's own tap is still there for anyone who wants to
 * hear the part they found, and it is one tap away.
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
    searching: Boolean,
    onCloseSearch: () -> Unit,
) {
    val context = LocalContext.current
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val segments = remember(meta) { meta.segments.filter { it.isFinal } }

    var followsAudio by remember { mutableStateOf(true) }
    var flashedId by remember { mutableStateOf<String?>(null) }

    // What is being searched for. Empty is the whole of the "not searching"
    // state: no highlights, no counter bar.
    var query by remember { mutableStateOf("") }
    // Which hit the counter is pointing at, as an index into the hit list. An
    // index rather than the `Hit` itself because the list is rebuilt from
    // scratch on every keystroke, and "the third match" survives that where a
    // value naming a range in a string does not. Clamped at the point of use —
    // the list can shrink under it between renders.
    var currentHit by remember { mutableIntStateOf(0) }

    // The transcript in the shape the search engine reads, mapped once per
    // recording rather than once per keystroke: `hits` runs on every character
    // typed, and re-copying the whole transcript each time would be the only
    // expensive thing on this screen.
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
    val hits = remember(searchable, query) { TranscriptSearch.hits(searchable, query) }
    // Handed to each turn so it can tint its own words without re-scanning the
    // whole transcript, while the flat list above stays the thing the counter
    // counts and the chevrons walk.
    val hitsByTurn = remember(hits) { hits.groupBy { it.segmentId } }
    val activeHit = hits.getOrNull(currentHit) ?: hits.firstOrNull()
    val turnIndexById = remember(segments) {
        segments.withIndex().associate { (index, segment) -> segment.id to index }
    }

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

    // Closing the field clears the query, because a search that is out of sight
    // must not leave the transcript highlighted — the reader has no bar left to
    // explain the tint, or to clear it with.
    LaunchedEffect(searching) { if (!searching) query = "" }

    // A new query starts again from the top hit and takes the reader there.
    LaunchedEffect(query) {
        currentHit = 0
        val first = hits.firstOrNull() ?: return@LaunchedEffect
        followsAudio = false
        listState.scrollToHit(first, turnIndexById, firstSegmentItem)
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

    Column(Modifier.fillMaxSize()) {
        // Under the player rather than over it: the player is what this screen
        // is for, and searching is a thing you do *to the transcript*, so it
        // belongs next to the transcript.
        if (searching) {
            SearchField(
                query = query,
                onQueryChange = { query = it },
                hint = stringResource(R.string.transcript_search_hint),
                onClose = onCloseSearch,
            )
        }
        LazyColumn(
            state = listState,
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
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
                    hits = hitsByTurn[segment.id].orEmpty(),
                    activeHit = activeHit,
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
        if (query.isNotBlank()) {
            MatchBar(
                hits = hits,
                currentHit = currentHit,
                onStep = { delta ->
                    if (hits.isNotEmpty()) {
                        val from = currentHit.coerceAtMost(hits.size - 1)
                        val next = (from + delta + hits.size) % hits.size
                        currentHit = next
                        // The playhead gives way — see this function's doc.
                        followsAudio = false
                        scope.launch {
                            listState.scrollToHit(hits[next], turnIndexById, firstSegmentItem)
                        }
                    }
                },
            )
        }
    }
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
 * Put a hit on screen: the turn it is in, a third of the way down, animated.
 *
 * By turn rather than by character — a `LazyListState` addresses items, and a
 * turn is the smallest thing it can be asked for. That is the right grain
 * anyway: the reader needs the sentence around the word, not the word alone.
 *
 * Silently does nothing for a hit whose segment is not in the list, which cannot
 * happen today (the same filtered list feeds both) but would otherwise be an
 * index arithmetic bug rendered as a scroll to a findings card.
 */
private suspend fun LazyListState.scrollToHit(
    hit: TranscriptSearch.Hit,
    turnIndexById: Map<String, Int>,
    firstSegmentItem: Int,
) {
    val turn = turnIndexById[hit.segmentId] ?: return
    val viewport = layoutInfo.viewportSize.height
    animateScrollToItem(
        index = firstSegmentItem + turn,
        scrollOffset = -(viewport * FOLLOW_ANCHOR).toInt(),
    )
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
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TranscriptTurn(
    label: String,
    segment: TranscriptSegmentDto,
    isCurrent: Boolean,
    isFlashing: Boolean,
    enabled: Boolean,
    hits: List<TranscriptSearch.Hit>,
    activeHit: TranscriptSearch.Hit?,
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
        val highlight = MaterialTheme.colorScheme.primary
        val text = remember(segment.text, hits, activeHit, highlight) {
            if (hits.isEmpty()) {
                AnnotatedString(segment.text)
            } else {
                buildAnnotatedString {
                    append(segment.text)
                    for (hit in hits) {
                        addStyle(
                            SpanStyle(
                                background = highlight.copy(
                                    alpha = if (hit == activeHit) {
                                        HIT_ACTIVE_ALPHA
                                    } else {
                                        HIT_ALPHA
                                    },
                                ),
                            ),
                            start = hit.start,
                            end = hit.endExclusive,
                        )
                    }
                }
            }
        }
        SelectionContainer {
            Text(text = text, style = MaterialTheme.typography.bodyLarge)
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

/** Every hit, and then the one `n of N` is pointing at, at twice the strength. */
private const val HIT_ALPHA = 0.25f
private const val HIT_ACTIVE_ALPHA = 0.50f

private const val FLASH_ALPHA = 0.20f
private const val FLASH_IN_MS = 100
private const val FLASH_OUT_MS = 200
private const val FLASH_HOLD_MS = 250L
