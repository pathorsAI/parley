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
import com.pathors.parley.kit.ArtifactDisplay
import com.pathors.parley.kit.BriefMarkup
import com.pathors.parley.kit.DeliveryStats
import com.pathors.parley.kit.StudyArtifact
import com.pathors.parley.kit.TranscriptSegment
import com.pathors.parley.study.RecordingStudy
import com.pathors.parley.ui.theme.ParleyTheme

/**
 * What the report page does when somebody taps something on it — gathered so
 * the page takes one value instead of a dozen.
 */
internal class ReportActions(
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
    /** A moment on the recording, played without leaving the report (the timeline's dots). */
    val seek: (Long) -> Unit,
    val tickActionItem: (id: String, done: Boolean) -> Unit,
    /** The Share-to-AI hand-off: the analysis prompt plus the transcript. */
    val generate: () -> Unit,
    val regenerate: (StudyArtifact) -> Unit,
    val regenerateAll: () -> Unit,
    /** Open the analysis menu on arrival (the screenshot route for it). */
    val openStudyMenu: Boolean = false,
)

/**
 * The recording screen's report page (報告): what the meeting came to, apart
 * from what was said in it — the desktop's report tab, in its order: the
 * generation chip, then the brief (重點), the action items (後續行動), the
 * timeline analysis (時間軸分析), the delivery scorecard (評分), and who was
 * there. Every timestamp on the page is a way *into* the transcript rather
 * than a label: it hands the moment to [ReportActions.jump], which switches
 * pages, seeks, and lights the turn.
 *
 * [study] is the study pipeline for this recording (`study/StudyPass`), or
 * null where the phone does not run it (the sample, an organization's
 * recording). With it, every section the pipeline owes says where it is —
 * queued behind its upstream stage, generating, failed — in the desktop's
 * words; without it, the page shows whatever analysis the recording carries.
 * Only when there is no analysis and no way to make one does the page fall
 * back to the Share-to-AI hand-off.
 */
@Composable
internal fun RecordingReportPage(
    state: RecordingDetailViewModel.UiState,
    study: RecordingStudy?,
    /** The people in the transcript, in order of first appearance, as the transcript labels them. */
    speakers: List<String>,
    /** The transcript, for the scorecard's on-device numbers. */
    segments: List<TranscriptSegment>,
    listState: LazyListState,
    actions: ReportActions,
    modifier: Modifier = Modifier,
) {
    val sections = remember(state, study) { ReportLayout.of(state, study) }
    val stats = remember(segments) {
        DeliveryLocalStats(
            talkShare = DeliveryStats.talkTimeRatio(segments),
            fillerSounds = DeliveryStats.fillerSounds(segments),
        )
    }
    LazyColumn(
        state = listState,
        modifier = modifier,
        contentPadding = PaddingValues(20.dp),
        verticalArrangement = Arrangement.spacedBy(32.dp),
    ) {
        if (study != null) {
            item(key = "chip") {
                StudyChip(
                    study = study,
                    onRegenerate = actions.regenerate,
                    onRegenerateAll = actions.regenerateAll,
                    openInitially = actions.openStudyMenu,
                )
            }
        }
        sections.brief?.let { display ->
            item(key = "brief") { BriefSection(state.brief, display, study, actions.jump) }
        }
        sections.actions?.let { display ->
            item(key = "actions") { ActionItemsSection(state.actionItems, display, study, actions) }
        }
        sections.timeline?.let { display ->
            item(key = "timeline") {
                TimelineSection(state.findings, display, study, state.meta?.durationMs?.toLong() ?: 0L, actions)
            }
        }
        sections.delivery?.let { display ->
            item(key = "delivery") {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    SectionLabel(stringResource(R.string.report_delivery))
                    DeliveryScorecard(state.delivery, display, state.meta?.speechRateHz, stats)
                }
            }
        }
        if (sections.empty) {
            item(key = "empty") { NoSummary(actions, offerHandoff = study == null || !study.canSpend) }
        }
        if (speakers.isNotEmpty()) {
            item(key = "speakers") { SpeakerList(speakers) }
        }
    }
}

/**
 * Which sections the report shows, and what each says about its artifact —
 * null for a section that is not drawn. Pure, so the rules are testable:
 *
 * - a section with content is drawn;
 * - with the pipeline running here, a section whose artifact is queued,
 *   generating or failed is drawn too (with that status), and a finished
 *   empty one says so; an untouched one (auto-analysis off) is not;
 * - nothing drawn at all is the empty state.
 */
internal data class ReportLayout(
    val brief: ArtifactDisplay?,
    val actions: ArtifactDisplay?,
    val timeline: ArtifactDisplay?,
    val delivery: ArtifactDisplay?,
) {
    val empty: Boolean get() = brief == null && actions == null && timeline == null && delivery == null

    companion object {
        fun of(state: RecordingDetailViewModel.UiState, study: RecordingStudy?): ReportLayout {
            fun section(artifact: StudyArtifact, hasContent: Boolean): ArtifactDisplay? {
                if (study == null) return if (hasContent) ArtifactDisplay.DONE else null
                val display = study.display(artifact)
                return when {
                    display != ArtifactDisplay.IDLE -> display
                    hasContent -> ArtifactDisplay.DONE
                    else -> null
                }
            }
            return ReportLayout(
                brief = section(StudyArtifact.BRIEF, state.brief.isNotEmpty()),
                actions = section(StudyArtifact.ACTIONS, state.actionItems.isNotEmpty()),
                timeline = section(StudyArtifact.FINDINGS, state.findings.isNotEmpty()),
                delivery = section(StudyArtifact.DELIVERY, state.delivery != null),
            )
        }
    }
}

/** Waiting, generating or failed: the line in place of the artifact. Null when the content shows. */
@Composable
private fun pendingLine(
    display: ArtifactDisplay,
    queued: Int,
    running: Int,
    error: String,
): String? = when (display) {
    ArtifactDisplay.QUEUED -> stringResource(queued)
    ArtifactDisplay.RUNNING -> stringResource(running)
    ArtifactDisplay.ERROR -> error
    else -> null
}

// ── brief ────────────────────────────────────────────────────────────────────

@Composable
private fun BriefSection(brief: String, display: ArtifactDisplay, study: RecordingStudy?, onJump: (Long) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        SectionLabel(stringResource(R.string.report_brief))
        val pending = pendingLine(
            display,
            queued = R.string.report_brief_queued,
            running = R.string.report_brief_generating,
            error = stringResource(R.string.report_brief_error),
        )
        when {
            pending != null -> SectionStatus(pending, display)
            brief.isNotEmpty() -> Brief(brief, onJump)
        }
        // A failed regeneration over a brief that is still there keeps showing it.
        if (display == ArtifactDisplay.ERROR && brief.isNotEmpty() && study != null) Brief(brief, onJump)
    }
}

@Composable
private fun Brief(brief: String, onJump: (Long) -> Unit) {
    val paragraphs = remember(brief) { BriefMarkup.paragraphs(brief) }
    val link = MaterialTheme.colorScheme.primary
    val stampSize = MaterialTheme.typography.bodySmall.fontSize
    // The paragraphs are remembered against the brief, not the callback, so the
    // link reads whichever callback is current when it is tapped.
    val latestJump = rememberUpdatedState(onJump)
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        paragraphs.forEach { runs ->
            val text = remember(runs, link, stampSize) {
                briefParagraph(runs, link, stampSize) { ms -> latestJump.value(ms) }
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
private fun ActionItemsSection(
    items: List<ActionItemRow>,
    display: ArtifactDisplay,
    study: RecordingStudy?,
    actions: ReportActions,
) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        SectionLabel(stringResource(R.string.detail_action_items))
        val pending = pendingLine(
            display,
            queued = R.string.report_actions_queued,
            running = R.string.report_actions_generating,
            error = stringResource(
                R.string.report_actions_error,
                stringResource(failureText(study?.failures?.get(StudyArtifact.ACTIONS))),
            ),
        )
        when {
            pending != null -> SectionStatus(pending, display)
            items.isEmpty() -> EmptyLine(stringResource(R.string.report_actions_empty))
            else -> items.forEach { item ->
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
}

/**
 * The success green on a done item, as on the getting-started list: "this is
 * done" in the platform's words. A toggle only where the tick is kept.
 */
@Composable
private fun ActionCheck(item: ActionItemRow, actions: ReportActions) {
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

// ── the timeline ─────────────────────────────────────────────────────────────

/**
 * 時間軸分析 — the findings, as the desktop's replay timeline puts them: a
 * strip across the recording with a dot per finding (a tap plays it), then the
 * list in time order. Each moment is a way into the transcript.
 */
@Composable
private fun TimelineSection(
    findings: List<FindingRow>,
    display: ArtifactDisplay,
    study: RecordingStudy?,
    durationMs: Long,
    actions: ReportActions,
) {
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) { SectionLabel(stringResource(R.string.report_timeline)) }
            if (findings.isNotEmpty() && display == ArtifactDisplay.DONE) {
                Text(
                    stringResource(R.string.report_timeline_count, findings.size),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        val pending = pendingLine(
            display,
            queued = R.string.report_timeline_queued,
            running = R.string.report_timeline_analyzing,
            error = stringResource(
                R.string.report_timeline_error,
                stringResource(failureText(study?.failures?.get(StudyArtifact.FINDINGS))),
            ),
        )
        when {
            pending != null -> SectionStatus(pending, display)
            findings.isEmpty() -> EmptyLine(stringResource(R.string.report_timeline_empty))
            else -> {
                TimelineStrip(findings, durationMs, actions.seek)
                findings.forEach { finding ->
                    FindingEntry(finding) { MomentLink(finding.atMs, actions.jump) }
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
 * Never a blank page: a recording with no analysis says so, and — where the
 * phone cannot make one (the sample, an organization's recording, signed out)
 * — offers the way to get one: the same hand-off to the user's own AI the `⋯`
 * menu makes, with the prompt and the transcript.
 */
@Composable
private fun NoSummary(actions: ReportActions, offerHandoff: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            text = stringResource(R.string.summary_empty),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        // Where the phone can analyse the recording itself, the chip above is
        // the way; the hand-off to the user's own AI is for where it cannot.
        if (offerHandoff) TextButton(
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
private fun EmptyLine(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

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
