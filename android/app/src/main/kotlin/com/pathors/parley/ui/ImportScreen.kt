package com.pathors.parley.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.pathors.parley.R
import com.pathors.parley.meeting.ImportFailure
import com.pathors.parley.meeting.ImportState
import com.pathors.parley.meeting.ImportTranscript
import com.pathors.parley.screenshot.DemoMode
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/**
 * Watching an imported file get transcribed.
 *
 * The work belongs to the application-scoped `ImportSession`, so leaving and
 * coming back re-attaches to the same run rather than restarting it. The decoder
 * streams faster than realtime and the relay's write queue is what throttles it,
 * so the progress bar tracks decoding while the "transcribed" figure trails it.
 */
@Composable
fun ImportScreen(onDone: () -> Unit) {
    val container = rememberContainer()
    val session by container.activeImport.collectAsState()

    if (DemoMode.isActive) {
        DemoImportScreen(onDone = onDone)
        return
    }

    val active = session
    if (active == null) {
        NoImportGate(onDone = onDone)
        return
    }

    val state by active.state.collectAsState()

    // Only a clean ending closes itself. Anything with a caveat — still on the
    // phone, transcript being redone — stays up until it has been read.
    LaunchedEffect(state) {
        if (state.closesByItself()) {
            delay(900)
            container.clearImport()
            onDone()
        }
    }

    ImportContent(
        title = active.title,
        state = state,
        onDismiss = {
            container.clearImport()
            onDone()
        },
        onSignIn = {
            container.clearImport()
            // The relay has already told us this token is dead. Forgetting it
            // is what brings the sign-in wall back (see ParleyRoot), and it is
            // done on the app scope because this screen is about to go away.
            container.appScope.launch { container.auth.clearSession() }
        },
    )
}

/**
 * The import screen with a fixed ending from [DemoMode], so the failure and
 * partial states can be looked at without breaking anything to reach them.
 * Writes nothing: "sign in again" just leaves, as every demo exit does.
 */
@Composable
private fun DemoImportScreen(onDone: () -> Unit) {
    val ending by DemoMode.importEnding.collectAsState()
    ImportContent(
        title = DemoMode.importTitle(),
        state = DemoMode.importState(ending),
        onDismiss = onDone,
        onSignIn = onDone,
    )
}

@Composable
private fun ImportContent(
    title: String,
    state: ImportState,
    onDismiss: () -> Unit,
    onSignIn: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
    ) {
        Text(
            text = stringResource(R.string.import_title),
            style = MaterialTheme.typography.titleLarge,
        )
        Spacer(Modifier.height(24.dp))
        ImportFileHeader(title = title, state = state)
        Spacer(Modifier.height(32.dp))
        ImportProgress(state = state)
        ImportFailureNotice(state = state)
        ImportTranscriptNotice(state = state)
        Box(Modifier.weight(1f))
        if (state.needsSignIn()) {
            Button(
                onClick = onSignIn,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(48.dp),
            ) {
                Text(stringResource(R.string.import_action_sign_in_again))
            }
            Spacer(Modifier.height(8.dp))
        }
        ImportDismissButton(state = state, onClick = onDismiss)
    }
}

/** Landed here with nothing to watch — the only thing left to offer is the way out. */
@Composable
private fun NoImportGate(onDone: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(stringResource(R.string.import_no_file))
        Spacer(Modifier.height(16.dp))
        Button(onClick = onDone) { Text(stringResource(R.string.action_close)) }
    }
}

/**
 * What is being imported, and how long it is.
 *
 * The length is only known once the decoder has opened the file, so before that
 * the line says so rather than showing a zero.
 */
@Composable
private fun ImportFileHeader(title: String, state: ImportState) {
    Text(
        text = title,
        style = MaterialTheme.typography.titleMedium,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
    )
    // The length is a fact about a run in progress; once the import is over
    // the state no longer carries it, and "length unknown" would be untrue.
    if (state.isTerminal()) return
    val duration = (state as? ImportState.Running)?.durationMs ?: -1L
    Text(
        text = if (duration >= 0) {
            stringResource(R.string.import_length, formatDuration(duration.toDouble()))
        } else {
            stringResource(R.string.import_length_unknown)
        },
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/**
 * The phase, and a bar for it where there is one to draw.
 *
 * Decoding reports a fraction, so that phase gets a determinate bar and the
 * trailing "transcribed" figure beside it; preparing and uploading have no
 * measure at all and get the indeterminate one. A finished or cancelled import
 * gets no bar, because there is nothing left in flight.
 */
@Composable
private fun ImportProgress(state: ImportState) {
    // A failure is spelled out once, by [ImportFailureNotice]; repeating it
    // here as the phase printed the same sentence twice.
    if (state !is ImportState.Failed) {
        Text(text = phaseLabel(state), style = MaterialTheme.typography.bodyLarge)
        Spacer(Modifier.height(12.dp))
    }

    val running = state as? ImportState.Running
    if (running != null && running.decodeProgress >= 0f) {
        LinearProgressIndicator(
            progress = { running.decodeProgress.coerceIn(0f, 1f) },
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = stringResource(
                R.string.import_progress,
                (running.decodeProgress * 100).roundToInt().coerceIn(0, 100),
                formatDuration(running.transcribedMs.toDouble()),
            ),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    } else if (state.isInFlight()) {
        LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
    }
}

@Composable
private fun ImportFailureNotice(state: ImportState) {
    val failed = state as? ImportState.Failed ?: return
    Spacer(Modifier.height(16.dp))
    Text(
        text = failureMessage(failed.reason),
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.error,
    )
}

/**
 * Saved, but the transcript that went up with it is short: say so, and say what
 * happens next, rather than letting "Done" imply the transcript is whole.
 */
@Composable
private fun ImportTranscriptNotice(state: ImportState) {
    val finished = state as? ImportState.Finished ?: return
    if (finished.transcript != ImportTranscript.COMPLETES_IN_BACKGROUND) return
    Spacer(Modifier.height(16.dp))
    Text(
        text = stringResource(R.string.import_transcript_in_background),
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/**
 * One button for both endings: it drops the session either way, so only the
 * label moves — cancelling a run in flight, closing one that is over.
 */
@Composable
private fun ImportDismissButton(state: ImportState, onClick: () -> Unit) {
    OutlinedButton(
        onClick = onClick,
        modifier = Modifier
            .fillMaxWidth()
            .height(48.dp),
    ) {
        Text(
            stringResource(
                if (state.isTerminal()) R.string.action_close else R.string.action_cancel
            )
        )
    }
}

/** Still working: there is something to cancel and something to show a bar for. */
private fun ImportState.isInFlight(): Boolean =
    this is ImportState.Preparing ||
        this is ImportState.Running ||
        this is ImportState.Uploading

/** Finished with nothing left to tell the user: safe to leave on its own. */
private fun ImportState.closesByItself(): Boolean =
    this is ImportState.Finished &&
        !pendingUpload &&
        transcript == ImportTranscript.COMPLETE

/** The way forward is signing in, so offer it rather than just naming it. */
private fun ImportState.needsSignIn(): Boolean =
    this is ImportState.Failed &&
        (reason == ImportFailure.SESSION_EXPIRED || reason == ImportFailure.NOT_SIGNED_IN)

/** Over, one way or another. */
private fun ImportState.isTerminal(): Boolean =
    this is ImportState.Failed ||
        this is ImportState.Cancelled ||
        this is ImportState.Finished

@Composable
private fun phaseLabel(state: ImportState): String = when (state) {
    ImportState.Idle, ImportState.Preparing -> stringResource(R.string.import_phase_preparing)
    is ImportState.Running -> stringResource(R.string.import_phase_transcribing)
    ImportState.Uploading -> stringResource(R.string.import_phase_uploading)
    is ImportState.Finished -> when {
        state.pendingUpload -> stringResource(R.string.meeting_queued)
        state.transcript == ImportTranscript.COMPLETES_IN_BACKGROUND ->
            stringResource(R.string.import_phase_saved)
        else -> stringResource(R.string.import_phase_done)
    }

    ImportState.Cancelled -> stringResource(R.string.action_cancel)
    is ImportState.Failed -> failureMessage(state.reason)
}

@Composable
private fun failureMessage(reason: ImportFailure): String = when (reason) {
    ImportFailure.NOT_SIGNED_IN -> stringResource(R.string.failure_not_signed_in)
    ImportFailure.SESSION_EXPIRED -> stringResource(R.string.import_failure_session_expired)
    // The same words iOS uses when an import runs into the quota.
    ImportFailure.QUOTA_EXHAUSTED -> stringResource(R.string.batch_error_quota)
    ImportFailure.UNREADABLE -> stringResource(R.string.import_failure_unreadable)
    ImportFailure.NO_AUDIO_TRACK -> stringResource(R.string.import_failure_no_audio)
    ImportFailure.UNSUPPORTED_CODEC -> stringResource(R.string.import_failure_unsupported)
    ImportFailure.DECODE_FAILED -> stringResource(R.string.import_failure_decode)
    ImportFailure.ENCODER_UNAVAILABLE -> stringResource(R.string.failure_encoder_unavailable)
    ImportFailure.UPLOAD_FAILED -> stringResource(R.string.failure_upload)
    ImportFailure.UPLOAD_REFUSED -> stringResource(R.string.import_failure_upload_refused)
    ImportFailure.UNKNOWN -> stringResource(R.string.failure_unknown)
}
