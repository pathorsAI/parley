package com.pathors.parley.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pathors.parley.R
import com.pathors.parley.cloud.RecordingSource
import com.pathors.parley.cloud.RecordingSummary
import com.pathors.parley.meeting.MeetingService
import com.pathors.parley.meeting.MeetingState
import com.pathors.parley.screenshot.DemoMode
import com.pathors.parley.upload.PendingUpload

/**
 * The library: everything this account has in the cloud, with whatever is still
 * queued on the device pinned above it, plus the two ways to add a recording.
 *
 * Queued items sit at the top on purpose — they are the only rows that need the
 * user to do anything (stay on network), and they are the newest.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    onRecord: () -> Unit,
    onImport: () -> Unit,
    onOpenRecording: (String) -> Unit,
) {
    val container = rememberContainer()
    val viewModel: HomeViewModel = viewModel(factory = HomeViewModel.factory(container))
    val state by viewModel.state.collectAsState()
    var showAccount by remember { mutableStateOf(false) }

    // The recording the user has asked to delete, held until they confirm.
    var pendingDelete by remember { mutableStateOf<RecordingSummary?>(null) }

    // A meeting that is still running (the user navigated home without stopping).
    val session by MeetingService.activeSession.collectAsState()
    val meetingState = session?.state?.collectAsState()?.value
    val meetingLive = meetingState is MeetingState.Recording ||
        meetingState is MeetingState.Connecting

    // Reload on every visit: a meeting or an import that finished while this
    // screen was off-stage has a new row waiting in the cloud.
    LaunchedEffect(Unit) { viewModel.refresh() }

    // `parley://demo/account` lands on the library and opens the account sheet —
    // the one screen the store listing needs that has no route of its own.
    val demoNavigation by DemoMode.navigation.collectAsState()
    LaunchedEffect(demoNavigation) {
        val target = demoNavigation ?: return@LaunchedEffect
        showAccount = target.screen == DemoMode.Screen.ACCOUNT
        if (showAccount) viewModel.loadAccount()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.home_title)) },
                actions = {
                    IconButton(onClick = { viewModel.refresh() }) {
                        Icon(Icons.Default.Refresh, stringResource(R.string.action_refresh))
                    }
                    IconButton(onClick = {
                        showAccount = true
                        viewModel.loadAccount()
                    }) {
                        Icon(Icons.Default.Person, stringResource(R.string.home_account))
                    }
                },
            )
        },
        bottomBar = {
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
                OutlinedButton(
                    onClick = onImport,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(48.dp),
                ) {
                    Text(stringResource(R.string.home_import))
                }
            }
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            libraryHeader(
                meetingLive = meetingLive,
                state = state,
                onRecord = onRecord,
                onUpload = { viewModel.uploadNow() },
            )
            libraryPlaceholders(state)
            // Namespaced keys: a recording drained from the pending queue can
            // show up in both lists for one refresh, and two items sharing a key
            // is an IllegalArgumentException out of LazyColumn, not a glitch.
            items(state.recordings, key = { "recording-" + it.id }) { recording ->
                RecordingRow(
                    recording = recording,
                    deleting = recording.id in state.deleting,
                    onClick = { onOpenRecording(recording.id) },
                    onDelete = { pendingDelete = recording },
                )
            }
        }
    }

    if (showAccount) {
        AccountSheet(
            viewModel = viewModel,
            onDismiss = { showAccount = false },
        )
    }

    pendingDelete?.let { target ->
        DeleteRecordingDialog(
            title = target.title.ifEmpty { stringResource(R.string.recording_untitled) },
            onConfirm = {
                pendingDelete = null
                viewModel.deleteRecording(target.id)
            },
            onDismiss = { pendingDelete = null },
        )
    }

    state.deleteError?.let { error ->
        DeleteRecordingErrorDialog(
            error = error,
            onDismiss = { viewModel.clearDeleteRecordingError() },
        )
    }
}

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
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.home_delete_confirm_title)) },
        text = {
            Text(
                text = stringResource(R.string.home_delete_confirm_body, title),
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
 * The rows pinned above the cloud library: a meeting that is still running, the
 * last refresh error, and whatever is still queued on the device.
 */
private fun LazyListScope.libraryHeader(
    meetingLive: Boolean,
    state: HomeViewModel.UiState,
    onRecord: () -> Unit,
    onUpload: () -> Unit,
) {
    if (meetingLive) {
        item {
            ActiveMeetingCard(onClick = onRecord)
        }
    }
    state.error?.let { error ->
        item { ErrorBanner(error) }
    }
    if (state.pending.isNotEmpty()) {
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

/** What stands in for the library while it is loading, or when there is none. */
private fun LazyListScope.libraryPlaceholders(state: HomeViewModel.UiState) {
    if (state.loading && state.recordings.isEmpty()) {
        item { LoadingRow() }
    }
    if (!state.loading && state.recordings.isEmpty() && state.pending.isEmpty()) {
        item { EmptyLibrary() }
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

@Composable
private fun ActiveMeetingCard(onClick: () -> Unit) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.primaryContainer,
        ),
    ) {
        Column(Modifier.padding(16.dp)) {
            Text(
                text = stringResource(R.string.home_recording_in_progress),
                style = MaterialTheme.typography.titleSmall,
            )
            Text(
                text = stringResource(R.string.home_recording_in_progress_action),
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

@Composable
private fun ErrorBanner(error: HomeError) {
    val message = when (error) {
        HomeError.NETWORK -> stringResource(R.string.home_error_network)
        HomeError.SERVER -> stringResource(R.string.home_error_server)
        HomeError.SIGNED_OUT -> stringResource(R.string.home_error_signed_out)
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
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Column(Modifier.padding(16.dp)) {
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
}

/**
 * One recording in the library, and the only way to get rid of it.
 *
 * Two doors to the same menu on purpose. The overflow button is the discoverable
 * one and the one TalkBack can reach as a control of its own; the long press is
 * the gesture people try first on a list row. A swipe was the other candidate
 * and lost: it hides the action behind a gesture with no affordance, and it puts
 * an irreversible one behind something a thumb does by accident while scrolling.
 *
 * While the delete is in flight the row goes half-opaque and stops responding —
 * the request can take a moment on a bad connection, and a row that still looks
 * live invites a second tap on something already being destroyed.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun RecordingRow(
    recording: RecordingSummary,
    deleting: Boolean,
    onClick: () -> Unit,
    onDelete: () -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    val actionsLabel = stringResource(R.string.home_recording_actions)

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .alpha(if (deleting) 0.5f else 1f)
            .combinedClickable(
                enabled = !deleting,
                onLongClickLabel = actionsLabel,
                onLongClick = { menuOpen = true },
                onClick = onClick,
            ),
    ) {
        Row(
            modifier = Modifier.padding(start = 16.dp, top = 16.dp, end = 4.dp, bottom = 16.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    text = recording.title.ifEmpty { stringResource(R.string.recording_untitled) },
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(4.dp))
                val source = if (recording.source == RecordingSource.UPLOAD) {
                    stringResource(R.string.recording_source_upload)
                } else {
                    stringResource(R.string.recording_source_live)
                }
                Text(
                    text = "${formatTimestamp(recording.createdAt)} · " +
                        "${formatDuration(recording.durationMs)} · $source",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                val snippet = recording.snippet.orEmpty()
                if (snippet.isNotEmpty()) {
                    Spacer(Modifier.height(6.dp))
                    Text(
                        text = snippet,
                        style = MaterialTheme.typography.bodyMedium,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                if (deleting) {
                    Spacer(Modifier.height(6.dp))
                    Text(
                        text = stringResource(R.string.home_deleting),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Box {
                if (deleting) {
                    CircularProgressIndicator(
                        modifier = Modifier
                            .padding(12.dp)
                            .size(20.dp),
                        strokeWidth = 2.dp,
                    )
                } else {
                    IconButton(onClick = { menuOpen = true }) {
                        Icon(Icons.Default.MoreVert, actionsLabel)
                    }
                }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
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
                        onClick = {
                            menuOpen = false
                            onDelete()
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun EmptyLibrary() {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 48.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
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
    }
}
