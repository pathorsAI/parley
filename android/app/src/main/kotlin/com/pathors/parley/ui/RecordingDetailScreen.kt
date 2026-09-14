package com.pathors.parley.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pathors.parley.R
import com.pathors.parley.cloud.RecordingMeta
import com.pathors.parley.cloud.TranscriptSegmentDto

/**
 * A synced recording, read-only.
 *
 * Findings and action items are rendered when the desktop has analyzed the
 * recording — the phone never runs that pipeline itself, it only displays what
 * came back (`analyzed: false` simply means the sections are absent).
 *
 * Audio playback is deliberately out of the MVP — see the PR #228 description.
 * The blob is one `GET /recordings/{id}/audio` away (`CloudClient.downloadAudio`
 * streams it to a file), but a player, a scrubber and transcript-follow are
 * their own piece of work.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RecordingDetailScreen(recordingId: String, onBack: () -> Unit) {
    val container = rememberContainer()
    val viewModel: RecordingDetailViewModel = viewModel(
        factory = RecordingDetailViewModel.factory(container, recordingId),
        key = recordingId,
    )
    val state by viewModel.state.collectAsState()
    val context = LocalContext.current
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

            else -> LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
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

                if (readable.isEmpty()) {
                    item {
                        Text(
                            text = stringResource(R.string.detail_no_transcript),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                items(readable.size) { index ->
                    val segment = readable[index]
                    TranscriptTurn(
                        segment = segment,
                        label = speakerLabel(context, segment, meta.speakerName(segment)),
                    )
                }

                item {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        text = stringResource(R.string.detail_playback_unavailable),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.outline,
                    )
                }
            }
        }
    }
}

/**
 * One turn, and the three ways to get it out of the app.
 *
 * Compose text is not selectable by default, which on this screen meant a
 * transcript nobody could take a single word out of — no selection, no copy, no
 * share, on the one screen whose entire content is text somebody wants to quote.
 *
 * The three layers mirror the iOS screen, and split the gestures cleanly:
 * whole-transcript copy and share live in the top bar; a long press on the words
 * themselves starts a text selection (`SelectionContainer` owns that gesture);
 * and a tap or a long press anywhere else on the turn opens the menu below,
 * which copies the turn *with* its speaker and timecode. Selection alone can
 * never reach those two — they are separate `Text`s — which is exactly why the
 * turn-level action exists.
 *
 * The tap opens the menu as well as the long press: there is no playback to seek
 * on this screen, so a tap on a turn has nothing else to mean, and a long press
 * is not something anyone discovers on their own. `onClickLabel` is what tells
 * TalkBack so.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TranscriptTurn(segment: TranscriptSegmentDto, label: String) {
    val context = LocalContext.current
    val clipLabel = stringResource(R.string.transcript_clip_label)
    val shareTitle = stringResource(R.string.transcript_share_title)
    val actionsLabel = stringResource(R.string.transcript_segment_actions)
    var menuOpen by remember { mutableStateOf(false) }

    Box {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .combinedClickable(
                    onClickLabel = actionsLabel,
                    onLongClickLabel = actionsLabel,
                    onClick = { menuOpen = true },
                    onLongClick = { menuOpen = true },
                )
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
                    color = MaterialTheme.colorScheme.outline,
                )
            }
            SelectionContainer {
                Text(text = segment.text, style = MaterialTheme.typography.bodyLarge)
            }
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
