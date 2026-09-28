package com.pathors.parley.ui

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import com.pathors.parley.R
import com.pathors.parley.auth.CustomTabsLauncher
import com.pathors.parley.kit.Announcement
import com.pathors.parley.onboarding.WhatsNewPresenter
import com.pathors.parley.ui.theme.ParleyTheme
import com.pathors.parley.ui.theme.ThemePreference
import kotlinx.coroutines.launch

private const val TAG = "WhatsNew"

/**
 * Hosts the What's New sheet over the signed-in library: tells the
 * [WhatsNewPresenter] when the library is on screen, and draws whatever it
 * presents. Lives next to `HomeScreen` in the navigation graph's home
 * destination, which only exists behind the sign-in wall.
 */
@Composable
fun WhatsNewHost(presenter: WhatsNewPresenter) {
    val context = LocalContext.current
    val presented by presenter.presented.collectAsState()

    DisposableEffect(presenter) {
        presenter.homeAppeared()
        onDispose { presenter.homeDisappeared() }
    }

    presented?.let { announcement ->
        WhatsNewSheet(
            announcement = announcement,
            // The button closes the sheet, then follows `cta.android` if the
            // announcement has one — read off the announcement drawn, not the
            // presenter, which has let go of it by now.
            onDone = {
                presenter.dismissed()
                announcement.cta?.android?.takeIf { it.isNotBlank() }?.let { openCallToAction(context, it) }
            },
            onDismiss = presenter::dismissed,
        )
    }
}

/**
 * The What's New sheet: one announcement, once, after an update — iOS
 * `WhatsNewSheet`, in the platform's own frame (a Material 3 bottom sheet, the
 * same component as the account sheet, which a swipe, the scrim and the system
 * back all close).
 *
 * Plain on purpose: a small badge naming the release in the one accent colour,
 * a title that says what the user will now *see*, a sentence of how, a
 * hairline, and one line of whatever else changed. One filled button, because
 * it is the one action on the surface. No hero: Android's hero registry is
 * empty, and the sheet is complete without one.
 *
 * ## Height
 *
 * As tall as what it says, never a fixed half-screen with a gap under the
 * button: fully expanded (there is no half state to stop at) and sized to its
 * content. When the content outgrows the screen — the largest font scales do —
 * the text scrolls and the button stays pinned below it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WhatsNewSheet(
    announcement: Announcement,
    onDone: () -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val copy = announcement.copyFor(stringResource(R.string.whats_new_copy_language)) ?: return

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        WhatsNewContent(
            copy = copy,
            onDone = {
                // Slide away first, then report: the sheet leaves the
                // composition the moment the presenter lets go of it.
                scope.launch { sheetState.hide() }.invokeOnCompletion { onDone() }
            },
        )
    }
}

@Composable
private fun WhatsNewContent(copy: Announcement.Copy, onDone: () -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .weight(1f, fill = false)
                .verticalScroll(rememberScrollState())
                .padding(start = 24.dp, end = 24.dp, top = 8.dp, bottom = 20.dp),
        ) {
            Text(
                text = copy.badge,
                style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold),
                color = MaterialTheme.colorScheme.primary,
            )
            Text(
                text = copy.title,
                style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Bold),
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier
                    .padding(top = 6.dp)
                    .semantics { heading() },
            )
            Text(
                text = copy.body,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 8.dp),
            )
            HorizontalDivider(
                modifier = Modifier.padding(vertical = 16.dp),
                color = MaterialTheme.colorScheme.outlineVariant,
            )
            // "**Also** long dictations now scroll…" — the prefix from this
            // app's strings, the rest from the announcement.
            val alsoLabel = stringResource(R.string.whats_new_also)
            val onSurface = MaterialTheme.colorScheme.onSurface
            Text(
                text = buildAnnotatedString {
                    withStyle(SpanStyle(fontWeight = FontWeight.Bold, color = onSurface)) {
                        append(alsoLabel)
                    }
                    append(" ")
                    append(copy.also)
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Button(
            onClick = onDone,
            // `heightIn`, not `height`: at the largest font scales the label
            // wraps, and a fixed height would clip it.
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 24.dp, end = 24.dp, top = 4.dp)
                .heightIn(min = 52.dp),
        ) {
            Text(copy.button)
        }
        Spacer(Modifier.height(16.dp))
    }
}

/**
 * The announcement's `cta.android`: a web page in a Custom Tab, anything else
 * (a `parley://` link, another app's scheme) as a plain view intent. A link
 * nothing can open is dropped — the sheet is already closed, which is what
 * the button says it does anyway.
 */
private fun openCallToAction(context: Context, link: String) {
    val uri = link.toUri()
    if (uri.scheme == "https" || uri.scheme == "http") {
        CustomTabsLauncher.launch(context, link)
        return
    }
    val intent = Intent(Intent.ACTION_VIEW, uri)
    if (context !is Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
        context.startActivity(intent)
    } catch (e: ActivityNotFoundException) {
        Log.w(TAG, "nothing can open the announcement's link", e)
    }
}

/** A fixture for the preview only — the real copy is the repository's `announcements/` folder. */
private val previewCopy = Announcement.Copy(
    badge = "New in 1.17",
    title = "See what changed after an update",
    body = "After an update, Parley shows one short note about what is new, once. Swipe it away and it is gone.",
    also = "Your account now shows your organizations and your role in each.",
    button = "Got it",
)

@Preview(showBackground = true)
@Composable
private fun WhatsNewContentPreview() {
    ParleyTheme(preference = ThemePreference.LIGHT) {
        Surface { WhatsNewContent(copy = previewCopy, onDone = {}) }
    }
}
