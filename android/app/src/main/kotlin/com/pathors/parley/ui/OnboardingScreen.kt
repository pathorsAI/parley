package com.pathors.parley.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.dp
import com.pathors.parley.AppContainer
import com.pathors.parley.R
import com.pathors.parley.ui.theme.ParleyTextStyles

/**
 * Signed out — the screen a cold Play Store install lands on: the first two
 * steps of the onboarding wizard ([OnboardingWizard]), the welcome demo and the
 * choice of how to run Parley, in front of the sign-in wall. iOS `OnboardingView`.
 *
 * Recording on the phone streams through the account's hosted relay, so there
 * is nothing to do before signing in; the welcome says what the app does before
 * the account step asks for one. A sign-in started there swaps this out for the
 * library, and `ParleyRoot` puts the rest of the wizard over it.
 *
 * It resumes on the account step when that is where it was left — leaving for
 * the browser to sign in and coming back without finishing must not bounce the
 * user back to the start.
 */
@Composable
fun OnboardingScreen(container: AppContainer) {
    val start = remember {
        if (OnboardingStep.fromKey(container.onboarding.step.value) == OnboardingStep.ACCOUNT) {
            OnboardingStep.ACCOUNT
        } else {
            OnboardingStep.INTRO
        }
    }
    OnboardingWizard(
        container = container,
        start = start,
        hasAccount = false,
        // Skip is disabled before there is an account; nothing else finishes here.
        onFinish = {},
    )
}

/**
 * The moment between launch and the stored session being read back.
 *
 * What was here was a bare spinner on an empty page. Reading the auth DataStore
 * takes a frame or two, and in that gap a returning user saw an anonymous
 * loading screen — or, on a slow cold start, the onboarding wall flashing by
 * before their session resolved. Naming the app is the whole fix, and it is what
 * iOS `LaunchView` does.
 */
@Composable
fun LaunchScreen() {
    val loading = stringResource(R.string.launch_loading)
    Column(
        modifier = Modifier
            .fillMaxSize()
            .clearAndSetSemantics { contentDescription = loading },
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = stringResource(R.string.app_name),
            style = ParleyTextStyles.wordmark,
            color = MaterialTheme.colorScheme.onSurface,
        )
        Spacer(Modifier.height(18.dp))
        CircularProgressIndicator(Modifier.size(28.dp))
    }
}
