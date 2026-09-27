package com.pathors.parley.ui

import androidx.annotation.StringRes
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.CheckCircle
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
import androidx.compose.ui.unit.dp
import com.pathors.parley.R
import com.pathors.parley.kit.GettingStartedState
import com.pathors.parley.kit.GettingStartedStep
import com.pathors.parley.ui.theme.ParleyTheme

/**
 * The getting-started checklist: four plain rows that teach the product by doing
 * it — record, file, replay, hand off — each ticked only by the real event (see
 * `GettingStartedStore`), never by a tap on the row. iOS `GettingStartedList`.
 *
 * Rows, hairlines and text, no card: the list is part of the page, not a promo
 * sitting on it. The one colour is the success green on a done item's check and
 * the tint on what can be tapped.
 *
 * Rows 2–4 open the newest recording with the intent that finishes them (the
 * folder picker, the share sheet); with no recording yet they are just text,
 * because there is nothing for them to open.
 */
@Composable
fun GettingStartedList(
    state: GettingStartedState,
    actions: GettingStartedActions,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxWidth()) {
        Header(state, onDismiss = actions.onDismiss)
        GettingStartedStep.entries.forEach { step ->
            HorizontalDivider(thickness = 0.5.dp, color = MaterialTheme.colorScheme.outlineVariant)
            StepRow(step = step, done = state[step], actions = actions)
        }
    }
}

/**
 * What the list can do, gathered so the call site stays readable and the row
 * code reads one value instead of five parameters.
 */
data class GettingStartedActions(
    /** False in a build without the sample assets; the button is then absent rather than broken. */
    val canLoadSample: Boolean,
    /** Rows 2–4 open the newest recording; with none, they are just text. */
    val hasRecording: Boolean,
    val onLoadSample: () -> Unit,
    val onOpen: (GettingStartedStep) -> Unit,
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
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 4.dp),
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

@Composable
private fun StepRow(step: GettingStartedStep, done: Boolean, actions: GettingStartedActions) {
    val opensRecording = step != GettingStartedStep.RECORDED && !done && actions.hasRecording
    // The whole row is the target when it leads somewhere: the words are what
    // people reach for, not a chevron at the edge.
    val rowModifier = if (opensRecording) {
        Modifier.clickable { actions.onOpen(step) }
    } else {
        Modifier
    }
    Row(
        modifier = rowModifier
            .fillMaxWidth()
            .padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        StepText(step, done)
        when {
            opensRecording -> Icon(
                imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.outline,
            )

            step == GettingStartedStep.RECORDED && !done && actions.canLoadSample ->
                TextButton(onClick = actions.onLoadSample) {
                    Text(
                        text = stringResource(R.string.getting_started_load_sample),
                        fontWeight = FontWeight.SemiBold,
                    )
                }
        }
    }
}

/**
 * The mark and the words, one element to TalkBack with "Done" as its state; the
 * trailing button stays its own, so it can still be activated.
 */
@Composable
private fun RowScope.StepText(step: GettingStartedStep, done: Boolean) {
    val doneLabel = stringResource(R.string.getting_started_done)
    Row(
        modifier = Modifier
            .weight(1f)
            .semantics(mergeDescendants = true) { if (done) stateDescription = doneLabel },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        CheckMark(done)
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                text = stringResource(titleOf(step)),
                style = MaterialTheme.typography.bodyMedium,
                color = if (done) {
                    MaterialTheme.colorScheme.onSurfaceVariant
                } else {
                    MaterialTheme.colorScheme.onSurface
                },
            )
            detailOf(step)?.let { detail ->
                Text(
                    text = stringResource(detail),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
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

@StringRes
private fun detailOf(step: GettingStartedStep): Int? = when (step) {
    GettingStartedStep.RECORDED -> R.string.getting_started_recorded_detail
    GettingStartedStep.FILED -> R.string.getting_started_filed_detail
    GettingStartedStep.REPLAYED -> null
    GettingStartedStep.SHARED_TO_AI -> R.string.getting_started_shared_detail
}
