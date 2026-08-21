package com.pathors.parley.ui

import android.Manifest
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.pathors.parley.R
import com.pathors.parley.voicetyping.VoiceTypingSetup

/**
 * Voice-typing onboarding, and the landing pad for the keyboard's hand-off.
 *
 * It carries the three things only this side of the process can do:
 *
 * 1. **Enable the keyboard** — a jump to the system's on-screen keyboard list.
 *    No API can flip that switch for the user; iOS is in the same position, and
 *    `ios/App/Parley/SettingsView.swift` solves it the same way (one line on what
 *    the feature is, one button to the place with the toggle, then the steps).
 * 2. **Switch to it** — the keyboard picker.
 * 3. **Grant the microphone** — the reason this screen has to exist rather than
 *    being a paragraph in the account sheet. An `InputMethodService` cannot
 *    request a runtime permission (no Activity to host it), so the keyboard sends
 *    the user here and *here* is where the system dialog can appear. See
 *    `voicetyping/VoiceTypingSetup.kt`.
 *
 * The steps show their own state rather than instructions alone: each one is
 * ticked once it is actually done, re-checked every time the screen resumes,
 * because all three are changed *outside* the app.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VoiceTypingSetupScreen(onBack: () -> Unit) {
    val context = LocalContext.current

    var micGranted by remember { mutableStateOf(VoiceTypingSetup.hasMicPermission(context)) }
    var micDenied by remember { mutableStateOf(false) }
    var imeEnabled by remember { mutableStateOf(VoiceTypingSetup.isImeEnabled(context)) }
    var imeSelected by remember { mutableStateOf(VoiceTypingSetup.isImeSelected(context)) }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        micGranted = granted
        micDenied = !granted
    }

    // Every one of these three is toggled in system UI — the keyboard list, the
    // picker, the permission dialog — so the only reliable moment to re-read them
    // is when this screen comes back to the foreground.
    val activity = context as? ComponentActivity
    DisposableEffect(activity) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                micGranted = VoiceTypingSetup.hasMicPermission(context)
                imeEnabled = VoiceTypingSetup.isImeEnabled(context)
                imeSelected = VoiceTypingSetup.isImeSelected(context)
            }
        }
        activity?.lifecycle?.addObserver(observer)
        onDispose { activity?.lifecycle?.removeObserver(observer) }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.voice_typing_setup_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            stringResource(R.string.action_back),
                        )
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                text = stringResource(R.string.voice_typing_setup_headline),
                style = MaterialTheme.typography.headlineSmall,
            )
            Text(
                text = stringResource(R.string.voice_typing_setup_body),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            SetupStep(
                number = 1,
                done = imeEnabled,
                title = stringResource(R.string.voice_typing_setup_step_enable_title),
                body = stringResource(R.string.voice_typing_setup_step_enable_body),
                action = stringResource(R.string.voice_typing_setup_step_enable_action),
                onAction = { VoiceTypingSetup.openSystemImeSettings(context) },
            )
            SetupStep(
                number = 2,
                done = imeSelected,
                title = stringResource(R.string.voice_typing_setup_step_switch_title),
                body = stringResource(R.string.voice_typing_setup_step_switch_body),
                action = stringResource(R.string.voice_typing_setup_step_switch_action),
                onAction = { VoiceTypingSetup.showImePicker(context) },
            )
            SetupStep(
                number = 3,
                done = micGranted,
                title = stringResource(R.string.voice_typing_setup_step_mic_title),
                body = stringResource(R.string.voice_typing_setup_step_mic_body),
                action = stringResource(R.string.voice_typing_setup_step_mic_action),
                onAction = { permissionLauncher.launch(Manifest.permission.RECORD_AUDIO) },
            ) {
                // A denial the user cannot take back from a dialog any more: the
                // only remaining route is the app's own settings page.
                if (micDenied && !micGranted) {
                    Text(
                        text = stringResource(R.string.voice_typing_setup_mic_denied),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                    TextButton(onClick = { VoiceTypingSetup.openAppSettings(context) }) {
                        Text(stringResource(R.string.voice_typing_setup_app_settings))
                    }
                }
            }

            if (micGranted && imeEnabled) {
                Surface(
                    color = MaterialTheme.colorScheme.secondaryContainer,
                    shape = MaterialTheme.shapes.medium,
                ) {
                    Text(
                        text = stringResource(R.string.voice_typing_setup_ready),
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(16.dp),
                    )
                }
            }
        }
    }
}

/** One numbered step: a tick once it is done, and the jump that gets it done. */
@Composable
private fun SetupStep(
    number: Int,
    done: Boolean,
    title: String,
    body: String,
    action: String,
    onAction: () -> Unit,
    extra: @Composable () -> Unit = {},
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                if (done) {
                    Surface(
                        color = MaterialTheme.colorScheme.primary,
                        shape = CircleShape,
                        modifier = Modifier.size(24.dp),
                    ) {
                        Icon(
                            Icons.Default.Check,
                            contentDescription = stringResource(
                                R.string.voice_typing_setup_step_done
                            ),
                            tint = MaterialTheme.colorScheme.onPrimary,
                            modifier = Modifier.padding(4.dp),
                        )
                    }
                } else {
                    Surface(
                        color = MaterialTheme.colorScheme.primary,
                        shape = CircleShape,
                        modifier = Modifier.size(24.dp),
                    ) {
                        Text(
                            text = number.toString(),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onPrimary,
                            modifier = Modifier.padding(top = 3.dp),
                            fontWeight = FontWeight.Bold,
                        )
                    }
                }
                Text(text = title, style = MaterialTheme.typography.titleSmall)
            }
            Text(
                text = body,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (!done) {
                FilledTonalButton(onClick = onAction) { Text(action) }
            }
            extra()
        }
    }
}
