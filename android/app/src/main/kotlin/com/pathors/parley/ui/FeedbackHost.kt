package com.pathors.parley.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.pathors.parley.R
import com.pathors.parley.auth.CustomTabsLauncher
import com.pathors.parley.feedback.FeedbackCenter
import com.pathors.parley.feedback.FeedbackNotice
import com.pathors.parley.feedback.ReportDraft
import kotlinx.coroutines.withTimeoutOrNull

/**
 * The feedback surfaces that belong to no one screen, drawn once over all of
 * them from [ParleyRoot]:
 *
 * - the **report sheet** ("Report a problem"), opened from the account sheet or
 *   from a screenshot prompt;
 * - the **crash banner**, when the last process crashed and automatic crash
 *   reports are off;
 * - the **bottom notices**, one at a time: "Sent. Thank you.", the five-second
 *   offer after deleting a broken recording, and the five-second "Report this
 *   screen?" after a screenshot.
 *
 * Here rather than in each screen so a prompt raised while one screen is up
 * (a crash found at launch, a screenshot of any page) has somewhere to appear,
 * and so no screen can forget to host them.
 *
 * The overlay takes no touches of its own: everything under it works while a
 * notice is up, which is what "does not get in the way" means for the two
 * five-second offers.
 */
@Composable
fun FeedbackHost(feedback: FeedbackCenter) {
    val draft by feedback.draft.collectAsState()
    val crashOffer by feedback.crashOffer.collectAsState()
    val snackbar = remember { SnackbarHostState() }
    // The screenshot offer gets a host of its own at the top: for the five
    // seconds it is up, Android's own screenshot preview and toolbar own the
    // bottom of the screen, and an offer down there sits under them, untappable.
    val topSnackbar = remember { SnackbarHostState() }
    val context = LocalContext.current

    LaunchedEffect(feedback) {
        feedback.notices.collect { notice ->
            when (notice) {
                FeedbackNotice.Sent -> snackbar.showSnackbar(
                    message = context.getString(R.string.feedback_sent),
                    duration = SnackbarDuration.Short,
                )

                is FeedbackNotice.DeleteOffer -> {
                    val answer = snackbar.showFor(
                        message = context.getString(R.string.feedback_delete_offer),
                        action = context.getString(R.string.feedback_delete_offer_action),
                    )
                    feedback.answerDeleteOffer(notice.recording, accepted = answer == SnackbarResult.ActionPerformed)
                }

                is FeedbackNotice.ScreenshotOffer -> {
                    val answer = topSnackbar.showFor(
                        message = context.getString(R.string.feedback_screenshot_offer),
                        action = context.getString(R.string.feedback_screenshot_offer_action),
                    )
                    feedback.answerScreenshotOffer(notice.screen, report = answer == SnackbarResult.ActionPerformed)
                }
            }
        }
    }

    Box(Modifier.fillMaxSize()) {
        if (crashOffer) {
            CrashBanner(
                onAnswer = feedback::answerCrashOffer,
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .statusBarsPadding()
                    .padding(horizontal = 12.dp, vertical = 8.dp),
            )
        }
        SnackbarHost(
            hostState = topSnackbar,
            modifier = Modifier
                .align(Alignment.TopCenter)
                .statusBarsPadding()
                .padding(top = 8.dp),
        )
        SnackbarHost(
            hostState = snackbar,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .navigationBarsPadding()
                // Clear of the library's record bar, which is where most
                // screenshots — and so most offers — are taken over.
                .padding(bottom = NOTICE_LIFT),
        )
    }

    draft?.let { current ->
        ReportSheet(
            draft = current,
            onSend = feedback::submitReport,
            onDismiss = feedback::closeReport,
            onOpenFaq = { CustomTabsLauncher.launch(context, ParleyLinks.SUPPORT) },
        )
    }
}

/**
 * A notice with an action that goes away by itself after [FIVE_SECONDS] —
 * Material's own durations are four or ten, and the spec says five. A timeout
 * reads as [SnackbarResult.Dismissed], which is what "ignored" is.
 */
private suspend fun SnackbarHostState.showFor(message: String, action: String): SnackbarResult =
    withTimeoutOrNull(FIVE_SECONDS) {
        showSnackbar(message = message, actionLabel = action, duration = SnackbarDuration.Indefinite)
    } ?: SnackbarResult.Dismissed

/**
 * "Parley closed unexpectedly last time" — only when automatic crash reports
 * are off, since otherwise the report has already gone. Two answers and a box:
 * the buttons are about this crash, the box about every one after it.
 */
@Composable
private fun CrashBanner(onAnswer: (send: Boolean, alwaysSend: Boolean) -> Unit, modifier: Modifier = Modifier) {
    var always by rememberSaveable { mutableStateOf(false) }
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.tertiaryContainer,
        contentColor = MaterialTheme.colorScheme.onTertiaryContainer,
        shadowElevation = 6.dp,
    ) {
        Column(Modifier.padding(start = 16.dp, end = 8.dp, top = 12.dp, bottom = 4.dp)) {
            Text(
                text = stringResource(R.string.feedback_crash_title),
                style = MaterialTheme.typography.titleSmall,
            )
            Text(
                text = stringResource(R.string.feedback_crash_body),
                style = MaterialTheme.typography.bodyMedium,
            )
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .toggleable(value = always, role = Role.Checkbox, onValueChange = { always = it }),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Checkbox(checked = always, onCheckedChange = null, modifier = Modifier.padding(end = 8.dp, top = 8.dp, bottom = 8.dp))
                Text(
                    text = stringResource(R.string.feedback_crash_always),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            Row(Modifier.align(Alignment.End), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = { onAnswer(false, always) }) {
                    Text(stringResource(R.string.feedback_crash_decline))
                }
                TextButton(onClick = { onAnswer(true, always) }) {
                    Text(stringResource(R.string.feedback_crash_send))
                }
            }
        }
    }
}

/**
 * "Report a problem": what happened, in the person's own words if they want
 * to give any, the screenshot it came with (removable), and a plain sentence
 * about what goes along with it. The FAQ is at the foot for the question that
 * is not a problem at all.
 *
 * Send is enabled with an empty box on purpose: the diagnostics alone are a
 * useful report, and making somebody type to be allowed to tell us something
 * broke is how nobody tells us.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ReportSheet(
    draft: ReportDraft,
    onSend: (message: String, keepScreenshot: Boolean) -> Unit,
    onDismiss: () -> Unit,
    onOpenFaq: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var message by rememberSaveable(draft) { mutableStateOf("") }
    var keepScreenshot by remember(draft) { mutableStateOf(draft.screen != null) }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        contentWindowInsets = { WindowInsets.systemBars.only(WindowInsetsSides.Vertical) },
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(start = 24.dp, end = 24.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = stringResource(R.string.feedback_report_title),
                style = MaterialTheme.typography.titleLarge,
            )
            OutlinedTextField(
                value = message,
                onValueChange = { message = it.take(MAX_MESSAGE_CHARS) },
                placeholder = { Text(stringResource(R.string.feedback_report_placeholder)) },
                minLines = 4,
                modifier = Modifier.fillMaxWidth(),
            )
            val screen = draft.screen
            if (screen != null && keepScreenshot) {
                Image(
                    bitmap = remember(screen) { screen.preview.asImageBitmap() },
                    contentDescription = stringResource(R.string.feedback_report_screenshot),
                    contentScale = ContentScale.Fit,
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = SCREENSHOT_PREVIEW_HEIGHT)
                        .clip(RoundedCornerShape(8.dp))
                        .border(0.5.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(8.dp)),
                )
                TextButton(onClick = { keepScreenshot = false }, contentPadding = LINK_PADDING) {
                    Text(stringResource(R.string.feedback_report_remove_screenshot))
                }
            }
            Text(
                text = stringResource(R.string.feedback_report_disclosure),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Button(onClick = { onSend(message, keepScreenshot) }, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.feedback_report_send))
            }
            TextButton(onClick = onOpenFaq, contentPadding = LINK_PADDING) {
                Text(stringResource(R.string.feedback_report_faq))
            }
        }
    }
}

private const val FIVE_SECONDS = 5_000L

/** The cloud keeps 2,000 characters; the box stops there so what is typed is what is kept. */
private const val MAX_MESSAGE_CHARS = 2_000

private val SCREENSHOT_PREVIEW_HEIGHT = 280.dp

/** Above the library's bottom bar, where the record buttons are. */
private val NOTICE_LIFT = 72.dp

private val LINK_PADDING = PaddingValues(start = 0.dp, top = 8.dp, end = 8.dp, bottom = 8.dp)
