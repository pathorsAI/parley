package com.pathors.parley.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.pathors.parley.R
import com.pathors.parley.filing.FilingPhase
import com.pathors.parley.filing.FilingUiState
import com.pathors.parley.kit.FilingFolderSuggestion

/**
 * The filing suggestion on the meeting screen: the name this recording could
 * have, and the folder it could live in — as **one decision**. The Android half
 * of iOS `FilingSuggestionCard`.
 *
 * It is a suggestion, not a control, and is drawn like one: a small secondary
 * heading, the suggestion in plain ink, the actions as text buttons. No card,
 * no border, no AI sparkle — nothing here happens on its own and nothing here
 * is destructive, so nothing here needs to shout.
 *
 * One verb takes the whole answer (the proposed name and the best folder, with
 * its reason in full — the reason is what makes a folder trustworthy without
 * opening the recording). `Adjust` is where the rest of the answer lives, and
 * `Skip suggestion` is the way out, reading as the pair to accepting rather
 * than as a way to close a window.
 */
@Composable
fun FilingSuggestionBlock(
    state: FilingUiState,
    onAccept: () -> Unit,
    onAdjust: () -> Unit,
    onSkip: () -> Unit,
    modifier: Modifier = Modifier,
) {
    if (state.phase == FilingPhase.THINKING) {
        FilingThinking(modifier)
        return
    }
    if (state.phase != FilingPhase.OFFERING || !state.hasSomethingToOffer) return
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            text = stringResource(R.string.filing_heading),
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.semantics { heading() },
        )
        state.proposedTitle?.let { ProposedTitle(it, state.currentTitle) }
        state.proposedFolder?.let { ProposedFolder(it) }
        if (state.writeFailed) WriteFailed()
        FilingActions(busy = state.isWriting, onAccept = onAccept, onAdjust = onAdjust, onSkip = onSkip)
    }
}

/**
 * The pass is reading the meeting. Said out loud, because it is the reason the
 * screen has not gone back to the library the way it used to.
 */
@Composable
private fun FilingThinking(modifier: Modifier) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
        Spacer(Modifier.width(10.dp))
        Text(
            text = stringResource(R.string.filing_thinking),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/**
 * The proposed name, and under it the name the recording carries now: a title
 * on its own gives nothing to judge it against, and the clock name is exactly
 * what the suggestion exists to replace.
 */
@Composable
private fun ProposedTitle(proposed: String, current: String) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
            text = proposed,
            style = MaterialTheme.typography.titleLarge,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            text = stringResource(R.string.filing_was, current),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * The folder, and why. A folder that does not exist yet reads as one being
 * created rather than one to move into — accepting is what brings it into
 * being. The reason wraps; a clipped reason is a reason nobody can act on.
 */
@Composable
private fun ProposedFolder(folder: FilingFolderSuggestion) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                imageVector = LibraryIcons.Folder,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(18.dp),
            )
            Spacer(Modifier.width(6.dp))
            Text(
                text = stringResource(
                    if (folder.folderId == null) R.string.filing_new_folder else R.string.filing_folder,
                ),
                style = MaterialTheme.typography.bodyMedium,
            )
            Icon(
                imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.outline,
                modifier = Modifier.size(18.dp),
            )
            Text(
                text = folder.name,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (folder.reason.isNotEmpty()) {
            Text(
                text = folder.reason,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun WriteFailed() {
    Text(
        text = stringResource(R.string.filing_write_failed),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.error,
    )
}

/**
 * One verb, then the two ways around it. Everything is inert while a push is
 * in flight: a second tap would push a copy of the meta read before the first
 * landed.
 */
@Composable
private fun FilingActions(busy: Boolean, onAccept: () -> Unit, onAdjust: () -> Unit, onSkip: () -> Unit) {
    Row(
        modifier = Modifier.heightIn(min = 48.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (busy) {
            CircularProgressIndicator(
                modifier = Modifier
                    .padding(horizontal = 12.dp)
                    .size(18.dp),
                strokeWidth = 2.dp,
            )
        } else {
            TextButton(onClick = onAccept) {
                Text(stringResource(R.string.filing_save_suggested), fontWeight = FontWeight.SemiBold)
            }
        }
        TextButton(onClick = onAdjust, enabled = !busy) {
            Text(stringResource(R.string.filing_adjust))
        }
        TextButton(onClick = onSkip, enabled = !busy) {
            Text(
                text = stringResource(R.string.filing_skip),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** One selectable folder row in the Adjust sheet: a name, an optional tag and reason, a tick. */
@Composable
internal fun FilingChoiceRow(
    name: String,
    reason: String,
    isNew: Boolean,
    chosen: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clickable(enabled = enabled, onClick = onClick)
            .semantics { selected = chosen }
            .padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = name,
                    style = MaterialTheme.typography.bodyLarge,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (isNew) {
                    Spacer(Modifier.width(6.dp))
                    Text(
                        text = stringResource(R.string.filing_new_tag),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            if (reason.isNotEmpty()) {
                Text(
                    text = reason,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        ChoiceTick(chosen)
    }
}
