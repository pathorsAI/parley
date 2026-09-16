package com.pathors.parley.ui

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
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
import androidx.compose.foundation.layout.defaultMinSize
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.app.ActivityCompat
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
import com.pathors.parley.ui.theme.ParleyTheme
import com.pathors.parley.screenshot.rememberDemoMeeting
import java.util.UUID
import kotlinx.coroutines.delay

/**
 * Identifies the OS process this composition is running in.
 *
 * A [rememberSaveable] value written before the process was killed comes back
 * not matching, which is the only reliable way this screen can tell a rotation
 * (same process, the service and its session are still there) from a restore
 * after process death (new process, everything in memory is gone). See
 * [MeetingScreen] — getting that distinction wrong is what made the app start
 * recording on its own.
 */
private object ProcessId {
    val value: String = UUID.randomUUID().toString()
}

/**
 * The live meeting: permission gate, consent, transcript, level meter, controls.
 *
 * The screen owns none of the recording. It asks [MeetingService] to start,
 * observes the [MeetingSession] the service publishes, and asks it to stop —
 * which is what lets the user leave this screen (or the app) mid-meeting without
 * the capture noticing.
 *
 * ## Nothing here ever starts the microphone by itself
 *
 * Two facts used to combine into an app that recorded a room nobody had pointed
 * it at. `rememberNavController` saves the back stack into the
 * `SavedStateRegistry`, so a process killed while a meeting was on screen is
 * restored straight back onto this destination; and the "start at most once"
 * latch was a plain `remember`, which resets to false in the new process where
 * `MeetingService.activeSession` is also null. The start effect then read that
 * as "nothing is recording and nobody has started one yet" and opened the mic.
 * The user's own account of it: *I opened Parley and it was recording.*
 *
 * So the latch is a [rememberSaveable] carrying [ProcessId] rather than a
 * boolean, and a value from a dead process means *leave*, not *start*. On top of
 * that the only thing that can now reach `MeetingService.start` at all is the
 * user pressing through [RecordingConsentDialog].
 */
@Composable
fun MeetingScreen(onDone: () -> Unit) {
    val context = LocalContext.current
    val session by MeetingService.activeSession.collectAsState()

    if (DemoMode.isActive) {
        DemoMeetingScreen(onDone = onDone)
        return
    }

    val mic = rememberMicPermission()

    // Start at most once per visit, and remember *which process* did it. A plain
    // boolean cannot tell a restored back stack from a rotation; see the class
    // docs for what that cost.
    var startedIn by rememberSaveable { mutableStateOf<String?>(null) }
    val restored = startedIn != null && startedIn != ProcessId.value
    var consenting by rememberSaveable { mutableStateOf(false) }

    // The meeting this screen was showing did not survive the process. There is
    // nothing to rejoin and nothing to resume, so leave — silently opening the
    // microphone again is exactly the bug.
    LaunchedEffect(restored) {
        if (restored) onDone()
    }

    // Ask before recording, never instead of asking — see [shouldRequestConsent].
    LaunchedEffect(mic.granted, restored) {
        val running = MeetingService.activeSession.value
        if (shouldRequestConsent(mic.granted, restored, startedIn, running)) consenting = true
    }

    if (!mic.granted) {
        PermissionGate(
            denied = mic.denied,
            blocked = mic.blocked,
            onRequest = mic.onRequest,
            onOpenSettings = mic.onOpenSettings,
            onCancel = onDone,
        )
        return
    }

    if (consenting) {
        RecordingConsentDialog(
            onConfirm = {
                consenting = false
                startedIn = ProcessId.value
                MeetingService.start(context)
            },
            onCancel = {
                consenting = false
                onDone()
            },
        )
    }

    val active = session
    if (active == null) {
        // Nothing is starting while the consent dialog is up or while we are on
        // our way out, and a spinner under either would claim otherwise.
        MeetingStartingIndicator(spinning = !consenting && !restored)
        return
    }

    MeetingContent(
        session = active,
        onStop = { MeetingService.requestStop(context) },
        // Not `clear()`: disposal stopped deleting the audio when the failure
        // paths learned to preserve it, so the only thing that still keeps the
        // dialog's promise is an action that means exactly this.
        onDiscard = {
            MeetingService.requestDiscard(context)
            onDone()
        },
        onDone = onDone,
    )
}

/**
 * Whether arriving on this screen should ask the user to consent to a recording.
 *
 * This predicate is the whole guard in front of `MeetingService.start`, so the
 * answer is no unless every one of these holds: the microphone is ours; this
 * composition is not a back stack [restored] into a new process (see
 * [MeetingScreen] — telling that apart from a rotation is what stopped the app
 * recording on its own); this visit has not already started a meeting; and there
 * is no [running] meeting to adopt.
 *
 * That last one is why a meeting already in progress (the user came back through
 * the library's "Return to it") is adopted without a second consent — they
 * consented when it started.
 */
private fun shouldRequestConsent(
    granted: Boolean,
    restored: Boolean,
    startedIn: String?,
    running: MeetingSession?,
): Boolean = granted && !restored && startedIn == null && running == null

/**
 * Store screenshots: scripted segments on a timer, no permission prompt, no
 * microphone — an emulator has no audio input, and a capture must never depend
 * on one.
 */
@Composable
private fun DemoMeetingScreen(onDone: () -> Unit) {
    val context = LocalContext.current
    val demo = rememberDemoMeeting()
    // One exception, for the Play foreground-service declaration video: if
    // RECORD_AUDIO happens to be granted already, run the real service in
    // notification-only mode so the ongoing notification can be filmed. A plain
    // screenshot run never grants it, so it stays notification-free; the video
    // run grants it deliberately via `adb shell pm grant`. See
    // `MeetingService.startDemoNotification`.
    if (context.hasRecordAudioPermission()) {
        DisposableEffect(Unit) {
            MeetingService.startDemoNotification(context, demo.elapsedMs.value)
            onDispose { MeetingService.requestStop(context) }
        }
    }
    // Discard leaves the demo screen exactly as Stop does — there is no session
    // to throw away, and the affordance belongs in the screenshot.
    MeetingContent(session = demo, onStop = onDone, onDiscard = onDone, onDone = onDone)
}

/** Waiting for the service to publish the session the consent dialog asked for. */
@Composable
private fun MeetingStartingIndicator(spinning: Boolean) {
    Box(Modifier.fillMaxSize(), Alignment.Center) {
        if (spinning) CircularProgressIndicator()
    }
}

/**
 * Whether the microphone is ours, plus the two ways of going to ask for it.
 *
 * The three flags travel together because they are only ever written from the
 * launcher callbacks in [rememberMicPermission] — and [blocked] may only be
 * *read* from there, which is the whole reason that callback is where it is.
 */
private class MicPermission(
    val granted: Boolean,
    val denied: Boolean,
    val blocked: Boolean,
    val onRequest: () -> Unit,
    val onOpenSettings: () -> Unit,
)

@Composable
private fun rememberMicPermission(): MicPermission {
    val context = LocalContext.current
    val activity = remember(context) { context.findActivity() }

    var granted by remember { mutableStateOf(context.hasRecordAudioPermission()) }
    var denied by remember { mutableStateOf(false) }

    // Denied so firmly that the system will not ask again — see [PermissionGate].
    var blocked by remember { mutableStateOf(false) }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { result ->
        // POST_NOTIFICATIONS only decides whether the ongoing notification is
        // visible; the recording itself hangs on RECORD_AUDIO alone.
        val ok = result[Manifest.permission.RECORD_AUDIO] == true
        granted = ok
        denied = !ok
        // From Android 11 a second refusal is permanent: the platform stops
        // showing the dialog and `launch()` returns a denial without the user
        // ever seeing anything. The only signal that has happened is the
        // rationale flag going false *after* a denial, so it is read here and
        // nowhere else — before the first request it is false too, and acting on
        // that would send a first-time user to system settings.
        blocked = !ok && activity != null &&
            !ActivityCompat.shouldShowRequestPermissionRationale(
                activity,
                Manifest.permission.RECORD_AUDIO,
            )
    }

    // Coming back from the app's own settings page. The switch may have been
    // flipped while we were away and nothing else re-reads it — without this the
    // user grants the permission, returns, and is still staring at the gate.
    val settingsLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        granted = context.hasRecordAudioPermission()
        if (granted) {
            denied = false
            blocked = false
        }
    }

    return MicPermission(
        granted = granted,
        denied = denied,
        blocked = blocked,
        onRequest = { permissionLauncher.launch(requiredPermissions()) },
        onOpenSettings = { settingsLauncher.launch(appSettingsIntent(context)) },
    )
}

private fun Context.hasRecordAudioPermission(): Boolean =
    ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
        PackageManager.PERMISSION_GRANTED

private fun requiredPermissions(): Array<String> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS)
    } else {
        arrayOf(Manifest.permission.RECORD_AUDIO)
    }

/** This app's page in system Settings, where a permanent denial can be undone. */
private fun appSettingsIntent(context: Context): Intent = Intent(
    Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
    Uri.fromParts("package", context.packageName, null),
)

/**
 * The hosting [Activity], which `shouldShowRequestPermissionRationale` requires.
 * A Compose `LocalContext` is not always one: under a theme overlay it is a
 * `ContextWrapper` around it.
 */
private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

@Composable
private fun MeetingContent(
    session: LiveMeeting,
    onStop: () -> Unit,
    onDiscard: () -> Unit,
    onDone: () -> Unit,
) {
    val context = LocalContext.current
    val state by session.state.collectAsState()
    val segments by session.segments.collectAsState()
    val issue by session.issue.collectAsState()
    val level by session.level.collectAsState()
    val elapsed by session.elapsedMs.collectAsState()
    val micSilenced by session.micSilenced.collectAsState()

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
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
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
            }
            // Copying works mid-meeting on purpose: the reason to grab a line is
            // usually that it was just said.
            CopyTranscriptButton(
                text = {
                    TranscriptClipboard.liveTranscript(segments) {
                        speakerLabel(context, it.speaker)
                    }
                },
                isEmpty = segments.isEmpty(),
            )
            ShareTranscriptButton(
                text = {
                    TranscriptClipboard.liveTranscript(segments) {
                        speakerLabel(context, it.speaker)
                    }
                },
                isEmpty = segments.isEmpty(),
            )
        }
        Spacer(Modifier.height(12.dp))
        LevelMeter(level = level, live = state is MeetingState.Recording)

        // Louder than the transcription banner on purpose: a silenced mic means
        // the audio itself is empty, which is the one failure nothing later can
        // recover from.
        if (micSilenced) {
            Spacer(Modifier.height(12.dp))
            Text(
                text = stringResource(R.string.meeting_mic_silenced),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
            )
        }

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
                    // A minimum, not a height: at the largest accessibility font
                    // a fixed 56.dp clips the label it exists to show.
                    .defaultMinSize(minHeight = 56.dp)
                    .padding(vertical = 4.dp),
                colors = ButtonDefaults.buttonColors(
                    // The recording red, not the error red. Since the brand
                    // palette landed these mean different things: this button is
                    // the state of the recording, not a fault.
                    containerColor = ParleyTheme.colors.recording,
                    contentColor = MaterialTheme.colorScheme.onError,
                ),
            ) {
                Text(stringResource(R.string.action_stop))
            }
            DiscardControl(
                onDiscard = onDiscard,
                modifier = Modifier.align(Alignment.CenterHorizontally),
            )
        }
        Spacer(Modifier.height(16.dp))
    }
}

/**
 * The way out for a recording that should not have started.
 *
 * Stop means *keep this*: it finalizes the audio, uploads it and puts a row in
 * the library. Until this existed a mis-tap had no other exit at all — the
 * recording had to be stopped, uploaded, and then lived in the library forever,
 * because single-recording deletion did not exist either.
 *
 * Plain secondary text under the stop button rather than a second button, for
 * the same reason iOS does it that way (`LiveView.discardControl`): it must be
 * findable without ever competing with Stop for the thumb. And a confirmation,
 * because it throws the audio away.
 *
 * The throwing-away goes through [MeetingService.requestDiscard], which is the
 * only path in the app that deletes a recording. It used to ride on disposal
 * instead, and that stopped being safe the moment every other ending learned to
 * preserve the audio: the dialog would still promise nothing was saved while the
 * `.ogg` sat in the cache directory.
 */
@Composable
private fun DiscardControl(onDiscard: () -> Unit, modifier: Modifier = Modifier) {
    var confirming by rememberSaveable { mutableStateOf(false) }
    val label = stringResource(R.string.meeting_discard)
    TextButton(
        onClick = { confirming = true },
        modifier = modifier.semantics { contentDescription = label },
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text(stringResource(R.string.meeting_discard_title)) },
            text = { ScrollingDialogText(stringResource(R.string.meeting_discard_body)) },
            confirmButton = {
                TextButton(onClick = {
                    confirming = false
                    onDiscard()
                }) {
                    Text(
                        text = stringResource(R.string.meeting_discard_confirm),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { confirming = false }) {
                    Text(stringResource(R.string.action_cancel))
                }
            },
        )
    }
}

/**
 * What the user agrees to before the microphone opens.
 *
 * Not a nicety and not a UX flourish: the phone is about to pick up everyone in
 * the room and stream them to a server, and in most of the places Parley is used
 * that needs everyone's agreement, not just the holder's. So the confirming
 * button says "Everyone has agreed" rather than "OK" — the same wording as iOS
 * (`LiveView`), because a button labelled OK records nothing but a reflex.
 */
@Composable
private fun RecordingConsentDialog(onConfirm: () -> Unit, onCancel: () -> Unit) {
    AlertDialog(
        onDismissRequest = onCancel,
        title = { Text(stringResource(R.string.meeting_consent_title)) },
        text = { ScrollingDialogText(stringResource(R.string.meeting_consent_body)) },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(stringResource(R.string.meeting_consent_confirm))
            }
        },
        dismissButton = {
            TextButton(onClick = onCancel) {
                Text(stringResource(R.string.action_cancel))
            }
        },
    )
}

/**
 * Dialog body copy that stays readable at the largest font scale: an
 * `AlertDialog` clips its text slot rather than scrolling it, and these two
 * dialogs are the ones whose whole point is the paragraph.
 */
@Composable
private fun ScrollingDialogText(text: String) {
    Text(
        text = text,
        modifier = Modifier.verticalScroll(rememberScrollState()),
    )
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
    MeetingFailure.STORAGE_FULL -> stringResource(R.string.failure_storage_full)
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

/**
 * Why there is no microphone yet, and what to do about it.
 *
 * [blocked] is the case this screen used to have no answer for. Android 11+
 * treats a second refusal as final: the system dialog never appears again and
 * `permissionLauncher.launch()` returns a denial without showing anything, so a
 * "Allow microphone" button becomes a control that does *nothing at all* when
 * pressed. The only remaining route is the app's page in system Settings, so
 * that is what the button becomes.
 */
@Composable
private fun PermissionGate(
    denied: Boolean,
    blocked: Boolean,
    onRequest: () -> Unit,
    onOpenSettings: () -> Unit,
    onCancel: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            // The copy grows with the font scale and grows again when the denial
            // lines appear; without this it is simply cut off at the bottom.
            .verticalScroll(rememberScrollState())
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
                text = stringResource(
                    if (blocked) R.string.meeting_permission_blocked
                    else R.string.meeting_permission_denied
                ),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
            )
        }
        Spacer(Modifier.height(24.dp))
        if (blocked) {
            Button(onClick = onOpenSettings, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.meeting_permission_settings))
            }
        } else {
            Button(onClick = onRequest, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.meeting_permission_grant))
            }
        }
        TextButton(onClick = onCancel) {
            Text(stringResource(R.string.action_cancel))
        }
    }
}
