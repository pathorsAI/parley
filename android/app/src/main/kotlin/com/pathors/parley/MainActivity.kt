package com.pathors.parley

import android.app.Activity
import android.content.Intent
import android.os.Build
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

    /**
     * "Report this screen?" after a screenshot — Android 14+, where the system
     * tells an app its own window was captured (`DETECT_SCREEN_CAPTURE`, a
     * normal permission granted at install). Older versions have no such
     * signal and get no prompt: there is no honest way to detect a screenshot
     * below 14 without reading the photo library, which this app will not do.
     *
     * Registered only while the activity is visible (the platform requires
     * it); see `FeedbackCenter.screenshotTaken` for what happens next.
     */
    private val screenCaptureCallback: Any? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            Activity.ScreenCaptureCallback { parleyContainer.feedback.screenshotTaken(this) }
        } else {
            null
        }

    override fun onStart() {
        super.onStart()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val callback = screenCaptureCallback as Activity.ScreenCaptureCallback
            runCatching { registerScreenCaptureCallback(mainExecutor, callback) }
        }
    }

    override fun onStop() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val callback = screenCaptureCallback as Activity.ScreenCaptureCallback
            runCatching { unregisterScreenCaptureCallback(callback) }
        }
        super.onStop()
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
