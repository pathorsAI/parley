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
import kotlinx.coroutines.delay
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

    val active = session
    if (active == null) {
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
        return
    }

    val state by active.state.collectAsState()

    LaunchedEffect(state) {
        if (state is ImportState.Finished) {
            delay(900)
            container.clearImport()
            onDone()
        }
    }

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
        Text(
            text = active.title,
            style = MaterialTheme.typography.titleMedium,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
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

        Spacer(Modifier.height(32.dp))
        Text(text = phaseLabel(state), style = MaterialTheme.typography.bodyLarge)
        Spacer(Modifier.height(12.dp))

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
        } else if (state is ImportState.Preparing ||
            state is ImportState.Running ||
            state is ImportState.Uploading
        ) {
            LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
        }

        (state as? ImportState.Failed)?.let { failed ->
            Spacer(Modifier.height(16.dp))
            Text(
                text = failureMessage(failed.reason),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
            )
        }

        Box(Modifier.weight(1f))

        val terminal = state is ImportState.Failed ||
            state is ImportState.Cancelled ||
            state is ImportState.Finished
        OutlinedButton(
            onClick = {
                container.clearImport()
                onDone()
            },
            modifier = Modifier
                .fillMaxWidth()
                .height(48.dp),
        ) {
            Text(
                stringResource(
                    if (terminal) R.string.action_close else R.string.action_cancel
                )
            )
        }
    }
}

@Composable
private fun phaseLabel(state: ImportState): String = when (state) {
    ImportState.Idle, ImportState.Preparing -> stringResource(R.string.import_phase_preparing)
    is ImportState.Running -> stringResource(R.string.import_phase_transcribing)
    ImportState.Uploading -> stringResource(R.string.import_phase_uploading)
    is ImportState.Finished -> if (state.pendingUpload) {
        stringResource(R.string.meeting_queued)
    } else {
        stringResource(R.string.import_phase_done)
    }

    ImportState.Cancelled -> stringResource(R.string.action_cancel)
    is ImportState.Failed -> failureMessage(state.reason)
}

@Composable
private fun failureMessage(reason: ImportFailure): String = when (reason) {
    ImportFailure.NOT_SIGNED_IN -> stringResource(R.string.failure_not_signed_in)
    ImportFailure.UNREADABLE -> stringResource(R.string.import_failure_unreadable)
    ImportFailure.NO_AUDIO_TRACK -> stringResource(R.string.import_failure_no_audio)
    ImportFailure.UNSUPPORTED_CODEC -> stringResource(R.string.import_failure_unsupported)
    ImportFailure.DECODE_FAILED -> stringResource(R.string.import_failure_decode)
    ImportFailure.ENCODER_UNAVAILABLE -> stringResource(R.string.failure_encoder_unavailable)
    ImportFailure.UPLOAD_FAILED -> stringResource(R.string.failure_upload)
    ImportFailure.UNKNOWN -> stringResource(R.string.failure_unknown)
}
