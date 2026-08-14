package com.pathors.parley.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
 * The sign-in wall.
 *
 * Sign-in happens in a Custom Tab on our own origin, so the app never sees a
 * credential and "continue with Google" works through the browser's session.
 * There is no result callback: the page redirects to `parley://auth-callback`,
 * `MainActivity` receives it, and the stored token flipping to non-null is what
 * takes this screen away.
 */
@Composable
fun SignInScreen(container: AppContainer) {
    val context = LocalContext.current
    val error by container.authError.collectAsState()
    var waiting by remember { mutableStateOf(false) }
    var noBrowser by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = stringResource(R.string.app_name),
            style = MaterialTheme.typography.displaySmall,
        )
        Spacer(Modifier.height(12.dp))
        Text(
            text = stringResource(R.string.sign_in_tagline),
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(40.dp))

        if (waiting) {
            CircularProgressIndicator(Modifier.size(28.dp))
            Spacer(Modifier.height(16.dp))
            Text(
                text = stringResource(R.string.sign_in_waiting),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            // The Custom Tab hands nothing back when the user simply closes it,
            // so the way out of "waiting" is an explicit retry.
            TextButton(onClick = { waiting = false }) {
                Text(stringResource(R.string.action_retry))
            }
        } else {
            Button(
                onClick = {
                    container.setAuthError(null)
                    val launched = CustomTabsLauncher.launchSignIn(context, container.auth)
                    noBrowser = !launched
                    waiting = launched
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(52.dp),
            ) {
                Text(stringResource(R.string.sign_in_button))
            }
        }

        val message = when {
            noBrowser -> stringResource(R.string.sign_in_no_browser)
            error != null -> stringResource(R.string.sign_in_failed, error.orEmpty())
            else -> null
        }
        if (message != null) {
            Spacer(Modifier.height(20.dp))
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
                textAlign = TextAlign.Center,
            )
        }
    }
}
