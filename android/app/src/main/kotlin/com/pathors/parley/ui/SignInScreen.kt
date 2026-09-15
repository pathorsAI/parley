package com.pathors.parley.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.pathors.parley.AppContainer
import com.pathors.parley.R
import com.pathors.parley.auth.CustomTabsLauncher

/**
 * The sign-in affordance: one button, what it is doing, and what went wrong.
 *
 * Sign-in happens in a Custom Tab on our own origin, so the app never sees a
 * credential and "continue with Google" works through the browser's session.
 * There is no result callback: the page redirects to `parley://auth-callback`,
 * `MainActivity` receives it, and the stored token flipping to non-null is what
 * takes the signed-out screen away.
 *
 * This used to be a whole screen — the wall itself. It is a fragment now because
 * the wall is [OnboardingScreen], which has a pitch above this and has to pin
 * this to the bottom; the sign-in mechanics are the part that had nothing to do
 * with either. Nothing about the hand-off changed.
 */
@Composable
fun SignInCallToAction(container: AppContainer, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val error by container.authError.collectAsState()
    var waiting by remember { mutableStateOf(false) }
    var noBrowser by remember { mutableStateOf(false) }

    Column(
        modifier = modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Button(
            onClick = {
                container.setAuthError(null)
                noBrowser = false
                val launched = CustomTabsLauncher.launchSignIn(context, container.auth)
                noBrowser = !launched
                waiting = launched
            },
            enabled = !waiting,
            // `heightIn`, not `height`: at the largest font scales the label
            // wraps to two lines, and a fixed 52dp would clip it.
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 52.dp),
        ) {
            if (waiting) {
                CircularProgressIndicator(
                    modifier = Modifier.size(18.dp),
                    strokeWidth = 2.dp,
                    color = MaterialTheme.colorScheme.onPrimary,
                )
                Spacer(Modifier.width(8.dp))
            }
            Text(
                text = stringResource(
                    if (waiting) R.string.sign_in_in_progress else R.string.sign_in_button
                ),
                textAlign = TextAlign.Center,
            )
        }

        if (waiting) {
            Text(
                text = stringResource(R.string.sign_in_waiting),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            // The Custom Tab hands nothing back when the user simply closes it,
            // so the way out of "waiting" is an explicit retry.
            TextButton(onClick = { waiting = false }) {
                Text(stringResource(R.string.action_retry))
            }
        }

        val message = when {
            noBrowser -> stringResource(R.string.sign_in_no_browser)
            error != null -> stringResource(R.string.sign_in_failed, error.orEmpty())
            else -> null
        }
        if (message != null) {
            Text(
                text = message,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
                textAlign = TextAlign.Center,
            )
        }
    }
}
