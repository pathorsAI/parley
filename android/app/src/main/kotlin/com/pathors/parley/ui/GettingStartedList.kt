package com.pathors.parley.ui

import androidx.annotation.StringRes
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.pathors.parley.R
import com.pathors.parley.kit.GettingStartedState
import com.pathors.parley.kit.GettingStartedStep
import com.pathors.parley.ui.theme.ParleyTheme
import com.pathors.parley.ui.theme.ThemePreference

/**
 * The getting-started checklist: four plain rows, each ticked only by the real
 * event (see `GettingStartedStore`), never by a tap on the row. iOS
 * `GettingStartedList`, as onboarding v2 (#450) left it.
 *
 * Demoted in v2. The rows used to be doors — a chevron each, opening the newest
 * recording "to file it" or "to share it" — and the verdict on iOS was that the
 * list ticked but the recording it opened never said what to do. The teaching
 * now happens on the recording (the guide bar); the list is the scoreboard. So
 * the rows keep their ticks and titles and lose their actions and detail lines,
 * and the header carries the one way in: walk through the sample, or continue
 * the lap already started ([ChecklistAction]).
 *
 * Rows, hairlines and text, no card: the list is part of the page, not a promo
 * sitting on it. The one colour is the success green on a done item's check and
 * the tint on what can be tapped.
 */
@Composable
fun GettingStartedList(
    state: GettingStartedState,
    header: ChecklistHeader,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxWidth()) {
        Header(state, onDismiss = header.onDismiss)
        HeaderAction(header, Modifier.padding(bottom = 6.dp))
        GettingStartedStep.entries.forEach { step ->
            HorizontalDivider(thickness = 0.5.dp, color = MaterialTheme.colorScheme.outlineVariant)
            StepRow(step = step, done = state[step])
        }
    }
}

/**
 * The header's one action and "Not now", gathered so the call site stays
 * readable.
 */
data class ChecklistHeader(
    val action: ChecklistAction,
    /** The sample's 1.5 s "Transcribing…" moment is up; it stands in for [action]. */
    val transcribing: Boolean,
    val onWalkThrough: () -> Unit,
    val onContinue: () -> Unit,
    val onDismiss: () -> Unit,
)

@Composable
private fun Header(state: GettingStartedState, onDismiss: () -> Unit) {
    val spokenProgress = stringResource(
        R.string.getting_started_progress_spoken,
        state.done,
        GettingStartedState.TOTAL,
    )
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = stringResource(R.string.getting_started_title),
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            text = "${state.done} / ${GettingStartedState.TOTAL}",
            style = MaterialTheme.typography.labelMedium.copy(fontFeatureSettings = "tnum"),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.clearAndSetSemantics { contentDescription = spokenProgress },
        )
        Box(Modifier.weight(1f))
        TextButton(onClick = onDismiss) {
            Text(stringResource(R.string.getting_started_not_now))
        }
    }
}

/**
 * "Walk through it with the sample recording", "Continue →", or — for the
 * transcribing beat — a spinner and "Transcribing…" in the same place, so the
 * list does not jump when one swaps for the other.
 */
@Composable
private fun HeaderAction(header: ChecklistHeader, modifier: Modifier = Modifier) {
    val slot = modifier.heightIn(min = ACTION_HEIGHT)
    when {
        header.transcribing -> Row(
            modifier = slot.semantics(mergeDescendants = true) {},
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
            Text(
                text = stringResource(R.string.getting_started_transcribing),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        header.action == ChecklistAction.WALK_THROUGH ->
            ActionButton(R.string.getting_started_walk_through, header.onWalkThrough, slot)

        header.action == ChecklistAction.CONTINUE_LAP ->
            ActionButton(R.string.getting_started_continue, header.onContinue, slot)

        else -> Unit
    }
}

/** A text-weight blue button, flush with the title above it. */
@Composable
private fun ActionButton(@StringRes label: Int, onClick: () -> Unit, modifier: Modifier) {
    Box(modifier, contentAlignment = Alignment.CenterStart) {
        TextButton(
            onClick = onClick,
            contentPadding = PaddingValues(horizontal = 0.dp),
        ) {
            Text(text = stringResource(label), fontWeight = FontWeight.SemiBold)
        }
    }
}

/** The mark and the words, one element to TalkBack with "Done" as its state. */
@Composable
private fun StepRow(step: GettingStartedStep, done: Boolean) {
    val doneLabel = stringResource(R.string.getting_started_done)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 10.dp)
            .semantics(mergeDescendants = true) { if (done) stateDescription = doneLabel },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        CheckMark(done)
        Text(
            text = stringResource(titleOf(step)),
            style = MaterialTheme.typography.bodyMedium,
            color = if (done) {
                MaterialTheme.colorScheme.onSurfaceVariant
            } else {
                MaterialTheme.colorScheme.onSurface
            },
        )
    }
}

/** A filled green check when done, an empty ring when not — the ring drawn, since the core icon set has none. */
@Composable
private fun CheckMark(done: Boolean) {
    if (done) {
        Icon(
            imageVector = Icons.Filled.CheckCircle,
            contentDescription = null,
            tint = ParleyTheme.colors.success,
            modifier = Modifier.size(22.dp),
        )
    } else {
        Box(
            Modifier
                .padding(2.dp)
                .size(18.dp)
                .border(1.5.dp, MaterialTheme.colorScheme.outline, CircleShape),
        )
    }
}

@StringRes
private fun titleOf(step: GettingStartedStep): Int = when (step) {
    GettingStartedStep.RECORDED -> R.string.getting_started_recorded
    GettingStartedStep.FILED -> R.string.getting_started_filed
    GettingStartedStep.REPLAYED -> R.string.getting_started_replayed
    GettingStartedStep.SHARED_TO_AI -> R.string.getting_started_shared
}

/** Tall enough for a text button, so the spinner line and the button line are the same height. */
private val ACTION_HEIGHT = 40.dp

// ── previews ─────────────────────────────────────────────────────────────────

private fun previewHeader(action: ChecklistAction, transcribing: Boolean = false) = ChecklistHeader(
    action = action,
    transcribing = transcribing,
    onWalkThrough = {},
    onContinue = {},
    onDismiss = {},
)

@Preview(name = "Nothing recorded: walk through the sample", showBackground = true, widthDp = 360)
@Composable
private fun GettingStartedWalkThroughPreview() {
    ParleyTheme(preference = ThemePreference.LIGHT) {
        GettingStartedList(GettingStartedState(), previewHeader(ChecklistAction.WALK_THROUGH), Modifier.padding(16.dp))
    }
}

@Preview(name = "The transcribing beat", showBackground = true, widthDp = 360)
@Composable
private fun GettingStartedTranscribingPreview() {
    ParleyTheme(preference = ThemePreference.LIGHT) {
        GettingStartedList(
            GettingStartedState(),
            previewHeader(ChecklistAction.WALK_THROUGH, transcribing = true),
            Modifier.padding(16.dp),
        )
    }
}

@Preview(name = "Halfway: continue", showBackground = true, widthDp = 360)
@Composable
private fun GettingStartedContinuePreview() {
    ParleyTheme(preference = ThemePreference.LIGHT) {
        GettingStartedList(
            GettingStartedState(recorded = true, filed = true),
            previewHeader(ChecklistAction.CONTINUE_LAP),
            Modifier.padding(16.dp),
        )
    }
}
