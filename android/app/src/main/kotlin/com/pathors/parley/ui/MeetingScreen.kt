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
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.pathors.parley.R
import com.pathors.parley.audio.MicRecoveryState
import com.pathors.parley.feedback.AudioRouteLabel
import com.pathors.parley.feedback.FeedbackTrigger
import com.pathors.parley.feedback.ProblemSignals
import com.pathors.parley.feedback.RecordingContext
import com.pathors.parley.kit.CaptureRecovery
import com.pathors.parley.kit.TranscriptSegment
import com.pathors.parley.library.FolderDirectory
import com.pathors.parley.library.FolderScope
import com.pathors.parley.library.SaveDestination
import com.pathors.parley.meeting.ChosenFolder
import com.pathors.parley.meeting.DraftSnapshot
import com.pathors.parley.meeting.EndedMeeting
import com.pathors.parley.meeting.EndedMeetings
import com.pathors.parley.meeting.LiveMeeting
import com.pathors.parley.meeting.MeetingDraft
import com.pathors.parley.meeting.MeetingFailure
import com.pathors.parley.meeting.MeetingService
import com.pathors.parley.meeting.MeetingState
import com.pathors.parley.meeting.TranscriptionIssue
import com.pathors.parley.screenshot.DemoMode
import com.pathors.parley.screenshot.rememberDemoMeeting
import com.pathors.parley.ui.theme.ParleyTextStyles
import com.pathors.parley.ui.theme.ParleyTheme
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

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
 * The record screen: one layout before and during a meeting, after the
 * desktop's meeting window and iOS's Record tab (#759).
 *
 * What the meeting *is* sits on top — its name (with Copy beside it), its day
 * and its folder — then the transcript on a muted panel, and everything you
 * *do* in one dock along the bottom, under the thumb: the clock and the
 * microphone, the live waveform, and the actions. Before a meeting the dock
 * holds a resting clock, a flat waveform and one Start recording; during one,
 * ✕ (discard), Pause and End. Pressing Start changes what is in the dock, not
 * where anything is. The name and folder can be set before the meeting starts
 * and are saved with the recording ([MeetingDraft]).
 *
 * End, as on the desktop, ends on the recording's result page: once the upload
 * settles the meeting is handed over ([EndedMeetings]) and [onEnded] opens it,
 * with the filing suggestion on top. An upload that does not settle (offline,
 * the quota, a refusal, too short) stays here with its status line.
 *
 * The screen owns none of the recording. It asks [MeetingService] to start,
 * observes the [com.pathors.parley.meeting.MeetingSession] the service
 * publishes, and asks it to stop — which is what lets the user leave this
 * screen (or the app) mid-meeting without the capture noticing.
 *
 * ## Nothing here ever starts the microphone by itself
 *
 * Two facts once combined into an app that recorded a room nobody had pointed
 * it at: `rememberNavController` saves the back stack, so a process killed
 * while this screen was up is restored straight back onto it, and the start
 * latch was a plain `remember` that reset in the new process. The user's own
 * account of it: *I opened Parley and it was recording.*
 *
 * A meeting now starts only from a press — Start recording here, or a start
 * request that arrived with the visit ([autoStart]: the lock-screen tile, the
 * launcher shortcut, the onboarding's last step) — and a press is honoured
 * only in the process that saw it. A visit restored into a new process is the
 * screen before a meeting, never a start.
 *
 * There is no "has everyone agreed?" prompt in front of it. Getting the room's
 * permission is the person holding the phone's call, as it is with any other
 * recorder, and a dialog every single time taught nothing but a reflex tap.
 *
 * @param autoStart start a meeting on arrival, as if Start had been pressed.
 * @param onDone leave the screen (Back over a meeting's outcome).
 * @param onEnded open the result page of the recording that just landed.
 */
@Composable
fun MeetingScreen(
    autoStart: Boolean,
    onDone: () -> Unit,
    onEnded: (recordingId: String) -> Unit,
) {
    if (DemoMode.isActive) {
        DemoMeetingScreen()
        return
    }

    val context = LocalContext.current
    val session by MeetingService.activeSession.collectAsState()
    val mic = rememberMicPermission()

    // Which process this visit began in. Saved, so a visit restored after
    // process death reads as one, and is never a start.
    val visit = rememberSaveable { ProcessId.value }
    val restored = visit != ProcessId.value
    var wantsStart by rememberSaveable { mutableStateOf(autoStart) }
    // Between asking the service to start and it publishing the session: the
    // meeting's layout, connecting, rather than the screen before a meeting.
    var awaitingSession by remember { mutableStateOf(false) }

    LaunchedEffect(session) { if (session != null) awaitingSession = false }

    LaunchedEffect(wantsStart, mic.granted) {
        if (!wantsStart) return@LaunchedEffect
        when {
            restored -> wantsStart = false
            // Asked once per press; after a refusal the gate below takes over.
            !mic.granted -> if (!mic.denied) mic.onRequest()
            else -> {
                wantsStart = false
                // The last meeting's outcome (still on the phone, too short)
                // gives way to the next one.
                MeetingService.activeSession.value?.let { if (isSettled(it.state.value)) MeetingService.clear() }
                if (MeetingService.activeSession.value == null) {
                    awaitingSession = true
                    MeetingService.start(context)
                }
            }
        }
    }

    if (wantsStart && !mic.granted && mic.denied) {
        PermissionGate(
            denied = true,
            blocked = mic.blocked,
            onRequest = mic.onRequest,
            onOpenSettings = mic.onOpenSettings,
            onCancel = {
                wantsStart = false
                // A draft's start that will not happen: its name, folder and
                // context are not the next meeting's.
                MeetingDraft.dropDraft()
            },
        )
        return
    }

    val shown = session
    val shownState by (shown?.state ?: NoMeeting.state).collectAsState()
    // The screen stays up once a meeting has an outcome that is not a result
    // page, so Back has to let the session go rather than leave it behind for
    // the next visit to find.
    BackHandler(enabled = shown != null && isSettled(shownState)) {
        MeetingService.clear()
        onDone()
    }

    MeetingContent(
        session = shown,
        awaitingSession = awaitingSession,
        actions = MeetingActions(
            onStart = { wantsStart = true },
            onStop = { MeetingService.requestStop(context) },
            // Not `clear()`: disposal stopped deleting the audio when the
            // failure paths learned to preserve it, so the only thing that
            // still keeps the dialog's promise is an action that means exactly
            // this. The screen stays, before the next meeting.
            onDiscard = { MeetingService.requestDiscard(context) },
            onTogglePause = {
                if (shown?.state?.value == MeetingState.Paused) {
                    MeetingService.requestResume(context)
                } else {
                    MeetingService.requestPause(context)
                }
            },
        ),
        onEnded = { meeting ->
            EndedMeetings.hand(meeting)
            // The result page has it now; this screen is the next meeting's.
            MeetingService.clear()
            onEnded(meeting.recordingId)
        },
    )
}

/**
 * Store screenshots: scripted segments on a timer, no permission prompt, no
 * microphone — an emulator has no audio input, and a capture must never depend
 * on one. `record-idle` is the screen before a meeting; every other scenario a
 * meeting named and filed here, as iOS seeds its own.
 */
@Composable
private fun DemoMeetingScreen() {
    val context = LocalContext.current
    val navigation by DemoMode.navigation.collectAsState()
    val scenario = navigation?.scenario ?: DemoMode.MeetingScenario.LIVE
    // Keyed on the request, not only its scenario: a second draft started in
    // the demo is a new request with the same scenario and other choices.
    LaunchedEffect(navigation) {
        when (scenario) {
            DemoMode.MeetingScenario.IDLE -> MeetingDraft.clear()
            DemoMode.MeetingScenario.DRAFT -> MeetingDraft.seed(navigation?.draftChoices ?: DemoMode.draftChoices())
            else -> MeetingDraft.seed(DemoMode.liveChoices())
        }
    }
    val inactive = MeetingActions(onStart = {}, onStop = {}, onDiscard = {}, onTogglePause = {})
    if (scenario == DemoMode.MeetingScenario.IDLE) {
        MeetingContent(session = null, awaitingSession = false, actions = inactive, onEnded = null)
        return
    }
    val demo = rememberDemoMeeting(scenario)
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
    MeetingContent(session = demo, awaitingSession = false, actions = inactive, onEnded = null)
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

/** What the screen's controls do: start a meeting, end it, throw it away, pause or resume it. */
private class MeetingActions(
    val onStart: () -> Unit,
    val onStop: () -> Unit,
    val onDiscard: () -> Unit,
    val onTogglePause: () -> Unit,
)

/** The flows a screen with no meeting reads: nothing said, nothing heard, the clock at rest. */
private object NoMeeting {
    val state: StateFlow<MeetingState> = MutableStateFlow(MeetingState.Idle)
    val connecting: StateFlow<MeetingState> = MutableStateFlow(MeetingState.Connecting)
    val segments: StateFlow<List<TranscriptSegment>> = MutableStateFlow(emptyList())
    val issue: StateFlow<TranscriptionIssue?> = MutableStateFlow(null)
    val level: StateFlow<Float> = MutableStateFlow(0f)
    val elapsed: StateFlow<Long> = MutableStateFlow(0L)
    val silenced: StateFlow<Boolean> = MutableStateFlow(false)
    val recovery: StateFlow<MicRecoveryState> = MutableStateFlow(MicRecoveryState.Holding)
}

/**
 * The record screen's one layout, for whatever [session] is in (or none).
 *
 * @param onEnded the meeting landed and its result page should open; null in
 *   the screenshot demo, which never leaves.
 */
@Composable
private fun MeetingContent(
    session: LiveMeeting?,
    awaitingSession: Boolean,
    actions: MeetingActions,
    onEnded: ((EndedMeeting) -> Unit)?,
) {
    val state by (session?.state ?: if (awaitingSession) NoMeeting.connecting else NoMeeting.state).collectAsState()
    val segments by (session?.segments ?: NoMeeting.segments).collectAsState()
    val issue by (session?.issue ?: NoMeeting.issue).collectAsState()
    val level by (session?.level ?: NoMeeting.level).collectAsState()
    val elapsed by (session?.elapsedMs ?: NoMeeting.elapsed).collectAsState()
    val micSilenced by (session?.micSilenced ?: NoMeeting.silenced).collectAsState()
    val micRecovery by (session?.micRecovery ?: NoMeeting.recovery).collectAsState()
    val storageLow by (session?.storageLow ?: NoMeeting.silenced).collectAsState()
    val inMeeting = showsMeeting(state)

    RecordingStartedHaptic(state)
    val micBack = rememberMicBackNotice(micRecovery)
    val micLine = micLine(micRecovery, micSilenced, micBack)
    val folders = rememberMeetingFolders(inMeeting)

    // End → the result page, keyed on the upload settling rather than on the
    // meeting ending: the page reads the recording from the cloud, so it
    // cannot open before the upload lands. Until then End keeps its spinner
    // and Start says "Wrapping up…".
    val ended by rememberUpdatedState(onEnded)
    LaunchedEffect(session, state) {
        val finished = state as? MeetingState.Finished ?: return@LaunchedEffect
        val id = finished.recordingId ?: return@LaunchedEffect
        val shown = session ?: return@LaunchedEffect
        val handOff = ended ?: return@LaunchedEffect
        if (!endsOnResultPage(finished)) return@LaunchedEffect
        handOff(EndedMeeting(id, finished, shown.segments.value, shown.elapsedMs.value))
    }

    Column(Modifier.fillMaxSize()) {
        if (inMeeting) {
            WarningStrip(currentWarning(micLine, storageLow, issue))
        }
        // Before a meeting the heading is the next one's: name it and pick its
        // folder now, and the recording starts under them. With the last
        // meeting's transcript still up — an upload that did not settle, so
        // no result page took it — the heading would read as that meeting's,
        // so the page keeps only Copy for it. iOS `LiveView.idleScreen`.
        if (inMeeting || segments.isEmpty()) {
            MeetingHeading(segments = segments, dayMs = System.currentTimeMillis() - elapsed, folders = folders)
        } else {
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), horizontalArrangement = Arrangement.End) {
                TranscriptCopy(segments)
            }
        }
        Box(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 12.dp)
                .clip(PANEL_SHAPE)
                .background(MaterialTheme.colorScheme.surfaceContainer, PANEL_SHAPE),
        ) {
            LiveTranscript(segments, state)
        }
        // Above the dock, not in the transcript: it is about the recording
        // that just ended, and it must not scroll away with the words.
        (state as? MeetingState.Finished)?.takeUnless { endsOnResultPage(it) }?.let { finished ->
            finished.recordingId?.let { id ->
                MicRecoveryPrompt(
                    recordingId = id,
                    micRecoveries = finished.micRecoveries,
                    audioRoute = finished.audioRoute,
                    segments = segments,
                    elapsedMs = elapsed,
                    modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 8.dp),
                )
            }
        }
        HorizontalDivider(thickness = 0.5.dp, color = MaterialTheme.colorScheme.outlineVariant)
        Dock(
            readout = DockReadout(
                state = state,
                elapsed = elapsed,
                level = level,
                issue = issue,
                micAlarming = micLine?.alarming == true,
                inputRoute = session?.inputRoute,
            ),
            actions = actions,
        )
    }
}

/** What the dock shows about the meeting, gathered so [Dock] takes it as one thing. */
private class DockReadout(
    val state: MeetingState,
    val elapsed: Long,
    val level: Float,
    val issue: TranscriptionIssue?,
    val micAlarming: Boolean,
    val inputRoute: String?,
) {
    val inMeeting: Boolean get() = showsMeeting(state)
    val paused: Boolean get() = state == MeetingState.Paused

    /** Chunks are reaching the file: recording, not paused, not fighting for the microphone. */
    val hearing: Boolean get() = state == MeetingState.Recording && !micAlarming
}

private val PANEL_SHAPE = RoundedCornerShape(12.dp)
private val BUTTON_SHAPE = RoundedCornerShape(9.dp)
private val CHIP_SHAPE = RoundedCornerShape(6.dp)

// ── heading ──────────────────────────────────────────────────────────────────

/**
 * The meeting's name, day and folder, as under the desktop's title bar. The
 * name and the folder are the recording's: the session saves it under them.
 */
@Composable
private fun MeetingHeading(segments: List<TranscriptSegment>, dayMs: Long, folders: MeetingFolders) {
    val choices by MeetingDraft.choices.collectAsState()
    val focus = LocalFocusManager.current
    val nameLabel = stringResource(R.string.meeting_name_label)
    Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            BasicTextField(
                value = choices.title,
                onValueChange = MeetingDraft::setTitle,
                singleLine = true,
                textStyle = MaterialTheme.typography.titleLarge.copy(color = MaterialTheme.colorScheme.onSurface),
                cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { focus.clearFocus() }),
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = 44.dp)
                    .semantics { contentDescription = nameLabel },
                decorationBox = { field ->
                    Box(contentAlignment = Alignment.CenterStart) {
                        if (choices.title.isEmpty()) {
                            Text(
                                text = stringResource(R.string.meeting_name_placeholder),
                                style = MaterialTheme.typography.titleLarge,
                                color = MaterialTheme.colorScheme.outline,
                                maxLines = 1,
                            )
                        }
                        field()
                    }
                },
            )
            TranscriptCopy(segments)
        }
        // One line: the day and the folder at the start and, for a meeting
        // started from a draft, a link to the draft at the far end. The link
        // is measured first and never shrinks; the folder chip gets what is
        // left (a long folder name truncates) and the rest is empty space.
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            DateChip(dayMs)
            Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                FolderChip(choices.folder, folders, onOpen = { focus.clearFocus() })
            }
            choices.draft?.let { snapshot ->
                DraftLink(snapshot, onOpen = { focus.clearFocus() })
            }
        }
    }
}

/**
 * At the far end of the chip row, for a meeting started from a meeting draft
 * only: the draft, read-only in a sheet ([MeetingDraftSheet]) — its context and
 * agenda are what the meeting was prepared with, and the reason to look is
 * usually mid-meeting. Not a chip: primary-ink text with the document icon, like
 * the app's other text links, at the chips' type and icon size.
 *
 * The screenshot demo's `record-draft` opens the sheet on arrival
 * ([DemoMode.Navigation.draftSheet]).
 */
@Composable
private fun DraftLink(snapshot: DraftSnapshot, onOpen: () -> Unit) {
    var open by rememberSaveable { mutableStateOf(false) }
    val navigation by DemoMode.navigation.collectAsState()
    LaunchedEffect(navigation?.serial) {
        if (DemoMode.isActive && navigation?.draftSheet == true) open = true
    }
    val spoken = stringResource(R.string.meeting_view_draft)
    Row(
        modifier = Modifier
            .heightIn(min = 48.dp)
            .widthIn(min = 48.dp)
            .clickable(role = Role.Button) {
                onOpen()
                open = true
            }
            .clearAndSetSemantics { contentDescription = spoken }
            .padding(horizontal = 4.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = LibraryIcons.Description,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(14.dp),
        )
        Spacer(Modifier.width(6.dp))
        Text(
            text = stringResource(R.string.meeting_draft_chip),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.primary,
            maxLines = 1,
            softWrap = false,
        )
    }
    if (open) {
        MeetingDraftSheet(draft = snapshot.draft, folder = snapshot.folderName, onDismiss = { open = false })
    }
}

/**
 * Copy, beside the name. Copying works mid-meeting on purpose: the reason to
 * grab a line is usually that it was just said.
 */
@Composable
private fun TranscriptCopy(segments: List<TranscriptSegment>) {
    val context = LocalContext.current
    CopyTranscriptButton(
        text = { TranscriptClipboard.liveTranscript(segments) { speakerLabel(context, it.speaker) } },
        isEmpty = segments.isEmpty(),
    )
}

/** 2026/10/30 — the meeting's day, in the desktop's numeric form, in the primary ink. */
@Composable
private fun DateChip(dayMs: Long) {
    val stamp = remember(dayMs / DAY_MS) { SimpleDateFormat("yyyy/MM/dd", Locale.ROOT).format(Date(dayMs)) }
    Row(
        modifier = Modifier
            .heightIn(min = 26.dp)
            .clip(CHIP_SHAPE)
            .background(MaterialTheme.colorScheme.surfaceContainer, CHIP_SHAPE)
            .padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = Icons.Default.DateRange,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(13.dp),
        )
        Spacer(Modifier.width(6.dp))
        Text(
            text = stamp,
            style = MaterialTheme.typography.labelMedium.copy(fontFeatureSettings = "tnum"),
            color = MaterialTheme.colorScheme.primary,
            maxLines = 1,
        )
    }
}

private const val DAY_MS = 86_400_000L

/**
 * Where the recording will land: dashed with 放進資料夾 while nothing but the
 * personal top level is set, solid with the place once there is one — picked
 * here, or the app's default destination. Tapping it opens the same folder
 * picker the filing card uses, whose confirm is a choice, not a move: there is
 * no recording yet to move.
 */
@Composable
private fun FolderChip(chosen: ChosenFolder?, folders: MeetingFolders, onOpen: () -> Unit) {
    var choosing by rememberSaveable { mutableStateOf(false) }
    val label = chosen?.label ?: folders.defaultLabel
    val shown = label ?: stringResource(R.string.meeting_folder_add)
    val isOrg = (chosen?.destination ?: folders.default).isOrg
    val outline = MaterialTheme.colorScheme.outlineVariant
    val hint = stringResource(R.string.meeting_folder_choose)
    Row(
        modifier = Modifier
            .heightIn(min = 44.dp)
            .clickable(role = Role.Button, onClickLabel = hint) {
                onOpen()
                choosing = true
            }
            .clearAndSetSemantics { contentDescription = shown },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            modifier = Modifier
                .heightIn(min = 26.dp)
                .widthIn(max = 220.dp)
                .clip(CHIP_SHAPE)
                .background(
                    if (label == null) Color.Transparent else MaterialTheme.colorScheme.surfaceContainer,
                    CHIP_SHAPE,
                )
                .dashedOutline(outline, dashed = label == null)
                .padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = if (isOrg) LibraryIcons.Group else LibraryIcons.Folder,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(14.dp),
            )
            Spacer(Modifier.width(6.dp))
            Text(
                text = shown,
                style = MaterialTheme.typography.labelMedium,
                color = if (label == null) {
                    MaterialTheme.colorScheme.onSurfaceVariant
                } else {
                    MaterialTheme.colorScheme.onSurface
                },
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
    if (choosing) {
        MeetingFolderPicker(chosen, folders, onDismiss = { choosing = false })
    }
}

/** A 1 dp hairline round the chip, dashed while nothing is chosen. */
private fun Modifier.dashedOutline(color: Color, dashed: Boolean): Modifier = drawBehind {
    val stroke = 1.dp.toPx()
    val dash = if (dashed) PathEffect.dashPathEffect(floatArrayOf(3.dp.toPx(), 2.dp.toPx())) else null
    drawRoundRect(
        color = color,
        topLeft = Offset(stroke / 2, stroke / 2),
        size = Size(size.width - stroke, size.height - stroke),
        cornerRadius = CornerRadius(6.dp.toPx()),
        style = Stroke(width = stroke, pathEffect = dash),
    )
}

/**
 * The picker, for the meeting about to start or in progress. A folder made
 * here is created on the spot — the one moment someone has said they want it
 * — and an organization gets a shared copy, as the default destination does.
 */
@Composable
private fun MeetingFolderPicker(chosen: ChosenFolder?, folders: MeetingFolders, onDismiss: () -> Unit) {
    val container = rememberContainer()
    val directory = folders.directory
    val unfiled = stringResource(R.string.library_folder_unfiled)
    FolderPickerSheet(
        scopes = listOf(FolderScope(null, directory.personalFolders)) + directory.scopesFor(null).drop(1),
        current = chosen?.destination ?: folders.default,
        options = FolderPickerOptions(
            title = stringResource(R.string.meeting_folder_choose),
            confirmLabel = stringResource(R.string.folder_picker_choose),
            orgHandoff = OrgHandoff.COPY,
        ),
        callbacks = FolderPickerCallbacks(
            onConfirm = { destination ->
                MeetingDraft.setFolder(ChosenFolder(destination, folders.labelOf(destination) ?: unfiled))
            },
            onCreate = if (DemoMode.isActive) {
                null
            } else {
                { name -> container.cloud.createFolder(name).also { folders.created(it) } }
            },
            onDismiss = onDismiss,
        ),
    )
}

/**
 * The folders and organizations the chip and its picker name, and the app's
 * default destination. Best-effort: an empty directory still lets the user
 * pick the top level or create a folder.
 */
private class MeetingFolders(
    val directory: FolderDirectory,
    val default: SaveDestination,
    val created: (com.pathors.parley.cloud.CloudFolder) -> Unit,
) {
    /** The chip's words for [destination]: the folder, or "Organization · Folder". */
    fun labelOf(destination: SaveDestination): String? {
        val orgId = destination.orgId
        if (orgId == null) return directory.folderName(destination)
        val org = directory.orgName(orgId).orEmpty()
        val folder = directory.folderName(destination) ?: return org
        return "$org · $folder"
    }

    /** The default destination's words, or null when it is the personal top level. */
    val defaultLabel: String?
        get() = if (!default.isOrg && default.folderId == null) null else labelOf(default)
}

@Composable
private fun rememberMeetingFolders(inMeeting: Boolean): MeetingFolders {
    val container = rememberContainer()
    var directory by remember { mutableStateOf(FolderDirectory()) }
    val default by container.saveLocation.destination.collectAsState(initial = SaveDestination.PERSONAL_ROOT)
    // On arrival and again when a meeting starts: a folder made on the desktop
    // in between is one the picker should offer.
    LaunchedEffect(inMeeting) {
        directory = if (DemoMode.isActive) {
            FolderDirectory(personalFolders = DemoMode.pickerFolders())
        } else {
            runCatching { FolderDirectory.load(container.cloud) }.getOrDefault(directory)
        }
    }
    return MeetingFolders(
        directory = directory,
        default = if (DemoMode.isActive) SaveDestination.PERSONAL_ROOT else default,
        created = { folder -> directory = directory.withFolder(null, folder) },
    )
}

// ── warning strip ────────────────────────────────────────────────────────────

/**
 * One warning at a time, under the top of the screen, in the desktop's amber
 * strip and its order ([currentWarning]): the most urgent thing the meeting is
 * not doing first.
 */
@Composable
private fun WarningStrip(warning: MeetingWarning?) {
    val amber = ParleyTheme.colors.warning
    AnimatedVisibility(visible = warning != null, enter = fadeIn(), exit = fadeOut()) {
        val shown = warning ?: return@AnimatedVisibility
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(amber.copy(alpha = 0.12f))
                .drawBehind {
                    drawRect(
                        color = amber.copy(alpha = 0.35f),
                        topLeft = Offset(0f, size.height - 0.5.dp.toPx()),
                        size = Size(size.width, 0.5.dp.toPx()),
                    )
                }
                .padding(horizontal = 16.dp, vertical = 8.dp)
                .semantics(mergeDescendants = true) {},
            verticalAlignment = Alignment.Top,
        ) {
            Box(Modifier.padding(top = 2.dp).size(14.dp), contentAlignment = Alignment.Center) {
                WarningGlyph(shown.tone, amber)
            }
            Spacer(Modifier.width(8.dp))
            Text(
                text = warningText(shown),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.weight(1f),
            )
        }
    }
}

@Composable
private fun WarningGlyph(tone: NoticeTone, amber: Color) {
    when (tone) {
        NoticeTone.RECONNECTING -> CircularProgressIndicator(
            modifier = Modifier.size(12.dp),
            color = amber,
            strokeWidth = 1.5.dp,
        )
        NoticeTone.TRANSCRIPT_STOPPED -> Icon(
            imageVector = MeetingIcons.TranscriptStopped,
            contentDescription = null,
            tint = amber,
            modifier = Modifier.size(14.dp),
        )
        NoticeTone.ALARM -> Icon(
            imageVector = Icons.Default.Warning,
            contentDescription = null,
            tint = amber,
            modifier = Modifier.size(14.dp),
        )
        NoticeTone.INFO -> Icon(
            imageVector = OnboardingIcons.Mic,
            contentDescription = null,
            tint = amber,
            modifier = Modifier.size(14.dp),
        )
    }
}

@Composable
private fun warningText(warning: MeetingWarning): String = when (warning) {
    is MeetingWarning.Mic -> micLineText(warning.line)
    MeetingWarning.StorageLow -> stringResource(R.string.meeting_storage_low)
    is MeetingWarning.Transcription -> stringResource(
        if (warning.issue == TranscriptionIssue.RECONNECTING) {
            R.string.meeting_warning_reconnecting
        } else {
            transcriptionIssueRes(warning.issue)
        },
    )
}

// ── the dock ─────────────────────────────────────────────────────────────────

/**
 * Everything the meeting is operated with, together at the bottom: the clock
 * and the microphone on one line, the live waveform under them — *is it
 * hearing me* — and the actions. Before a meeting the same three lines, at
 * rest, with Start recording; between them the last meeting's status line.
 * Discard sits apart from End on the left, so the two ways out are never side
 * by side under a thumb.
 */
@Composable
private fun Dock(readout: DockReadout, actions: MeetingActions) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 16.dp, end = 16.dp, top = 10.dp, bottom = 6.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            ClockPill(readout)
            Spacer(Modifier.weight(1f).widthIn(min = 8.dp))
            MicChip(readout)
        }
        LiveWaveform(level = readout.level, active = readout.hearing, height = 30.dp)
        if (readout.inMeeting) {
            MeetingButtons(readout.state, actions)
        } else {
            OutcomeLines(readout.state)
            StartButton(busy = readout.state == MeetingState.Uploading, onStart = actions.onStart)
        }
    }
}

/**
 * The recording clock: a pulsing red dot and the elapsed time on a grey
 * capsule. Paused, the dot goes grey and still, and 已暫停 follows the time.
 * Before a meeting, 0:00 behind a still grey dot. Red is the only colour a
 * running meeting wears, so it is the only thing here that moves.
 */
@Composable
private fun ClockPill(readout: DockReadout) {
    // Paused — by the user, or by something holding the microphone — the dot
    // goes grey and still.
    val running = readout.hearing
    val still = rememberAnimationsRemoved()
    val pulse = if (running && !still) {
        val transition = rememberInfiniteTransition(label = "recording-dot")
        transition.animateFloat(
            initialValue = 1f,
            targetValue = 0.3f,
            animationSpec = infiniteRepeatable(tween(PULSE_MS), RepeatMode.Reverse),
            label = "recording-dot-alpha",
        ).value
    } else {
        1f
    }
    Row(
        modifier = Modifier
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.surfaceVariant, CircleShape)
            .padding(horizontal = 12.dp, vertical = 5.dp)
            .semantics(mergeDescendants = true) {},
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(8.dp)
                .alpha(pulse)
                .clip(CircleShape)
                .background(if (running) ParleyTheme.colors.recording else MaterialTheme.colorScheme.outline),
        )
        Spacer(Modifier.width(8.dp))
        Text(
            text = formatClock(if (readout.inMeeting) readout.elapsed else 0L),
            style = MaterialTheme.typography.titleSmall.copy(fontFeatureSettings = "tnum"),
            fontWeight = FontWeight.Medium,
            color = if (running) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
        )
        if (readout.paused) {
            Spacer(Modifier.width(8.dp))
            Text(
                text = stringResource(R.string.meeting_paused),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
            )
        }
    }
}

private const val PULSE_MS = 900

/**
 * The microphone, in the spirit of the desktop's `MicChip`: whether it hears
 * anything (three bars that move with the level), whether the live transcript
 * is in trouble (its mark in place of the bars), and — opened — which input is
 * recording and how the meeting stands. The input is in the menu rather than
 * on the chip: a phone's dock has no room for a device name.
 */
@Composable
private fun MicChip(readout: DockReadout) {
    var open by remember { mutableStateOf(false) }
    val input = inputName(readout.inputRoute)
    val chipLabel = stringResource(R.string.meeting_mic_chip, input)
    val status = micStatus(readout)
    Box {
        Row(
            modifier = Modifier
                .heightIn(min = 44.dp)
                .clickable(role = Role.Button) { open = true }
                .semantics { contentDescription = listOfNotNull(chipLabel, status).joinToString("\n") },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(
                modifier = Modifier
                    .height(30.dp)
                    .border(1.dp, MaterialTheme.colorScheme.outlineVariant, CircleShape)
                    .padding(horizontal = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = OnboardingIcons.Mic,
                    contentDescription = null,
                    tint = if (readout.micAlarming) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.size(15.dp),
                )
                Spacer(Modifier.width(6.dp))
                val issue = readout.issue
                if (readout.inMeeting && issue != null) {
                    HealthBadge(issue)
                } else {
                    ChipMeter(if (readout.hearing) readout.level else 0f)
                }
                Spacer(Modifier.width(6.dp))
                Icon(
                    imageVector = Icons.Default.KeyboardArrowDown,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.outline,
                    modifier = Modifier.size(14.dp),
                )
            }
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(
                text = {
                    Text(
                        text = input,
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.SemiBold,
                    )
                },
                onClick = {},
                enabled = false,
            )
            if (status != null) {
                DropdownMenuItem(
                    text = { Text(text = status, style = MaterialTheme.typography.bodyMedium) },
                    onClick = { open = false },
                )
            }
        }
    }
}

/** The input the meeting records from, by kind — Android names the route, not the device. */
@Composable
private fun inputName(route: String?): String = stringResource(
    when (route) {
        AudioRouteLabel.BUILT_IN -> R.string.meeting_input_builtin
        AudioRouteLabel.BLUETOOTH_A2DP, AudioRouteLabel.BLUETOOTH_HFP -> R.string.meeting_input_bluetooth
        AudioRouteLabel.WIRED -> R.string.meeting_input_wired
        AudioRouteLabel.USB -> R.string.meeting_input_usb
        else -> R.string.meeting_mic
    },
)

/** The status line the menu carries: how the live transcript stands, or null before a meeting. */
@Composable
private fun micStatus(readout: DockReadout): String? {
    if (!readout.inMeeting) return null
    val issue = readout.issue
    return when {
        issue != null -> stringResource(transcriptionIssueRes(issue))
        readout.state == MeetingState.Recording -> stringResource(R.string.meeting_transcribing_live)
        else -> statusLabel(readout.state)
    }
}

/** The live transcript's mark on the chip, in place of the bars: an amber spinner, or the bolt. */
@Composable
private fun HealthBadge(issue: TranscriptionIssue) {
    if (issue.isTerminal) {
        Icon(
            imageVector = MeetingIcons.TranscriptStopped,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.size(13.dp),
        )
    } else {
        CircularProgressIndicator(
            modifier = Modifier.size(11.dp),
            color = ParleyTheme.colors.warning,
            strokeWidth = 1.5.dp,
        )
    }
}

/**
 * Three tiny bars, after the desktop's mic-chip meter: they move with the
 * microphone's level, and lie flat and grey when nothing is heard — paused,
 * before a meeting, or a silent room.
 */
@Composable
private fun ChipMeter(level: Float) {
    val p = min(1.0, sqrt(level.toDouble()))
    val active = p > 0.03
    val color = if (active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline
    Row(
        modifier = Modifier.height(12.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        listOf(0.7, 1.0, 0.5).forEach { weight ->
            val bar: Dp = (3 + (9 * min(1.0, p * weight * 1.6)).roundToInt()).dp
            Box(
                Modifier
                    .width(3.dp)
                    .height(bar)
                    .clip(RoundedCornerShape(1.dp))
                    .background(color),
            )
        }
    }
}

/** ✕, Pause or Resume, and End — the meeting's three actions. */
@Composable
private fun MeetingButtons(state: MeetingState, actions: MeetingActions) {
    val view = LocalView.current
    val focus = LocalFocusManager.current
    Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        DiscardButton(enabled = isLive(state), onDiscard = actions.onDiscard)
        PauseButton(state, actions.onTogglePause)
        Spacer(Modifier.weight(1f))
        EndButton(
            finishing = state == MeetingState.Finishing,
            enabled = isLive(state),
            onEnd = {
                focus.clearFocus()
                MeetingHaptics.recordingStopped(view)
                actions.onStop()
            },
        )
    }
}

/**
 * ✕, the desktop title bar's way out, in the dock: throw the meeting away,
 * after the desktop's own confirmation. Grey, not red — the red belongs in the
 * confirmation and on End's square.
 *
 * The throwing-away goes through `MeetingService.requestDiscard`, the only
 * path in the app that deletes a recording.
 */
@Composable
private fun DiscardButton(enabled: Boolean, onDiscard: () -> Unit) {
    val view = LocalView.current
    val focus = LocalFocusManager.current
    var confirming by rememberSaveable { mutableStateOf(false) }
    val label = stringResource(R.string.meeting_cancel)
    Box(
        modifier = Modifier
            .size(44.dp)
            .clickable(enabled = enabled, role = Role.Button) {
                focus.clearFocus()
                confirming = true
            }
            .clearAndSetSemantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .size(42.dp)
                .clip(BUTTON_SHAPE)
                .background(MaterialTheme.colorScheme.surfaceVariant, BUTTON_SHAPE),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = Icons.Default.Close,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(18.dp),
            )
        }
    }
    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text(stringResource(R.string.meeting_cancel_title)) },
            text = { ScrollingDialogText(stringResource(R.string.meeting_cancel_body)) },
            confirmButton = {
                TextButton(onClick = {
                    confirming = false
                    MeetingHaptics.recordingDiscarded(view)
                    onDiscard()
                }) {
                    Text(
                        text = stringResource(R.string.meeting_cancel_confirm),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { confirming = false }) {
                    Text(stringResource(R.string.meeting_cancel_keep))
                }
            },
        )
    }
}

/**
 * Dialog body copy that stays readable at the largest font scale: an
 * `AlertDialog` clips its text slot rather than scrolling it, and the discard
 * dialog is one whose whole point is the paragraph.
 */
@Composable
private fun ScrollingDialogText(text: String) {
    Text(
        text = text,
        modifier = Modifier.verticalScroll(rememberScrollState()),
    )
}

/** Pause in the dock's grey; Resume tinted the light primary, the next thing to press. */
@Composable
private fun PauseButton(state: MeetingState, onToggle: () -> Unit) {
    val paused = state == MeetingState.Paused
    // Inert while the microphone is still opening — there is nothing to pause
    // yet — and once End has been pressed.
    val enabled = state == MeetingState.Recording || paused
    val ink = if (paused) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant
    val label = stringResource(if (paused) R.string.meeting_resume else R.string.meeting_pause)
    DockButton(
        enabled = enabled,
        fill = if (paused) MaterialTheme.colorScheme.primary.copy(alpha = 0.12f) else MaterialTheme.colorScheme.surfaceVariant,
        spoken = label,
        onClick = onToggle,
        modifier = Modifier.alpha(if (state == MeetingState.Connecting) 0.5f else 1f),
    ) {
        Icon(
            imageVector = if (paused) Icons.Default.PlayArrow else MeetingIcons.Pause,
            contentDescription = null,
            tint = ink,
            modifier = Modifier.size(if (paused) 16.dp else 14.dp),
        )
        Spacer(Modifier.width(6.dp))
        Text(
            text = label,
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
            color = ink,
            maxLines = 1,
        )
    }
}

/** 結束: a small filled red square and the word, in Pause's grey; a spinner while the last sentence drains. */
@Composable
private fun EndButton(finishing: Boolean, enabled: Boolean, onEnd: () -> Unit) {
    val ink = MaterialTheme.colorScheme.onSurfaceVariant
    val spoken = stringResource(if (finishing) R.string.meeting_finishing else R.string.meeting_end)
    DockButton(
        enabled = enabled,
        fill = MaterialTheme.colorScheme.surfaceVariant,
        spoken = spoken,
        onClick = onEnd,
    ) {
        Box(Modifier.size(14.dp), contentAlignment = Alignment.Center) {
            if (finishing) {
                CircularProgressIndicator(modifier = Modifier.size(12.dp), color = ink, strokeWidth = 1.5.dp)
            } else {
                Box(
                    Modifier
                        .size(10.dp)
                        .clip(RoundedCornerShape(2.dp))
                        .background(ParleyTheme.colors.recording),
                )
            }
        }
        Spacer(Modifier.width(7.dp))
        Text(
            text = stringResource(R.string.meeting_end),
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
            color = ink,
            maxLines = 1,
        )
    }
}

/**
 * One of the dock's rounded buttons: 42 dp drawn, larger than the desktop's
 * 32 px because on a phone these are the meeting's main controls under a
 * thumb, inside a 44 dp target.
 */
@Composable
private fun DockButton(
    enabled: Boolean,
    fill: Color,
    spoken: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Box(
        modifier = modifier
            .heightIn(min = 44.dp)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .clearAndSetSemantics { contentDescription = spoken },
        contentAlignment = Alignment.Center,
    ) {
        Row(
            modifier = Modifier
                .heightIn(min = 42.dp)
                .clip(BUTTON_SHAPE)
                .background(fill, BUTTON_SHAPE)
                .padding(start = 14.dp, end = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) { content() }
    }
}

/**
 * Start recording, the dock's one action before a meeting: the desktop's
 * light-primary button (its Resume) — blue ink on a faint blue wash. A solid
 * blue bar was the loudest thing on a screen that is waiting, not asking.
 * Inert, with a spinner, while the last meeting is still being saved.
 */
@Composable
private fun StartButton(busy: Boolean, onStart: () -> Unit) {
    val primary = MaterialTheme.colorScheme.primary
    val label = stringResource(if (busy) R.string.meeting_finishing else R.string.meeting_start)
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 44.dp)
            .clickable(enabled = !busy, role = Role.Button, onClick = onStart)
            .clearAndSetSemantics { contentDescription = label }
            .alpha(if (busy) 0.6f else 1f),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 42.dp)
                .clip(BUTTON_SHAPE)
                .background(primary.copy(alpha = 0.12f), BUTTON_SHAPE),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (busy) {
                CircularProgressIndicator(modifier = Modifier.size(14.dp), color = primary, strokeWidth = 1.5.dp)
            } else {
                Box(
                    Modifier
                        .size(10.dp)
                        .clip(CircleShape)
                        .background(primary),
                )
            }
            Spacer(Modifier.width(8.dp))
            Text(
                text = label,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color = primary,
            )
        }
    }
}

/**
 * The last meeting's status between meetings, when it did not end on its
 * result page: uploading, waiting on the phone (offline, the quota, a
 * refusal), too short to keep, cut short, or failed.
 */
@Composable
private fun OutcomeLines(state: MeetingState) {
    val lines: List<Pair<String, Color>> = when (state) {
        MeetingState.Uploading -> listOf(statusLabel(state) to MaterialTheme.colorScheme.onSurfaceVariant)
        is MeetingState.Finished -> if (state.interruptedBy != null) {
            listOf(
                stringResource(R.string.meeting_interrupted) to MaterialTheme.colorScheme.onSurface,
                finishedOutcomeText(state) to MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            listOf(finishedOutcomeText(state) to MaterialTheme.colorScheme.onSurfaceVariant)
        }
        is MeetingState.Failed -> listOf(failureMessage(state.reason) to MaterialTheme.colorScheme.error)
        else -> emptyList()
    }
    lines.forEach { (text, color) ->
        Text(
            text = text,
            style = MaterialTheme.typography.bodySmall,
            color = color,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
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

/**
 * "The microphone was interrupted n times during this recording" — at the end
 * of a meeting whose capture had to win the microphone back five or more times
 * ([ProblemSignals.isMicRecoveryWorthAsking]). Asked while the person is still
 * looking at the meeting it happened in: on its result page for a meeting that
 * landed, on the record screen for one that did not. This is the failure 1.13
 * shipped: the input rebuilt itself in a loop, the transcript came back empty,
 * and nobody told us for ten days.
 *
 * Once per recording, through the app's frequency limits; leaving the screen
 * without answering counts as brushing it off.
 */
@Composable
internal fun MicRecoveryPrompt(
    recordingId: String,
    micRecoveries: Int,
    audioRoute: String?,
    segments: List<TranscriptSegment>,
    elapsedMs: Long,
    modifier: Modifier = Modifier,
) {
    if (!ProblemSignals.isMicRecoveryWorthAsking(micRecoveries)) return
    val feedback = rememberContainer().feedback
    var showing by remember(recordingId) { mutableStateOf(false) }
    LaunchedEffect(recordingId) {
        showing = feedback.claimPrompt(FeedbackTrigger.MIC_RECOVERY, recordingId)
    }
    val stillShowing by rememberUpdatedState(showing)
    DisposableEffect(recordingId) {
        onDispose { if (stillShowing) feedback.promptIgnored(FeedbackTrigger.MIC_RECOVERY) }
    }
    if (!showing) return
    DiagnosticsPrompt(
        text = pluralStringResource(R.plurals.feedback_mic_recovery, micRecoveries, micRecoveries),
        onSend = {
            val finals = segments.filter { it.isFinal && !it.isTail() }
            feedback.send(
                FeedbackTrigger.MIC_RECOVERY,
                RecordingContext(
                    recordingId = recordingId,
                    recordingDurationMs = elapsedMs,
                    transcriptSegments = finals.size,
                    lastSegmentEndMs = finals.maxOfOrNull { it.endMs } ?: 0L,
                    audioRoute = audioRoute,
                    micRecoveries = micRecoveries,
                ),
            )
            showing = false
        },
        onDismiss = {
            feedback.promptIgnored(FeedbackTrigger.MIC_RECOVERY)
            showing = false
        },
        modifier = modifier,
    )
}

@Composable
private fun statusLabel(state: MeetingState): String = when (state) {
    MeetingState.Idle, MeetingState.Connecting -> stringResource(R.string.meeting_connecting)
    MeetingState.Recording -> stringResource(R.string.meeting_recording)
    MeetingState.Paused -> stringResource(R.string.meeting_paused)
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

// ── the transcript ───────────────────────────────────────────────────────────

/**
 * The transcript, inside the meeting's muted panel. No tab strip and no label:
 * while recording the phone shows the transcript and nothing else, so a lone
 * 逐字稿 tab would only name what is plainly there.
 */
@Composable
private fun LiveTranscript(segments: List<TranscriptSegment>, state: MeetingState) {
    val context = LocalContext.current
    val listState = rememberLazyListState()
    var follow by remember { mutableStateOf(LiveTranscriptFollow.Start) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(segments.size) {
        if (follow.following && segments.isNotEmpty()) {
            listState.animateScrollToItem(segments.lastIndex)
        }
    }

    // An empty transcript is a meeting that has not said anything yet — a new
    // one, if this screen outlived the last.
    LaunchedEffect(segments.isEmpty()) {
        if (segments.isEmpty()) follow = LiveTranscriptFollow.Start
    }

    LaunchedEffect(listState) { listState.stayOnNewestAcrossResizes() }

    val latestSegments = rememberUpdatedState(segments.size)
    LaunchedEffect(listState) {
        listState.trackReaderFollow(latestSegments) { update -> follow = update(follow) }
    }

    if (segments.isEmpty()) {
        EmptyTranscript(state)
        return
    }

    val current = currentSpeakingId(segments)
    Box(Modifier.fillMaxSize()) {
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 14.dp, vertical = 12.dp),
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
        // The fade is scoped to the control: on the list it would also animate
        // the turn whose arrival brought the control up.
        AnimatedVisibility(
            visible = follow.showsLatest(segments.size),
            enter = fadeIn(tween(LATEST_FADE_MS, easing = LinearOutSlowInEasing)),
            exit = fadeOut(tween(LATEST_FADE_MS, easing = LinearOutSlowInEasing)),
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 12.dp),
        ) {
            LatestControl(onClick = {
                follow = follow.jumpedToLatest()
                scope.launch { listState.animateScrollToItem(segments.lastIndex) }
            })
        }
    }
}

/**
 * The panel with nothing in it. Before a meeting, a quiet waveform mark and a
 * sentence — there is nothing happening yet, so nothing for the signal colour
 * to point at; during one, the desktop's "Listening…" until somebody speaks.
 */
@Composable
private fun EmptyTranscript(state: MeetingState) {
    val listening = showsMeeting(state)
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(start = 24.dp, end = 24.dp, top = if (listening) 48.dp else 72.dp, bottom = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (!listening) {
            Icon(
                imageVector = LibraryIcons.Waveform,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.outline,
                modifier = Modifier.size(28.dp),
            )
            Spacer(Modifier.height(18.dp))
        }
        Text(
            text = stringResource(emptyTranscriptRes(state)),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            modifier = Modifier.widthIn(max = 320.dp),
        )
    }
}

/**
 * Feeds [LiveTranscriptFollow] what the list knows: when a finger starts or
 * stops dragging it, and whether its last line is in view.
 *
 * The line that has to be right is *user* scroll versus programmatic scroll,
 * and the drag interactions are exactly that line — the follow's own
 * `animateScrollToItem` emits none, so it cannot switch itself off. Being at
 * the end is `!canScrollForward`, which is also true when every turn fits.
 */
private suspend fun LazyListState.trackReaderFollow(
    segmentCount: State<Int>,
    update: ((LiveTranscriptFollow) -> LiveTranscriptFollow) -> Unit,
) = coroutineScope {
    val dragging = mutableStateOf(false)
    launch {
        interactionSource.interactions.collect { interaction ->
            when (interaction) {
                is DragInteraction.Start -> {
                    dragging.value = true
                    update { it.dragStarted(segmentCount.value) }
                }
                is DragInteraction.Stop, is DragInteraction.Cancel -> dragging.value = false
            }
        }
    }
    snapshotFlow { !canScrollForward }
        .distinctUntilChanged()
        .collect { atBottom ->
            update { it.bottomChanged(atBottom, dragging.value, segmentCount.value) }
        }
}

/**
 * The way back to the newest line once the reader has scrolled away and more
 * has been said. iOS `LiveView.latestControl`. Blue because it is the one live,
 * tappable thing on the transcript; on the page colour with a hairline, not a
 * filled pill, so it reads as a control sitting over the words rather than a
 * banner competing with them. 44dp tall at the least, and the whole capsule
 * takes the tap.
 */
@Composable
private fun LatestControl(onClick: () -> Unit) {
    val spoken = stringResource(R.string.meeting_jump_to_latest)
    val capsule = RoundedCornerShape(percent = 50)
    Row(
        modifier = Modifier
            .heightIn(min = 44.dp)
            .clip(capsule)
            .background(MaterialTheme.colorScheme.background, capsule)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, capsule)
            .clickable(role = Role.Button, onClick = onClick)
            .clearAndSetSemantics { contentDescription = spoken }
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = ArrowDown,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(16.dp),
        )
        Spacer(Modifier.width(6.dp))
        Text(
            text = stringResource(R.string.meeting_latest),
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.primary,
        )
    }
}

/** "Latest" fades in and out over this long — iOS `.easeOut(duration: 0.15)`. */
private const val LATEST_FADE_MS = 150

/**
 * A straight down arrow, iOS's `arrow.down`. Drawn here because the app only
 * ships the core Material icons, whose nearest is a chevron.
 */
private val ArrowDown: ImageVector by lazy {
    ImageVector.Builder(
        name = "ArrowDown",
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).apply {
        path(fill = SolidColor(Color.Black)) {
            moveTo(20f, 12f)
            lineToRelative(-1.41f, -1.41f)
            lineTo(13f, 16.17f)
            verticalLineTo(4f)
            horizontalLineToRelative(-2f)
            verticalLineToRelative(12.17f)
            lineToRelative(-5.58f, -5.59f)
            lineTo(4f, 12f)
            lineToRelative(8f, 8f)
            lineToRelative(8f, -8f)
            close()
        }
    }.build()
}

/**
 * The panel changes height mid-meeting — a warning strip coming and going, the
 * keyboard over the name. A reader who was on the newest line stays on it while
 * the viewport changes size; one who had scrolled back is left where they were.
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
 * The speaker is plain text, not a coloured mark: blue here means *now*, so
 * only [isCurrent] — the turn the provider has not finalised, the only thing on
 * screen that is still being said — gets it, on its label.
 *
 * The words are selectable, the tentative tail included. A long press anywhere
 * else on the turn offers Copy of the whole turn, header included, which
 * selection cannot reach because the speaker and the clock are separate texts.
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
 * Why there is no microphone yet, and what to do about it — shown once Start
 * has been pressed and the permission refused.
 *
 * [blocked] is the case this screen used to have no answer for. Android 11+
 * treats a second refusal as final: the system dialog never appears again and
 * `permissionLauncher.launch()` returns a denial without showing anything, so an
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
