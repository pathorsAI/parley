package com.pathors.parley.playback

import android.text.format.Formatter
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.pathors.parley.R
import com.pathors.parley.parleyContainer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * "Audio on this phone" in the account sheet: the switch that decides whether a
 * meeting recorded here keeps its audio after uploading, what that currently
 * costs in bytes, and a way to get those bytes back.
 *
 * Why the account sheet and not a settings screen of its own: this is the only
 * settings surface the Android app has, and the thing being settled — how much
 * of my phone is this app using — sits naturally next to the plan and the
 * quota that are already here.
 *
 * Reads the container directly rather than going through `HomeViewModel`. The
 * state is three values that come off the disk, none of them shared with the
 * library screen, and routing them through a view model that has nothing else
 * to do with them would make both files longer.
 */
@Composable
fun AudioStorageSection() {
    val context = LocalContext.current
    val container = context.parleyContainer
    val scope = rememberCoroutineScope()

    val keepAudio by container.audioRetention.keepsAudioOnPhone
        .collectAsState(initial = AudioRetention.DEFAULT_KEEP_AUDIO)

    // Bumped after a removal so the usage line is re-read; the store is a
    // directory, not an observable, and a scan per sheet-opening is cheap.
    var revision by remember { mutableIntStateOf(0) }
    var removing by remember { mutableStateOf(false) }

    val usage by produceState(initialValue = null as AudioUsage?, revision) {
        value = withContext(Dispatchers.IO) {
            AudioUsage(container.localAudio.count(), container.localAudio.totalBytes())
        }
    }

    HorizontalDivider(Modifier.padding(vertical = 8.dp))

    Text(
        text = stringResource(R.string.account_audio_title),
        style = MaterialTheme.typography.titleSmall,
    )

    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                text = stringResource(R.string.account_keep_audio),
                style = MaterialTheme.typography.bodyLarge,
            )
            Text(
                text = stringResource(R.string.account_keep_audio_detail),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Switch(
            checked = keepAudio,
            onCheckedChange = { checked ->
                scope.launch { container.audioRetention.setKeepsAudioOnPhone(checked) }
            },
        )
    }

    val current = usage
    Text(
        text = when {
            current == null || current.count == 0 ->
                stringResource(R.string.account_audio_none)

            else -> pluralStringResource(
                R.plurals.account_audio_stored,
                current.count,
                current.count,
                Formatter.formatShortFileSize(context, current.bytes),
            )
        },
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )

    // Only offered when there is something to remove. Turning the switch off
    // deliberately does NOT sweep what is already here: the setting is about
    // what happens next, and a switch that silently deleted an hour of audio
    // somebody had on a plane would be the wrong kind of surprise.
    if (current != null && current.count > 0) {
        TextButton(
            enabled = !removing,
            onClick = {
                removing = true
                scope.launch {
                    withContext(Dispatchers.IO) { container.localAudio.removeAll() }
                    removing = false
                    revision++
                }
            },
        ) {
            Text(
                text = stringResource(R.string.account_audio_remove_all),
                color = MaterialTheme.colorScheme.error,
            )
        }
    }
}

/** What the local audio store currently holds. */
private data class AudioUsage(val count: Int, val bytes: Long)
