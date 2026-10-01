package com.pathors.parley.ui

import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.pathors.parley.R
import com.pathors.parley.feedback.RetranscribeTag

/**
 * The inline "send us diagnostics" prompts — the ones that sit in a screen at
 * the place the problem is, rather than floating over it (those live in
 * [FeedbackHost]).
 *
 * All of them are one tap to send: the report goes with the recording's id
 * and the phone's state attached, and nothing to fill in. That is the point of
 * raising them at all — somebody whose meeting just failed to transcribe will
 * tap once; they will not write an email.
 *
 * Quiet by design: a tinted strip, never a dialog, never red. The recording is
 * what the screen is about; the prompt is an offer beside it.
 */
@Composable
internal fun DiagnosticsPrompt(
    text: String,
    onSend: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    /** A second action beside Send — "Transcribe again" on the truncated banner. */
    secondary: (@Composable () -> Unit)? = null,
) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.secondaryContainer,
        contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
    ) {
        Row(
            modifier = Modifier.padding(start = 14.dp, top = 6.dp, bottom = 4.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Column(Modifier.weight(1f).padding(top = 6.dp)) {
                Text(text = text, style = MaterialTheme.typography.bodyMedium)
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    TextButton(onClick = onSend, contentPadding = PROMPT_BUTTON_PADDING) {
                        Text(stringResource(R.string.feedback_send_diagnostics))
                    }
                    secondary?.invoke()
                }
            }
            DismissButton(onDismiss)
        }
    }
}

/**
 * A transcript with nothing in it (20 s or more of audio, not one segment):
 * says so plainly instead of the old one-line "no transcript", and offers the
 * two things that can help — telling us, and transcribing again.
 *
 * [onSend] is null when the prompt is resting ([com.pathors.parley.feedback.PromptGate]):
 * the explanation and "Transcribe again" are still true and still useful.
 */
@Composable
internal fun EmptyTranscriptState(
    minutes: Int,
    onSend: (() -> Unit)?,
    onRetranscribe: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            text = stringResource(R.string.feedback_empty_title),
            style = MaterialTheme.typography.titleMedium,
            textAlign = TextAlign.Center,
        )
        Text(
            text = pluralStringResource(R.plurals.feedback_empty_body, minutes, minutes),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        FlowRowCentered {
            if (onSend != null) {
                TextButton(onClick = onSend) { Text(stringResource(R.string.feedback_send_diagnostics)) }
            }
            if (onRetranscribe != null) {
                TextButton(onClick = onRetranscribe) { Text(stringResource(R.string.retranscribe_action)) }
            }
        }
    }
}

/**
 * "What was wrong last time?" with four answers, after a re-transcription has
 * landed on screen. Picking one *is* sending it — the answer and the new
 * transcript's shape go together — so there is no Send button to find.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun RetranscribeChips(
    onPick: (RetranscribeTag) -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.secondaryContainer,
        contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
    ) {
        Row(Modifier.padding(start = 14.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f).padding(top = 6.dp)) {
                Text(
                    text = stringResource(R.string.feedback_retranscribe_ask),
                    style = MaterialTheme.typography.bodyMedium,
                )
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    RetranscribeTag.entries.forEach { tag ->
                        SuggestionChip(
                            onClick = { onPick(tag) },
                            label = { Text(stringResource(retranscribeTagLabel(tag))) },
                        )
                    }
                }
            }
            DismissButton(onDismiss)
        }
    }
}

@StringRes
internal fun retranscribeTagLabel(tag: RetranscribeTag): Int = when (tag) {
    RetranscribeTag.MISHEARD -> R.string.retranscribe_tag_misheard
    RetranscribeTag.MISSING -> R.string.retranscribe_tag_missing
    RetranscribeTag.SPEAKERS -> R.string.retranscribe_tag_speakers
    RetranscribeTag.OTHER -> R.string.retranscribe_tag_other
}

@Composable
private fun DismissButton(onDismiss: () -> Unit) {
    IconButton(onClick = onDismiss) {
        Icon(
            Icons.Default.Close,
            contentDescription = stringResource(R.string.feedback_dismiss),
            modifier = Modifier.size(18.dp),
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FlowRowCentered(content: @Composable () -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterHorizontally)) { content() }
}

/** Send starts at the text's left edge, the way a link in a sentence would. */
private val PROMPT_BUTTON_PADDING = PaddingValues(horizontal = 0.dp, vertical = 8.dp)
