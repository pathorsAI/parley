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
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.pathors.parley.feedback.FeedbackTrigger
import com.pathors.parley.feedback.ProblemSignals
import com.pathors.parley.feedback.RecordingContext
import com.pathors.parley.R
import com.pathors.parley.filing.FilingSuggestionViewModel
import com.pathors.parley.parleyContainer
import com.pathors.parley.audio.MicRecoveryState
import com.pathors.parley.kit.CaptureRecovery
import com.pathors.parley.kit.TranscriptSegment
import com.pathors.parley.meeting.LiveMeeting
import com.pathors.parley.meeting.MeetingFailure
import com.pathors.parley.meeting.MeetingService
import com.pathors.parley.meeting.MeetingSession
import com.pathors.parley.meeting.MeetingState
import com.pathors.parley.meeting.TranscriptionIssue
import com.pathors.parley.screenshot.DemoMode
import com.pathors.parley.screenshot.rememberDemoMeeting
import com.pathors.parley.ui.theme.ParleyTextStyles
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
 * The live meeting: permission gate, consent, transcript, waveform, controls.
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
        var running = MeetingService.activeSession.value
        // A meeting that ended on an earlier visit and was never dismissed (the
        // screen now stays up after Stop, and Back leaves without Done): its
        // outcome was already on screen. This visit is for a new recording, not
        // for reading an old one's status again.
        if (startedIn == null && running != null && isSettled(running.state.value)) {
            MeetingService.clear()
            running = null
        }
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

    // An old meeting's outcome is about to be cleared by the effect above; do
    // not flash it for the frame before that lands.
    val active = session?.takeUnless { startedIn == null && isSettled(it.state.value) }
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
    val navigation by DemoMode.navigation.collectAsState()
    val demo = rememberDemoMeeting(navigation?.scenario ?: DemoMode.MeetingScenario.LIVE)
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
    MeetingContent(
        session = demo,
        onStop = onDone,
        onDiscard = onDone,
        onDone = onDone,
        demoFiling = navigation?.scenario?.takeIf { it.isSettled },
    )
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
    demoFiling: DemoMode.MeetingScenario? = null,
) {
    val state by session.state.collectAsState()
    val segments by session.segments.collectAsState()
    val issue by session.issue.collectAsState()
    val level by session.level.collectAsState()
    val elapsed by session.elapsedMs.collectAsState()
    val micSilenced by session.micSilenced.collectAsState()
    val micRecovery by session.micRecovery.collectAsState()
    val storageLow by session.storageLow.collectAsState()
    val live = isLive(state)

    val filing = rememberFiling(state, segments, demoFiling)
    RecordingStartedHaptic(state)
    val micBack = rememberMicBackNotice(micRecovery)
    val close = {
        MeetingService.clear()
        onDone()
    }
    // The screen stays up once the meeting has an outcome (below), so Back has
    // to be the same way out as Done: let the session go, not leave it behind
    // for the next visit to find.
    BackHandler(enabled = isSettled(state)) { close() }

    if (live) {
        LiveMeetingLayout(
            state = state,
            segments = segments,
            elapsed = elapsed,
            level = level,
            notices = liveNotices(
                micLine = micLine(micRecovery, micSilenced, micBack),
                storageLow = storageLow,
                issue = issue,
            ),
            onStop = onStop,
            onDiscard = onDiscard,
        )
        return
    }

    // After Stop the screen stays: the transcript, the outcome and the filing
    // suggestion are what the user reads next, and iOS keeps all three up until
    // the next recording. It used to close itself 1.2 s after a clean stop,
    // which was long enough to see that *something* had happened and too short
    // to read what — "Synced, and shared to …" or "out of quota" among it.
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp),
    ) {
        Spacer(Modifier.height(16.dp))
        MeetingHeader(elapsed = elapsed, state = state, segments = segments)
        Spacer(Modifier.height(12.dp))
        LiveWaveform(level = level, active = false)

        interruptedFinish(state)?.let { InterruptedOutcome(it, onClose = close) }
        (state as? MeetingState.Failed)?.let { FailedOutcome(it, onClose = close) }
        (state as? MeetingState.Finished)?.let { MicRecoveryPrompt(it, segments, elapsed) }

        Spacer(Modifier.height(16.dp))
        Box(Modifier.weight(1f)) {
            LiveTranscript(segments, state)
        }

        FilingFooter(
            filing = filing,
            showsDone = state is MeetingState.Finished && interruptedFinish(state) == null,
            onDone = close,
            openPicker = demoFiling == DemoMode.MeetingScenario.ADJUST,
        )
        Spacer(Modifier.height(16.dp))
    }
}

/**
 * The meeting while the microphone is (about to be) open: the live transcript
 * on top, and under it the controls, which the user can drag shorter to give
 * the transcript more room — see [LiveControlsPanel].
 *
 * Once the meeting stops the screen goes back to the layout in [MeetingContent]:
 * the outcome, the filing suggestion and the way out are the news then, not the
 * controls.
 */
@Composable
private fun LiveMeetingLayout(
    state: MeetingState,
    segments: List<TranscriptSegment>,
    elapsed: Long,
    level: Float,
    notices: List<PanelNotice>,
    onStop: () -> Unit,
    onDiscard: () -> Unit,
) {
    val context = LocalContext.current
    val recording = state is MeetingState.Recording
    val transcript = {
        TranscriptClipboard.liveTranscript(segments) {
            speakerLabel(context, it.speaker)
        }
    }
    Column(Modifier.fillMaxSize()) {
        Box(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .padding(start = 16.dp, end = 16.dp, top = 16.dp),
        ) {
            LiveTranscript(segments, state)
        }
        LiveControlsPanel(
            readout = LiveReadout(
                recording = recording,
                statusText = if (recording) {
                    stringResource(R.string.meeting_recording_live)
                } else {
                    statusLabel(state)
                },
                elapsedMs = elapsed,
                level = level,
                notices = notices,
            ),
            onStop = onStop,
            onDiscard = onDiscard,
        ) {
            // Copying works mid-meeting on purpose: the reason to grab a line
            // is usually that it was just said.
            CopyTranscriptButton(text = transcript, isEmpty = segments.isEmpty())
            ShareTranscriptButton(text = transcript, isEmpty = segments.isEmpty())
        }
    }
}

/**
 * Everything the live panel has to say about the recording's health, most
 * urgent first: the one microphone line ([micLine]), the storage warning, and a
 * transcription problem.
 */
@Composable
private fun liveNotices(
    micLine: MicLine?,
    storageLow: Boolean,
    issue: TranscriptionIssue?,
): List<PanelNotice> = buildList {
    micLine?.let {
        add(PanelNotice(micLineText(it), if (it.alarming) NoticeTone.ALARM else NoticeTone.INFO))
    }
    if (storageLow) {
        add(PanelNotice(stringResource(R.string.meeting_storage_low), NoticeTone.ALARM))
    }
    issue?.let {
        add(PanelNotice(stringResource(transcriptionIssueRes(it)), transcriptionIssueTone(it)))
    }
}

/**
 * The filing suggestion for this meeting's recording: bound to the meeting
 * destination (so a rotation keeps the offer), told about the recording once
 * the upload has settled, and — in the screenshot demo — seeded instead of
 * asked, because the demo never touches the network.
 */
@Composable
private fun rememberFiling(
    state: MeetingState,
    segments: List<TranscriptSegment>,
    demoFiling: DemoMode.MeetingScenario?,
): FilingSuggestionViewModel {
    val context = LocalContext.current
    val filing: FilingSuggestionViewModel = viewModel(
        factory = FilingSuggestionViewModel.factory(context.parleyContainer, context),
    )
    LaunchedEffect(demoFiling) {
        if (demoFiling != null) {
            filing.seedDemo(
                recordingId = DemoMode.SETTLED_ID,
                suggestion = DemoMode.filingSuggestion(),
                currentTitle = DemoMode.settledTitle(),
                folders = DemoMode.pickerFolders(),
            )
        }
    }
    LaunchedEffect(state) {
        (state as? MeetingState.Finished)?.let { filing.consider(it, segments) }
    }
    return filing
}

/**
 * Under the transcript once the meeting is over: the filing suggestion card
 * and Done — the way out, now that the screen no longer closes itself. Leaving
 * writes nothing; an unanswered offer simply goes with the screen, and the
 * desktop may ask about it later.
 *
 * @param openPicker the screenshot demo's `adjust` route: "Choose another…"
 *   opened with nobody tapping, as iOS's route does.
 */
@Composable
private fun FilingFooter(
    filing: FilingSuggestionViewModel,
    showsDone: Boolean,
    onDone: () -> Unit,
    openPicker: Boolean,
) {
    LaunchedEffect(openPicker) { if (openPicker) filing.card.openPicker() }
    FilingSuggestionCard(card = filing.card)
    if (showsDone) {
        OutlinedButton(
            onClick = onDone,
            modifier = Modifier
                .fillMaxWidth()
                .defaultMinSize(minHeight = 48.dp),
        ) {
            Text(stringResource(R.string.filing_done))
        }
    }
}

/**
 * The microphone opening. On the transition only, so returning to a meeting
 * already under way (or the screenshot demo, which starts mid-meeting) does
 * not buzz as though it had just begun.
 */
@Composable
private fun RecordingStartedHaptic(state: MeetingState) {
    val view = LocalView.current
    val lastState = remember { StateRef<MeetingState?>(null) }
    LaunchedEffect(state) {
        val before = lastState.value
        lastState.value = state
        if (state is MeetingState.Recording && before is MeetingState.Connecting) {
            MeetingHaptics.recordingStarted(view)
        }
    }
}

/**
 * "Microphone is back" is news for a moment, not a state: true for a few
 * seconds after recovery, then the line goes quiet again. Also buzzes once
 * when the microphone is lost.
 */
@Composable
private fun rememberMicBackNotice(micRecovery: MicRecoveryState): Boolean {
    val view = LocalView.current
    var micBack by remember { mutableStateOf(false) }
    val lastRecovery = remember { StateRef<MicRecoveryState>(micRecovery) }
    LaunchedEffect(micRecovery) {
        val before = lastRecovery.value
        lastRecovery.value = micRecovery
        if (micRecovery is MicRecoveryState.Lost && before !is MicRecoveryState.Lost) {
            MeetingHaptics.microphoneLost(view)
        }
        if (micRecovery is MicRecoveryState.Holding && before !is MicRecoveryState.Holding) {
            micBack = true
            delay(MIC_BACK_NOTICE_MS)
        }
        micBack = false
    }
    return micBack
}

/** The clock, the status line, and the copy/share actions. */
@Composable
private fun MeetingHeader(elapsed: Long, state: MeetingState, segments: List<TranscriptSegment>) {
    val context = LocalContext.current
    val transcript = {
        TranscriptClipboard.liveTranscript(segments) {
            speakerLabel(context, it.speaker)
        }
    }
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
        CopyTranscriptButton(text = transcript, isEmpty = segments.isEmpty())
        ShareTranscriptButton(text = transcript, isEmpty = segments.isEmpty())
    }
}

/**
 * "The microphone was interrupted n times during this recording" — at the end
 * of a meeting whose capture had to win the microphone back five or more times
 * ([ProblemSignals.isMicRecoveryWorthAsking]). Asked here, while the person is
 * still looking at the meeting it happened in, because this is the failure
 * 1.13 shipped: the input rebuilt itself in a loop, the transcript came back
 * empty, and nobody told us for ten days.
 *
 * Once per recording, through the app's frequency limits; leaving the screen
 * without answering counts as brushing it off.
 */
@Composable
private fun MicRecoveryPrompt(finished: MeetingState.Finished, segments: List<TranscriptSegment>, elapsedMs: Long) {
    val id = finished.recordingId ?: return
    if (!ProblemSignals.isMicRecoveryWorthAsking(finished.micRecoveries)) return
    val feedback = rememberContainer().feedback
    var showing by remember(id) { mutableStateOf(false) }
    LaunchedEffect(id) {
        showing = feedback.claimPrompt(FeedbackTrigger.MIC_RECOVERY, id)
    }
    val stillShowing by rememberUpdatedState(showing)
    DisposableEffect(id) {
        onDispose { if (stillShowing) feedback.promptIgnored(FeedbackTrigger.MIC_RECOVERY) }
    }
    if (!showing) return
    Spacer(Modifier.height(12.dp))
    DiagnosticsPrompt(
        text = pluralStringResource(R.plurals.feedback_mic_recovery, finished.micRecoveries, finished.micRecoveries),
        onSend = {
            val finals = segments.filter { it.isFinal && !it.isTail() }
            feedback.send(
                FeedbackTrigger.MIC_RECOVERY,
                RecordingContext(
                    recordingId = id,
                    recordingDurationMs = elapsedMs,
                    transcriptSegments = finals.size,
                    lastSegmentEndMs = finals.maxOfOrNull { it.endMs } ?: 0L,
                    audioRoute = finished.audioRoute,
                    micRecoveries = finished.micRecoveries,
                ),
            )
            showing = false
        },
        onDismiss = {
            feedback.promptIgnored(FeedbackTrigger.MIC_RECOVERY)
            showing = false
        },
    )
}

/** A meeting the user did not end: say so, say where the audio went, and wait. */
@Composable
private fun InterruptedOutcome(finished: MeetingState.Finished, onClose: () -> Unit) {
    Spacer(Modifier.height(12.dp))
    Text(
        text = stringResource(R.string.meeting_interrupted),
        style = MaterialTheme.typography.bodyMedium,
    )
    Text(
        text = finishedOutcomeText(finished),
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    TextButton(onClick = onClose) {
        Text(stringResource(R.string.action_close))
    }
}

@Composable
private fun FailedOutcome(failed: MeetingState.Failed, onClose: () -> Unit) {
    Spacer(Modifier.height(12.dp))
    Text(
        text = failureMessage(failed.reason),
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.error,
    )
    TextButton(onClick = onClose) {
        Text(stringResource(R.string.action_close))
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
 * An outlined capsule with a trash glyph, as iOS draws it since #381
 * (`LiveView.discardControl`). It used to be a line of grey text, which was
 * indistinguishable from the explanatory prose on the same screen and had a
 * tap target one line tall. Ink and a hairline say "tappable" without saying
 * "recommended": not red, because Stop above it is already the screen's one
 * red thing, and not blue, because blue here would be the app recommending
 * that you throw the meeting away. The red belongs in the confirmation, which
 * has it. 44dp tall at the least, whatever the text size.
 *
 * The throwing-away goes through [MeetingService.requestDiscard], which is the
 * only path in the app that deletes a recording. It used to ride on disposal
 * instead, and that stopped being safe the moment every other ending learned to
 * preserve the audio: the dialog would still promise nothing was saved while the
 * `.ogg` sat in the cache directory.
 */
@Composable
internal fun DiscardControl(onDiscard: () -> Unit, modifier: Modifier = Modifier) {
    val view = LocalView.current
    var confirming by rememberSaveable { mutableStateOf(false) }
    val label = stringResource(R.string.meeting_discard)
    // TalkBack has no separate hint slot, so the iOS label and hint are read
    // as two sentences: what the button is, then what pressing it does.
    val spoken = stringResource(R.string.meeting_discard_a11y)
    val capsule = RoundedCornerShape(percent = 50)
    Row(
        modifier = modifier
            .padding(top = 4.dp)
            .heightIn(min = 44.dp)
            .clip(capsule)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, capsule)
            .clickable(role = Role.Button) { confirming = true }
            .clearAndSetSemantics { contentDescription = spoken }
            .padding(horizontal = 18.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = Icons.Outlined.Delete,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.size(18.dp),
        )
        Spacer(Modifier.width(6.dp))
        Text(
            text = label,
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.onSurface,
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
                    MeetingHaptics.recordingDiscarded(view)
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
        state.interruptedBy != null -> stoppedEarlyLabel(state.interruptedBy)
        else -> finishedOutcomeText(state)
    }

    is MeetingState.Failed -> failureMessage(state.reason)
}

/** Where a finished meeting ended up, in iOS's words — see [finishedOutcome]. */
@Composable
private fun finishedOutcomeText(finished: MeetingState.Finished): String =
    when (val outcome = finishedOutcome(finished)) {
        is FinishedOutcome.SharedTo -> stringResource(finishedOutcomeRes(outcome), outcome.org)
        else -> stringResource(finishedOutcomeRes(outcome))
    }

/**
 * How a meeting ended when the user was not the one who ended it — the status
 * line of an interrupted [MeetingState.Finished].
 */
@Composable
private fun stoppedEarlyLabel(reason: MeetingFailure): String = stringResource(
    when (reason) {
        MeetingFailure.MIC_UNAVAILABLE -> R.string.meeting_stopped_mic
        MeetingFailure.MIC_PERMISSION -> R.string.meeting_stopped_mic_permission
        MeetingFailure.STORAGE_FULL -> R.string.meeting_stopped_storage
        MeetingFailure.NOT_SIGNED_IN,
        MeetingFailure.ENCODER_UNAVAILABLE,
        MeetingFailure.UPLOAD_FAILED,
        MeetingFailure.UNKNOWN,
        -> R.string.meeting_stopped_other
    }
)

/** The copy for one microphone line; which line to show is [micLine]'s call. */
@Composable
private fun micLineText(line: MicLine): String = when (line) {
    is MicLine.Lost -> when (val loss = line.loss) {
        CaptureRecovery.Loss.TakenBySystem -> stringResource(R.string.meeting_mic_lost_taken)
        is CaptureRecovery.Loss.Broken -> loss.description
            ?.let { stringResource(R.string.meeting_mic_lost_broken_detail, it) }
            ?: stringResource(R.string.meeting_mic_lost_broken)
    }

    MicLine.Recovering -> stringResource(R.string.meeting_mic_recovering)
    MicLine.Silenced -> stringResource(R.string.meeting_mic_silenced)
    MicLine.Back -> stringResource(R.string.meeting_mic_back)
}

/**
 * A plain mutable box for the previous value an effect compares against. Not
 * snapshot state on purpose: writing it must not recompose anything.
 */
internal class StateRef<T>(var value: T)

/** How long "Microphone is back" stays up after a recovery. */
private const val MIC_BACK_NOTICE_MS = 4_000L

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

@Composable
private fun LiveTranscript(segments: List<TranscriptSegment>, state: MeetingState) {
    val context = LocalContext.current
    val listState = rememberLazyListState()

    LaunchedEffect(segments.size) {
        if (segments.isNotEmpty()) listState.animateScrollToItem(segments.lastIndex)
    }

    LaunchedEffect(listState) { listState.stayOnNewestAcrossResizes() }

    if (segments.isEmpty()) {
        Box(Modifier.fillMaxSize(), Alignment.Center) {
            Text(
                text = stringResource(emptyTranscriptRes(state)),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .widthIn(max = 320.dp)
                    .padding(horizontal = 8.dp),
            )
        }
        return
    }

    val current = currentSpeakingId(segments)
    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        items(segments, key = { it.id }) { segment ->
            TranscriptLine(
                segment = segment,
                speaker = speakerLabel(context, segment.speaker),
                isCurrent = segment.id == current,
            )
        }
    }
}

/**
 * The controls under the transcript can be dragged taller or shorter mid-
 * meeting. A reader who was on the newest line stays on it while the viewport
 * changes size; one who had scrolled back is left where they were.
 */
private suspend fun LazyListState.stayOnNewestAcrossResizes() {
    var lastHeight = 0
    var atEnd = true
    snapshotFlow { layoutInfo.viewportSize.height to canScrollForward }
        .collect { (height, moreBelow) ->
            val resized = lastHeight != 0 && height != lastHeight
            lastHeight = height
            if (resized && atEnd) scrollToNewest() else atEnd = !moreBelow
        }
}

private suspend fun LazyListState.scrollToNewest() {
    val last = layoutInfo.totalItemsCount - 1
    if (last >= 0) scrollToItem(last)
}

/**
 * One turn of the live transcript: who, when, and what — the same three facts
 * in the same order as the detail screen and the clipboard. iOS `SegmentRow`.
 *
 * The speaker is plain text, not a coloured mark. There used to be a blue dot
 * on every line, which spent the one signal colour on something that was not
 * happening: blue here means *now*, so only [isCurrent] — the turn the provider
 * has not finalised, the only thing on screen that is still being said — gets
 * it, on its label.
 *
 * The words are selectable, the tentative tail included: a phrase is worth
 * grabbing the second it appears, and whether the provider has finalised it yet
 * is not something the person holding the phone can see. A long press anywhere
 * else on the turn — the label, the clock, the space around them — offers Copy
 * of the whole turn, header included, which selection cannot reach because the
 * speaker and the clock are separate texts.
 */
@Composable
private fun TranscriptLine(segment: TranscriptSegment, speaker: String, isCurrent: Boolean) {
    val context = LocalContext.current
    val clipLabel = stringResource(R.string.transcript_clip_label)
    val copyLabel = stringResource(R.string.action_copy)
    var menuOpen by remember { mutableStateOf(false) }
    val copyTurn = {
        TranscriptClipboard.write(
            context,
            TranscriptClipboard.plainText(segment, speaker),
            clipLabel,
        )
    }
    Box {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .pointerInput(segment.id) {
                    detectTapGestures(onLongPress = { menuOpen = true })
                }
                .semantics {
                    onLongClick(label = copyLabel) {
                        menuOpen = true
                        true
                    }
                },
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = speaker,
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = if (isCurrent) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    text = formatClock(segment.startMs),
                    style = ParleyTextStyles.caption2.copy(fontFeatureSettings = "tnum"),
                    color = MaterialTheme.colorScheme.outline,
                )
            }
            Spacer(Modifier.height(4.dp))
            SelectionContainer {
                Text(
                    text = segment.text,
                    style = MaterialTheme.typography.bodyLarge,
                    // One step back in the ink rather than italic: the tail has
                    // not settled, and a slant is something the CJK faces lack.
                    color = if (segment.isFinal) {
                        MaterialTheme.colorScheme.onSurface
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                )
            }
        }
        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
            DropdownMenuItem(
                text = { Text(copyLabel) },
                enabled = segment.text.isNotEmpty(),
                onClick = {
                    menuOpen = false
                    copyTurn()
                },
            )
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
