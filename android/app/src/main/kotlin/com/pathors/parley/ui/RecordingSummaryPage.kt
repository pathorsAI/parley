package com.pathors.parley.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import com.pathors.parley.R
import com.pathors.parley.kit.BriefMarkup
import com.pathors.parley.ui.theme.ParleyTheme

/**
 * What the summary page does when somebody taps something on it — gathered so
 * the page takes one value instead of six.
 */
internal class SummaryActions(
    /**
     * Whether a tick on an action item is kept. True for the sample only, which
     * keeps its ticks on the phone; a cloud recording shows the ticks it has and
     * takes none, because the phone has no write path for them.
     */
    val canTickActionItems: Boolean,
    /** Whether there is a transcript to hand to an AI, for the empty state. */
    val canGenerate: Boolean,
    /** A moment on the recording, taken to the transcript. */
    val jump: (Long) -> Unit,
    val tickActionItem: (id: String, done: Boolean) -> Unit,
    /** The Share-to-AI hand-off: the analysis prompt plus the transcript. */
    val generate: () -> Unit,
)

/**
 * The recording screen's summary page: what the meeting came to, apart from
 * what was said in it. iOS `RecordingSummaryView`; see
 * `docs/design/ios-recording-page.md`.
 *
 * Top to bottom — brief, action items, highlights, speakers — which is the
 * order a person back from a meeting asks in: what happened, what do I have to
 * do, what should I look at again, who was there. Every timestamp on the page
 * is a way *into* the transcript rather than a label: it hands the moment to
 * [SummaryActions.jump], which switches pages, seeks, and lights the turn.
 *
 * The same page as the transcript: white, no cards, sections separated by
 * whitespace with a small sentence-case label over each. Blue appears only on
 * what can be tapped — the timestamps and the one button of the empty state.
 */
@Composable
internal fun RecordingSummaryPage(
    state: RecordingDetailViewModel.UiState,
    /** The people in the transcript, in order of first appearance, as the transcript labels them. */
    speakers: List<String>,
    listState: LazyListState,
    actions: SummaryActions,
    modifier: Modifier = Modifier,
) {
    LazyColumn(
        state = listState,
        modifier = modifier,
        contentPadding = PaddingValues(20.dp),
        verticalArrangement = Arrangement.spacedBy(32.dp),
    ) {
        if (state.hasAnalysis) {
            if (state.brief.isNotEmpty()) {
                item(key = "brief") { Brief(state.brief, actions.jump) }
            }
            if (state.actionItems.isNotEmpty()) {
                item(key = "actions") { ActionItems(state.actionItems, actions) }
            }
            if (state.findings.isNotEmpty()) {
                item(key = "highlights") { Highlights(state.findings, actions.jump) }
            }
        } else {
            item(key = "empty") { NoSummary(actions) }
        }
        if (speakers.isNotEmpty()) {
            item(key = "speakers") { SpeakerList(speakers) }
        }
    }
}

// ── brief ────────────────────────────────────────────────────────────────────

@Composable
private fun Brief(brief: String, onJump: (Long) -> Unit) {
    val paragraphs = remember(brief) { BriefMarkup.paragraphs(brief) }
    val link = MaterialTheme.colorScheme.primary
    val stampSize = MaterialTheme.typography.bodySmall.fontSize
    // The paragraphs are remembered against the brief, not the callback, so the
    // link reads whichever callback is current when it is tapped.
    val jump by rememberUpdatedState(onJump)
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        paragraphs.forEach { runs ->
            val text = remember(runs, link, stampSize) {
                briefParagraph(runs, link, stampSize) { jump(it) }
            }
            Text(
                text = text,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}

/**
 * One paragraph as one string, so it wraps as prose. Bold runs take the
 * semibold face; a timestamp is a link, in the tint because it can be tapped,
 * that hands its moment to [onJump].
 */
internal fun briefParagraph(
    runs: List<BriefMarkup.Run>,
    link: Color,
    stampSize: TextUnit,
    onJump: (Long) -> Unit,
): AnnotatedString = buildAnnotatedString {
    for (run in runs) {
        when (run) {
            is BriefMarkup.Run.Text ->
                if (run.bold) {
                    withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(run.text) }
                } else {
                    append(run.text)
                }

            is BriefMarkup.Run.Timestamp -> withLink(
                LinkAnnotation.Clickable(
                    tag = "moment:${run.ms}",
                    styles = TextLinkStyles(
                        style = SpanStyle(
                            color = link,
                            fontSize = stampSize,
                            fontFeatureSettings = TABULAR_FIGURES,
                        ),
                    ),
                    linkInteractionListener = { onJump(run.ms) },
                ),
            ) { append(run.label) }
        }
    }
}

// ── action items ─────────────────────────────────────────────────────────────

@Composable
private fun ActionItems(items: List<ActionItemRow>, actions: SummaryActions) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        SectionLabel(stringResource(R.string.detail_action_items))
        items.forEach { item ->
            Row(
                verticalAlignment = Alignment.Top,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                ActionCheck(item, actions)
                Text(
                    text = item.text,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (item.done) {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    } else {
                        MaterialTheme.colorScheme.onSurface
                    },
                    // Centres the first line on the 28dp check beside it.
                    modifier = Modifier
                        .weight(1f)
                        .padding(top = 3.dp),
                )
                item.atMs?.let { MomentLink(it, actions.jump, Modifier.padding(top = 3.dp)) }
            }
        }
    }
}

/**
 * The success green on a done item, as on the getting-started list: "this is
 * done" in the platform's words. A toggle only where the tick is kept.
 */
@Composable
private fun ActionCheck(item: ActionItemRow, actions: SummaryActions) {
    val done = stringResource(R.string.summary_done)
    val base = Modifier
        .size(CHECK_TARGET)
        .clip(CircleShape)
    val modifier = if (actions.canTickActionItems) {
        base
            .toggleable(
                value = item.done,
                role = Role.Checkbox,
                onValueChange = { actions.tickActionItem(item.id, it) },
            )
            .semantics { contentDescription = item.text }
    } else {
        base.clearAndSetSemantics { if (item.done) stateDescription = done }
    }
    Box(modifier, contentAlignment = Alignment.Center) {
        if (item.done) {
            Icon(
                imageVector = Icons.Filled.CheckCircle,
                contentDescription = null,
                tint = ParleyTheme.colors.success,
                modifier = Modifier.size(22.dp),
            )
        } else {
            Box(
                Modifier
                    .size(18.dp)
                    .border(1.5.dp, MaterialTheme.colorScheme.outline, CircleShape),
            )
        }
    }
}

// ── highlights ───────────────────────────────────────────────────────────────

/**
 * The analysis's findings, each with the moment it came from.
 *
 * A 2dp rule down the left edge in ink, and nothing else: no fill, no glyph,
 * no card. The rule says "this is a different kind of thing from the prose
 * above" without claiming more importance than what was said.
 */
@Composable
private fun Highlights(findings: List<FindingRow>, onJump: (Long) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        SectionLabel(stringResource(R.string.summary_highlights, findings.size))
        findings.forEach { finding ->
            Row(Modifier.height(IntrinsicSize.Min)) {
                Box(
                    Modifier
                        .width(2.dp)
                        .fillMaxHeight()
                        .background(MaterialTheme.colorScheme.onSurface),
                )
                Spacer(Modifier.width(12.dp))
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Row(verticalAlignment = Alignment.Top) {
                        Text(
                            text = finding.title,
                            style = MaterialTheme.typography.titleSmall,
                            color = MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.weight(1f),
                        )
                        Spacer(Modifier.width(8.dp))
                        MomentLink(finding.atMs, onJump)
                    }
                    if (finding.detail.isNotEmpty()) {
                        Text(
                            text = finding.detail,
                            style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.Normal),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}

// ── speakers ─────────────────────────────────────────────────────────────────

@Composable
private fun SpeakerList(speakers: List<String>) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionLabel(stringResource(R.string.summary_speakers))
        speakers.forEach { name ->
            Text(
                text = name,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}

// ── nothing to summarise ─────────────────────────────────────────────────────

/**
 * Never a blank page: a recording with no analysis says so, and offers the way
 * to get one — the same hand-off to the user's own AI the `⋯` menu makes, with
 * the prompt and the transcript.
 */
@Composable
private fun NoSummary(actions: SummaryActions) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            text = stringResource(R.string.summary_empty),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        TextButton(
            onClick = actions.generate,
            enabled = actions.canGenerate,
            contentPadding = PaddingValues(vertical = 8.dp),
        ) {
            Icon(Icons.Default.Share, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(6.dp))
            Text(
                text = stringResource(R.string.summary_generate),
                style = MaterialTheme.typography.titleSmall,
            )
        }
    }
}

// ── pieces ───────────────────────────────────────────────────────────────────

@Composable
private fun SectionLabel(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier
            .fillMaxWidth()
            .semantics { heading() },
    )
}

/**
 * A moment, as a way into the transcript: the clock and an arrow, in the tint
 * because it can be tapped.
 */
@Composable
private fun MomentLink(ms: Long, onJump: (Long) -> Unit, modifier: Modifier = Modifier) {
    val clock = formatClock(ms)
    val description = stringResource(R.string.summary_go_to, clock)
    Row(
        modifier = modifier
            .clip(MaterialTheme.shapes.small)
            .clickable { onJump(ms) }
            .semantics { contentDescription = description }
            .padding(horizontal = 4.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Text(
            text = clock,
            style = MaterialTheme.typography.labelSmall.copy(fontFeatureSettings = TABULAR_FIGURES),
            color = MaterialTheme.colorScheme.primary,
            // The row's description already says the clock, with what it does.
            modifier = Modifier.clearAndSetSemantics {},
        )
        Icon(
            imageVector = Icons.AutoMirrored.Filled.ArrowForward,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(11.dp),
        )
    }
}

private val CHECK_TARGET = 28.dp

/** Tabular figures, so a column of clocks lines its digits up. */
private const val TABULAR_FIGURES = "tnum"
