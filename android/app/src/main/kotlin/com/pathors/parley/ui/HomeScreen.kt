package com.pathors.parley.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Badge
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
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
            items(state.recordings, key = { it.id }) { recording ->
                RecordingRow(recording, onClick = { onOpenRecording(recording.id) })
            }
        }
    }

    if (showAccount) {
        AccountSheet(
            viewModel = viewModel,
            onDismiss = { showAccount = false },
        )
    }
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
        items(state.pending, key = { it.id }) { pending -> PendingRow(pending) }
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

@Composable
private fun RecordingRow(recording: RecordingSummary, onClick: () -> Unit) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
    ) {
        Column(Modifier.padding(16.dp)) {
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
