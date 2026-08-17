package com.pathors.parley.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.pathors.parley.R
import com.pathors.parley.kit.TranscriptSegment
import com.pathors.parley.meeting.LiveMeeting
import com.pathors.parley.meeting.MeetingFailure
import com.pathors.parley.meeting.MeetingService
import com.pathors.parley.meeting.MeetingSession
import com.pathors.parley.meeting.MeetingState
import com.pathors.parley.meeting.TranscriptionIssue
import com.pathors.parley.screenshot.DemoMode
import com.pathors.parley.screenshot.rememberDemoMeeting
import kotlinx.coroutines.delay

/**
 * The live meeting: permission gate, transcript, level meter, stop button.
 *
 * The screen owns none of the recording. It asks [MeetingService] to start,
 * observes the [MeetingSession] the service publishes, and asks it to stop —
 * which is what lets the user leave this screen (or the app) mid-meeting without
 * the capture noticing.
 */
@Composable
fun MeetingScreen(onDone: () -> Unit) {
    val context = LocalContext.current
    val session by MeetingService.activeSession.collectAsState()

    // Store screenshots: scripted segments on a timer, no permission prompt, no
    // microphone — an emulator has no audio input, and a capture must never
    // depend on one.
    if (DemoMode.isActive) {
        // One exception, for the Play foreground-service declaration video: if
        // RECORD_AUDIO happens to be granted already, run the real service in
        // notification-only mode so the ongoing notification can be filmed. A
        // plain screenshot run never grants it, so it stays notification-free;
        // the video run grants it deliberately via `adb shell pm grant`. See
        // `MeetingService.startDemoNotification`.
        val demo = rememberDemoMeeting()
        val canShowNotification = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.RECORD_AUDIO,
        ) == PackageManager.PERMISSION_GRANTED
        if (canShowNotification) {
            DisposableEffect(Unit) {
                MeetingService.startDemoNotification(context, demo.elapsedMs.value)
                onDispose { MeetingService.requestStop(context) }
            }
        }
        MeetingContent(session = demo, onStop = onDone, onDone = onDone)
        return
    }

    var granted by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
        )
    }
    var denied by remember { mutableStateOf(false) }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { result ->
        // POST_NOTIFICATIONS only decides whether the ongoing notification is
        // visible; the recording itself hangs on RECORD_AUDIO alone.
        val ok = result[Manifest.permission.RECORD_AUDIO] == true
        granted = ok
        denied = !ok
    }

    // Start at most once per visit. Keyed on `granted` alone, and latched: when a
    // finished meeting is cleared the published session goes back to null, and a
    // session-keyed effect would read that as "start another one".
    var started by remember { mutableStateOf(false) }
    LaunchedEffect(granted) {
        if (granted && !started && MeetingService.activeSession.value == null) {
            started = true
            MeetingService.start(context)
        }
    }

    if (!granted) {
        PermissionGate(
            denied = denied,
            onRequest = { permissionLauncher.launch(requiredPermissions()) },
            onCancel = onDone,
        )
        return
    }

    val active = session
    if (active == null) {
        Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }
        return
    }

    MeetingContent(session = active, onStop = { MeetingService.requestStop(context) }, onDone = onDone)
}

private fun requiredPermissions(): Array<String> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS)
    } else {
        arrayOf(Manifest.permission.RECORD_AUDIO)
    }

@Composable
private fun MeetingContent(session: LiveMeeting, onStop: () -> Unit, onDone: () -> Unit) {
    val state by session.state.collectAsState()
    val segments by session.segments.collectAsState()
    val issue by session.issue.collectAsState()
    val level by session.level.collectAsState()
    val elapsed by session.elapsedMs.collectAsState()

    // A finished meeting is a transient state: show the outcome for a beat, drop
    // the session, and go back to the library where the new recording now lives.
    LaunchedEffect(state) {
        if (state is MeetingState.Finished) {
            delay(1_200)
            MeetingService.clear()
            onDone()
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp),
    ) {
        Spacer(Modifier.height(16.dp))
        Text(
            text = formatClock(elapsed),
            style = MaterialTheme.typography.displaySmall,
            fontWeight = FontWeight.Medium,
        )
        Text(
            text = statusLabel(state),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(12.dp))
        LevelMeter(level = level, live = state is MeetingState.Recording)

        issue?.let { current ->
            Spacer(Modifier.height(12.dp))
            Text(
                text = when (current) {
                    TranscriptionIssue.QUOTA_EXCEEDED -> stringResource(R.string.meeting_issue_quota)
                    TranscriptionIssue.RELAY_ERROR,
                    TranscriptionIssue.RELAY_CLOSED,
                    -> stringResource(R.string.meeting_issue_error)
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }

        (state as? MeetingState.Failed)?.let { failed ->
            Spacer(Modifier.height(12.dp))
            Text(
                text = failureMessage(failed.reason),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
            )
            TextButton(onClick = {
                MeetingService.clear()
                onDone()
            }) {
                Text(stringResource(R.string.action_close))
            }
        }

        Spacer(Modifier.height(16.dp))
        Box(Modifier.weight(1f)) {
            LiveTranscript(segments)
        }

        if (state is MeetingState.Recording || state is MeetingState.Connecting) {
            Button(
                onClick = onStop,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(56.dp)
                    .padding(vertical = 4.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.error,
                    contentColor = MaterialTheme.colorScheme.onError,
                ),
            ) {
                Text(stringResource(R.string.action_stop))
            }
        }
        Spacer(Modifier.height(16.dp))
    }
}

@Composable
private fun statusLabel(state: MeetingState): String = when (state) {
    MeetingState.Idle, MeetingState.Connecting -> stringResource(R.string.meeting_connecting)
    MeetingState.Recording -> stringResource(R.string.meeting_recording)
    MeetingState.Finishing -> stringResource(R.string.meeting_finishing)
    MeetingState.Uploading -> stringResource(R.string.meeting_uploading)
    is MeetingState.Finished -> when {
        state.dropped -> stringResource(R.string.meeting_dropped)
        state.pendingUpload -> stringResource(R.string.meeting_queued)
        else -> stringResource(R.string.meeting_uploaded)
    }

    is MeetingState.Failed -> failureMessage(state.reason)
}

@Composable
private fun failureMessage(reason: MeetingFailure): String = when (reason) {
    MeetingFailure.NOT_SIGNED_IN -> stringResource(R.string.failure_not_signed_in)
    MeetingFailure.MIC_PERMISSION -> stringResource(R.string.failure_mic_permission)
    MeetingFailure.MIC_UNAVAILABLE -> stringResource(R.string.failure_mic_unavailable)
    MeetingFailure.ENCODER_UNAVAILABLE -> stringResource(R.string.failure_encoder_unavailable)
    MeetingFailure.UPLOAD_FAILED -> stringResource(R.string.failure_upload)
    MeetingFailure.UNKNOWN -> stringResource(R.string.failure_unknown)
}

/** Twelve bars lit in proportion to the last chunk's RMS. */
@Composable
private fun LevelMeter(level: Float, live: Boolean) {
    val animated by animateFloatAsState(
        targetValue = if (live) level.coerceIn(0f, 1f) else 0f,
        label = "level",
    )
    val bars = 12
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(20.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        repeat(bars) { index ->
            val lit = animated * bars > index
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxHeight()
                    .clip(RoundedCornerShape(2.dp))
                    .background(
                        if (lit) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.surfaceVariant
                    )
            )
        }
    }
}

@Composable
private fun LiveTranscript(segments: List<TranscriptSegment>) {
    val context = LocalContext.current
    val listState = rememberLazyListState()

    LaunchedEffect(segments.size) {
        if (segments.isNotEmpty()) listState.animateScrollToItem(segments.lastIndex)
    }

    if (segments.isEmpty()) {
        Box(Modifier.fillMaxSize(), Alignment.Center) {
            Text(
                text = stringResource(R.string.meeting_transcript_empty),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        return
    }

    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        items(segments, key = { it.id }) { segment ->
            Column {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        Modifier
                            .size(6.dp)
                            .clip(CircleShape)
                            .background(MaterialTheme.colorScheme.primary)
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(
                        text = speakerLabel(context, segment.speaker),
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
                Text(
                    text = segment.text,
                    style = MaterialTheme.typography.bodyLarge,
                    color = if (segment.isTail()) {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    } else {
                        MaterialTheme.colorScheme.onSurface
                    },
                )
            }
        }
    }
}

@Composable
private fun PermissionGate(denied: Boolean, onRequest: () -> Unit, onCancel: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = stringResource(R.string.meeting_permission_title),
            style = MaterialTheme.typography.titleLarge,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = stringResource(R.string.meeting_permission_body),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (denied) {
            Spacer(Modifier.height(8.dp))
            Text(
                text = stringResource(R.string.meeting_permission_denied),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
            )
        }
        Spacer(Modifier.height(24.dp))
        Button(onClick = onRequest, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.meeting_permission_grant))
        }
        TextButton(onClick = onCancel) {
            Text(stringResource(R.string.action_cancel))
        }
    }
}
