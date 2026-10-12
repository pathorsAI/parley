package com.pathors.parley.ime

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.pathors.parley.R
import com.pathors.parley.ui.theme.ParleyTheme
import kotlinx.coroutines.launch

/**
 * The keyboard's own settings screen — the `android:settingsActivity` named in
 * `res/xml/method.xml`, so the system's keyboard list links straight to it.
 *
 * ## Why the keyboard needs an Activity at all
 *
 * Because an `InputMethodService` has none, and two things can only be done from
 * an `Activity`:
 *
 * 1. **Ask for `RECORD_AUDIO`.** A runtime permission request needs an Activity
 *    to attach its dialog to. This is why tapping a microphone key that has no
 *    permission opens this screen instead of failing quietly: it is the only
 *    place on the whole path where the grant can be asked for. It looks like a
 *    detour and is actually the shortest route there is.
 * 2. **Be somewhere.** Android's keyboard settings offer a link per input
 *    method, and a keyboard with nothing behind that link looks unfinished.
 *
 * ## How the main app should link here
 *
 * This screen is deliberately standalone and knows nothing about the app's
 * navigation graph — the settings screen is being rebuilt by someone else, and
 * an entry point that reached into it would collide. When that lands, the app
 * can reach this screen and the two system screens it needs with:
 *
 * ```kotlin
 * // Parley's own voice-typing settings (this screen)
 * context.startActivity(Intent(context, VoiceTypingSettingsActivity::class.java))
 *
 * // Where the user enables the keyboard — Android has no deep link to one
 * // input method, only to the list
 * context.startActivity(Intent(Settings.ACTION_INPUT_METHOD_SETTINGS))
 *
 * // The "choose a keyboard" sheet, once it is enabled
 * val imm = context.getSystemService(InputMethodManager::class.java)
 * imm.showInputMethodPicker()
 * ```
 *
 * The onboarding copy that should precede `ACTION_INPUT_METHOD_SETTINGS` is
 * discussed in the hand-off notes: Android shows a warning there that cannot be
 * suppressed or reworded, and it is far better met before the user sees it than
 * explained afterwards.
 */
class VoiceTypingSettingsActivity : ComponentActivity() {

    private val settings by lazy { VoiceTypingSettings(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            ParleyTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background,
                ) {
                    VoiceTypingSettingsScreen(
                        settings = settings,
                        onOpenKeyboardSettings = ::openKeyboardSettings,
                        onOpenAppSettings = ::openAppSettings,
                    )
                }
            }
        }
    }

    /**
     * The system's input-method list. Android has no intent that deep-links to a
     * single keyboard, so this is as close as it gets.
     */
    private fun openKeyboardSettings() {
        runCatching { startActivity(Intent(Settings.ACTION_INPUT_METHOD_SETTINGS)) }
    }

    /** Parley's own app info page, for a permission the user has permanently denied. */
    private fun openAppSettings() {
        runCatching {
            startActivity(
                Intent(
                    Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.fromParts("package", packageName, null),
                ),
            )
        }
    }
}

@Composable
private fun VoiceTypingSettingsScreen(
    settings: VoiceTypingSettings,
    onOpenKeyboardSettings: () -> Unit,
    onOpenAppSettings: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val polishEnabled by settings.polishEnabled
        .collectAsState(initial = VoiceTypingSettings.DEFAULT_POLISH_ENABLED)

    val context = LocalContext.current
    var granted by remember {
        mutableStateOf(
            context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED,
        )
    }
    val requestPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { result -> granted = result }

    Column(
        modifier = Modifier
            .fillMaxSize()
            // targetSdk 36 means edge-to-edge is not optional: without this the
            // title draws under the status bar and the last paragraph under the
            // navigation bar. Applied outside the scroll so the bars clip the
            // content rather than scrolling with it.
            .safeDrawingPadding()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
    ) {
        Text(
            text = stringResource(R.string.ime_settings_title),
            style = MaterialTheme.typography.headlineSmall,
            color = MaterialTheme.colorScheme.onBackground,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = stringResource(R.string.ime_settings_intro),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Spacer(Modifier.height(24.dp))

        // ── microphone ────────────────────────────────────────────────────────
        Text(
            text = stringResource(R.string.ime_settings_microphone),
            style = MaterialTheme.typography.titleMedium,
            color = MaterialTheme.colorScheme.onBackground,
        )
        Spacer(Modifier.height(4.dp))
        Text(
            text = stringResource(
                if (granted) R.string.ime_settings_microphone_granted
                else R.string.ime_settings_microphone_needed,
            ),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (!granted) {
            Spacer(Modifier.height(12.dp))
            Button(onClick = { requestPermission.launch(Manifest.permission.RECORD_AUDIO) }) {
                Text(stringResource(R.string.meeting_permission_grant))
            }
            Spacer(Modifier.height(8.dp))
            Button(onClick = onOpenAppSettings) {
                Text(stringResource(R.string.meeting_permission_settings))
            }
        }

        Spacer(Modifier.height(24.dp))

        // ── the cleanup pass ──────────────────────────────────────────────────
        Row(
            modifier = Modifier.fillMaxWidth(),
            // Top, not centre: the explanation is a long paragraph, and a switch
            // centred against it floats in the middle of the prose instead of
            // sitting next to the thing it switches.
            verticalAlignment = Alignment.Top,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column(modifier = Modifier.weight(1f).padding(end = 16.dp)) {
                Text(
                    text = stringResource(R.string.ime_settings_polish),
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onBackground,
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    text = stringResource(R.string.ime_settings_polish_detail),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Switch(
                checked = polishEnabled,
                onCheckedChange = { value -> scope.launch { settings.setPolishEnabled(value) } },
            )
        }

        Spacer(Modifier.height(24.dp))

        // ── how to turn it on ─────────────────────────────────────────────────
        Text(
            text = stringResource(R.string.ime_settings_enable),
            style = MaterialTheme.typography.titleMedium,
            color = MaterialTheme.colorScheme.onBackground,
        )
        Spacer(Modifier.height(4.dp))
        Text(
            text = stringResource(R.string.ime_settings_enable_detail),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(12.dp))
        Button(onClick = onOpenKeyboardSettings) {
            Text(stringResource(R.string.ime_settings_enable_action))
        }

        Spacer(Modifier.height(24.dp))

        // ── what it does not do ───────────────────────────────────────────────
        Text(
            text = stringResource(R.string.ime_settings_privacy),
            style = MaterialTheme.typography.titleMedium,
            color = MaterialTheme.colorScheme.onBackground,
        )
        Spacer(Modifier.height(4.dp))
        Text(
            text = stringResource(R.string.ime_settings_privacy_detail),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
