package com.pathors.parley.auth

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent

/**
 * Opens the hosted sign-in page in a Custom Tab — the Android counterpart of the
 * iOS `ASWebAuthenticationSession`. A Custom Tab shares the browser's cookie jar
 * and password manager, which is what makes "continue with Google" work and what
 * keeps credentials out of the app process entirely.
 *
 * There is no result callback: the page finishes by redirecting to
 * `parley://auth-callback?token=…`, which arrives as a new intent on
 * `MainActivity` (`launchMode="singleTask"` + the manifest intent filter) and
 * should be handed to [AuthManager.handleAuthCallback].
 */
object CustomTabsLauncher {

    /** Open the account's sign-in page. Returns false when no browser took it. */
    fun launchSignIn(context: Context, auth: AuthManager): Boolean =
        launch(context, auth.signInUrl())

    /** Open an arbitrary https URL in a Custom Tab, falling back to any browser. */
    fun launch(context: Context, url: String): Boolean {
        val uri = Uri.parse(url)
        val intent = CustomTabsIntent.Builder()
            .setShowTitle(true)
            .setUrlBarHidingEnabled(true)
            .build()
        // A non-Activity context (application, service) cannot start an activity
        // in the caller's task.
        if (context !is Activity) intent.intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            intent.launchUrl(context, uri)
            true
        } catch (_: ActivityNotFoundException) {
            // No Custom Tabs provider: a plain VIEW intent still reaches any
            // installed browser (implicit intents are exempt from package
            // visibility filtering, so no <queries> entry is needed).
            try {
                val view = Intent(Intent.ACTION_VIEW, uri)
                if (context !is Activity) view.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(view)
                true
            } catch (_: ActivityNotFoundException) {
                false
            }
        }
    }
}
