package com.pathors.parley

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.lifecycle.lifecycleScope
import com.pathors.parley.auth.AuthCallback
import com.pathors.parley.screenshot.DemoMode
import com.pathors.parley.ui.ParleyRoot
import com.pathors.parley.ui.theme.ParleyTheme
import com.pathors.parley.voicetyping.VoiceTypingSetup
import kotlinx.coroutines.launch

/**
 * The app's only activity: one Compose surface, plus the sign-in hand-off.
 *
 * `launchMode="singleTask"` (see AndroidManifest.xml) means the hosted sign-in
 * page's `parley://auth-callback?token=…` redirect arrives here — as the launch
 * intent on a cold start, or through [onNewIntent] when the app is already up —
 * rather than starting a second copy of the app.
 *
 * The same door takes `parley://demo/…` in debug builds, which is how the store
 * screenshots are driven (see [DemoMode]).
 */
class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handleDeepLink(intent)
        setContent {
            ParleyTheme {
                ParleyRoot()
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleDeepLink(intent)
    }

    private fun handleDeepLink(intent: Intent?) {
        val uri = intent?.data ?: return
        // Screenshot demo first: it claims only `parley://demo/…` in debug builds
        // and hands everything else straight on to the sign-in handler.
        if (DemoMode.handle(uri)) return
        // The voice keyboard's hand-off. It cannot request RECORD_AUDIO itself, so
        // it sends the user here; the navigation graph picks the request up (see
        // VoiceTypingSetup.SetupRequest) once it is mounted, which may be after
        // the sign-in wall comes down.
        if (VoiceTypingSetup.SetupRequest.handle(uri)) return
        val container = parleyContainer
        lifecycleScope.launch {
            when (val result = container.auth.handleAuthCallback(uri)) {
                is AuthCallback.Success -> container.onSignedIn()
                is AuthCallback.Failure -> container.setAuthError(result.reason)
                AuthCallback.Ignored -> Unit
            }
        }
    }
}
