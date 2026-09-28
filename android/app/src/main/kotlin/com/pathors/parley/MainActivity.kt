package com.pathors.parley

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.lifecycle.lifecycleScope
import com.pathors.parley.auth.AuthCallback
import com.pathors.parley.auth.SignInError
import com.pathors.parley.screenshot.DemoMode
import com.pathors.parley.ui.ParleyRoot
import com.pathors.parley.ui.theme.ParleyTheme
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
        // A recreated activity (rotation, say) is handed its original intent
        // again; that is not a new foreground arriving by a link.
        handleDeepLink(intent, arriving = savedInstanceState == null)
        setContent {
            ParleyTheme {
                ParleyRoot()
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleDeepLink(intent, arriving = true)
    }

    private fun handleDeepLink(intent: Intent?, arriving: Boolean) {
        val uri = intent?.data ?: return
        val container = parleyContainer
        // Whoever sent a link was in the middle of something; this foreground
        // is not the moment for the What's New sheet (see WhatsNewPresenter).
        if (arriving) container.whatsNew.noteOpenedByDeepLink()
        // Screenshot demo first: it claims only `parley://demo/…` in debug builds
        // and hands everything else straight on to the sign-in handler.
        if (DemoMode.handle(uri)) return
        lifecycleScope.launch {
            when (val result = container.auth.handleAuthCallback(uri)) {
                is AuthCallback.Success -> container.completeSignIn()
                is AuthCallback.Failure -> container.setAuthError(SignInError.fromCallback(result.reason))
                AuthCallback.Ignored -> Unit
            }
        }
    }
}
