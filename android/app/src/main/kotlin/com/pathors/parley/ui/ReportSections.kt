package com.pathors.parley.ui

import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.pathors.parley.R
import com.pathors.parley.kit.ArtifactDisplay
import com.pathors.parley.kit.DeliveryAssessment
import com.pathors.parley.kit.DeliveryStats
import com.pathors.parley.kit.StudyArtifact
import com.pathors.parley.study.RecordingStudy
import com.pathors.parley.study.StudyFailure
import com.pathors.parley.ui.theme.ParleyTheme

// ── the generation chip ──────────────────────────────────────────────────────

/**
 * The analysis surface for the recording — the desktop's
 * `StudyGenerationChip`: a chip that always says where the pipeline is
 * ("Analyzing 2/4", "Analysis ready", "1 failed", "Not analyzed"), opening a
 * menu that lists the four artifacts with their status and a regenerate each,
 * and "Regenerate all" behind a confirmation (it overwrites every output and
 * spends a fresh pass).
 *
 * Regenerating is locked while anything runs (one pass at a time, as on the
 * desktop) and when the hosted model cannot be asked.
 */
@Composable
internal fun StudyChip(
    study: RecordingStudy,
    onRegenerate: (StudyArtifact) -> Unit,
    onRegenerateAll: () -> Unit,
    /** Open the menu on arrival — the screenshot route for the menu. */
    openInitially: Boolean = false,
) {
    var expanded by rememberSaveable { mutableStateOf(openInitially) }
    var confirming by rememberSaveable { mutableStateOf(false) }
    val progress = study.progress
    val locked = !study.canSpend || !study.hasTranscript || study.anyRunning

    val (container, content) = when {
        progress.active -> MaterialTheme.colorScheme.primary.copy(alpha = 0.1f) to MaterialTheme.colorScheme.primary
        progress.errors > 0 -> MaterialTheme.colorScheme.error.copy(alpha = 0.1f) to MaterialTheme.colorScheme.error
        else -> MaterialTheme.colorScheme.surfaceVariant to MaterialTheme.colorScheme.onSurfaceVariant
    }
    val label = when {
        progress.active -> stringResource(R.string.study_chip_running, progress.done, progress.total)
        progress.errors > 0 -> stringResource(R.string.study_chip_failed, progress.errors)
        progress.done == progress.total -> stringResource(R.string.study_chip_done)
        else -> stringResource(R.string.study_chip_idle)
    }

    Box {
        Row(
            modifier = Modifier
                .clip(CircleShape)
                .background(container)
                .clickable(role = Role.Button) { expanded = true }
                .padding(start = 12.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            when {
                progress.active -> CircularProgressIndicator(
                    modifier = Modifier.size(12.dp),
                    strokeWidth = 1.5.dp,
                    color = content,
                )
                progress.errors > 0 -> Icon(Icons.Default.Warning, null, tint = content, modifier = Modifier.size(14.dp))
                progress.done == progress.total -> Icon(Icons.Default.Check, null, tint = content, modifier = Modifier.size(14.dp))
            }
            Text(label, style = MaterialTheme.typography.labelMedium, color = content)
            Icon(Icons.Default.ArrowDropDown, null, tint = content, modifier = Modifier.size(18.dp))
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            Text(
                text = stringResource(R.string.study_panel_title),
                style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
            HorizontalDivider(thickness = 0.5.dp)
            StudyArtifact.entries.forEach { artifact ->
                ArtifactRow(
                    label = stringResource(artifactLabel(artifact)),
                    display = progress.displays.getValue(artifact),
                    enabled = !locked,
                    onRegenerate = {
                        expanded = false
                        onRegenerate(artifact)
                    },
                )
            }
            HorizontalDivider(thickness = 0.5.dp)
            TextButton(
                onClick = {
                    expanded = false
                    confirming = true
                },
                enabled = !locked,
                modifier = Modifier.padding(horizontal = 8.dp),
            ) {
                Icon(Icons.Default.Refresh, null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text(stringResource(R.string.study_regenerate_all))
            }
        }
    }

    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text(stringResource(R.string.study_regenerate_all)) },
            text = { Text(stringResource(R.string.study_regenerate_all_hint)) },
            confirmButton = {
                TextButton(onClick = {
                    confirming = false
                    onRegenerateAll()
                }) { Text(stringResource(R.string.study_regenerate_all_confirm)) }
            },
            dismissButton = {
                TextButton(onClick = { confirming = false }) { Text(stringResource(R.string.study_cancel)) }
            },
        )
    }
}

@Composable
private fun ArtifactRow(label: String, display: ArtifactDisplay, enabled: Boolean, onRegenerate: () -> Unit) {
    val (statusText, color) = statusOf(display)
    val regenerate = stringResource(R.string.study_regenerate)
    Row(
        modifier = Modifier
            .width(300.dp)
            .padding(start = 16.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        if (display == ArtifactDisplay.RUNNING) {
            CircularProgressIndicator(modifier = Modifier.size(10.dp), strokeWidth = 1.5.dp, color = color)
            Spacer(Modifier.width(4.dp))
        }
        Text(statusText, style = MaterialTheme.typography.labelMedium, color = color)
        IconButton(
            onClick = onRegenerate,
            enabled = enabled,
            modifier = Modifier.semantics { contentDescription = "$regenerate $label" },
        ) {
            Icon(Icons.Default.Refresh, null, modifier = Modifier.size(18.dp))
        }
    }
}

@Composable
private fun statusOf(display: ArtifactDisplay): Pair<String, Color> = when (display) {
    ArtifactDisplay.QUEUED -> stringResource(R.string.study_status_queued) to ParleyTheme.colors.warning
    ArtifactDisplay.RUNNING -> stringResource(R.string.study_status_running) to MaterialTheme.colorScheme.primary
    ArtifactDisplay.DONE -> stringResource(R.string.study_status_done) to MaterialTheme.colorScheme.onSurfaceVariant
    ArtifactDisplay.ERROR -> stringResource(R.string.study_status_error) to MaterialTheme.colorScheme.error
    ArtifactDisplay.IDLE -> stringResource(R.string.study_status_idle) to MaterialTheme.colorScheme.onSurfaceVariant
}

@StringRes
internal fun artifactLabel(artifact: StudyArtifact): Int = when (artifact) {
    StudyArtifact.FINDINGS -> R.string.report_timeline
    StudyArtifact.ACTIONS -> R.string.detail_action_items
    StudyArtifact.BRIEF -> R.string.report_brief
    StudyArtifact.DELIVERY -> R.string.report_delivery
}

@StringRes
internal fun failureText(failure: StudyFailure?): Int = when (failure) {
    StudyFailure.TIMEOUT -> R.string.study_failure_timeout
    StudyFailure.NETWORK -> R.string.study_failure_network
    StudyFailure.QUOTA -> R.string.study_failure_quota
    StudyFailure.SIGNED_OUT -> R.string.study_failure_signed_out
    StudyFailure.UNREADABLE -> R.string.study_failure_unreadable
    StudyFailure.SERVER, null -> R.string.study_failure_server
}

// ── a section's waiting line ─────────────────────────────────────────────────

/**
 * What a section says while its artifact is not there yet: queued (the
 * desktop's "Queued — starts after …", in the amber of a promise), generating
 * (a spinner), or failed (in red, with why).
 */
@Composable
internal fun SectionStatus(text: String, display: ArtifactDisplay) {
    val color = when (display) {
        ArtifactDisplay.QUEUED -> ParleyTheme.colors.warning
        ArtifactDisplay.ERROR -> MaterialTheme.colorScheme.error
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (display == ArtifactDisplay.RUNNING) {
            CircularProgressIndicator(modifier = Modifier.size(12.dp), strokeWidth = 1.5.dp)
        }
        Text(text, style = MaterialTheme.typography.bodySmall, color = color)
    }
}

// ── the timeline ─────────────────────────────────────────────────────────────

/** A finding's colour: green once handled, else by severity. */
@Composable
internal fun findingColor(finding: FindingRow): Color = when {
    finding.resolved -> ParleyTheme.colors.success
    finding.severity == "critical" -> ParleyTheme.colors.recording
    finding.severity == "warn" -> ParleyTheme.colors.warning
    else -> MaterialTheme.colorScheme.primary
}

/**
 * The findings across the length of the recording — the desktop's replay
 * timeline, flattened to one strip: a dot per finding in its severity's
 * colour, at its moment. A tap on a dot sends the player there without
 * leaving the report.
 */
@Composable
internal fun TimelineStrip(findings: List<FindingRow>, durationMs: Long, onSeek: (Long) -> Unit) {
    val span = maxOf(durationMs, (findings.maxOfOrNull { it.atMs } ?: 0L) + 1_000L, 1L)
    val track = MaterialTheme.colorScheme.outlineVariant
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        BoxWithConstraints(
            Modifier
                .fillMaxWidth()
                .height(DOT_TARGET),
        ) {
            val width = maxWidth - DOT_TARGET
            Box(
                Modifier
                    .align(Alignment.CenterStart)
                    .padding(horizontal = DOT_TARGET / 2)
                    .fillMaxWidth()
                    .height(2.dp)
                    .clip(RoundedCornerShape(1.dp))
                    .background(track),
            )
            findings.forEach { finding ->
                val fraction = (finding.atMs.toFloat() / span).coerceIn(0f, 1f)
                val description = stringResource(R.string.report_finding_at, formatClock(finding.atMs), finding.title)
                Box(
                    modifier = Modifier
                        .offset(x = width * fraction)
                        .size(DOT_TARGET)
                        .clip(CircleShape)
                        .clickable { onSeek(finding.atMs) }
                        .semantics { contentDescription = description },
                    contentAlignment = Alignment.Center,
                ) {
                    Box(
                        Modifier
                            .size(10.dp)
                            .clip(CircleShape)
                            .background(findingColor(finding))
                            .border(1.dp, MaterialTheme.colorScheme.surface, CircleShape),
                    )
                }
            }
        }
        Row(Modifier.fillMaxWidth()) {
            Text(
                "0:00",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.outline,
                modifier = Modifier.weight(1f),
            )
            Text(formatClock(span), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
        }
    }
}

/**
 * One finding in the list under the strip: severity dot and title, the
 * moment (a way into the transcript), the detail, and what the lens adds —
 * whose move it was, which bucket it is in, and how ME handled it.
 */
@Composable
internal fun FindingEntry(finding: FindingRow, moment: @Composable () -> Unit) {
    Row(verticalAlignment = Alignment.Top) {
        Box(
            Modifier
                .padding(top = 6.dp)
                .size(8.dp)
                .clip(CircleShape)
                .background(findingColor(finding)),
        )
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.Top) {
                Text(
                    finding.title,
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(8.dp))
                moment()
            }
            if (finding.detail.isNotEmpty()) {
                Text(
                    finding.detail,
                    style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.Normal),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            FindingTags(finding)
            if (finding.resolved && !finding.resolution.isNullOrEmpty()) {
                Text(
                    stringResource(R.string.report_resolved_how, finding.resolution),
                    style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.Normal),
                    color = ParleyTheme.colors.success,
                )
            }
        }
    }
}

@Composable
private fun FindingTags(finding: FindingRow) {
    val tags = buildList {
        severityLabel(finding.severity)?.let { add(stringResource(it) to findingColor(finding.copy(resolved = false))) }
        when (finding.side) {
            "them" -> add(stringResource(R.string.report_side_them) to MaterialTheme.colorScheme.onSurfaceVariant)
            "me" -> add(stringResource(R.string.report_side_me) to MaterialTheme.colorScheme.onSurfaceVariant)
        }
        when (finding.category) {
            "decision" -> add(stringResource(R.string.report_category_decision) to MaterialTheme.colorScheme.onSurfaceVariant)
            "open" -> add(stringResource(R.string.report_category_open) to MaterialTheme.colorScheme.onSurfaceVariant)
            "fact" -> add(stringResource(R.string.report_category_fact) to MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (finding.resolved) add(stringResource(R.string.report_resolved) to ParleyTheme.colors.success)
    }
    if (tags.isEmpty()) return
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        tags.forEach { (text, color) ->
            Text(
                text,
                style = MaterialTheme.typography.labelSmall,
                color = color,
                modifier = Modifier
                    .border(0.5.dp, color.copy(alpha = 0.5f), RoundedCornerShape(4.dp))
                    .padding(horizontal = 6.dp, vertical = 1.dp),
            )
        }
    }
}

@StringRes
private fun severityLabel(severity: String?): Int? = when (severity) {
    "critical" -> R.string.report_severity_critical
    "warn" -> R.string.report_severity_warn
    "info" -> R.string.report_severity_info
    else -> null
}

// ── the delivery scorecard ───────────────────────────────────────────────────

/**
 * 評分 — the desktop's `DeliveryScorecard`: stat tiles computed on the device
 * (pace, talk share, filler sounds) and the model's read (tone, crutch
 * words, a one-line summary).
 *
 * On a phone recording most measured tiles have nothing to measure: the
 * speaking rate is the desktop's acoustic measurement (`speechRateHz`), so
 * pace reads "—" with the model's coarse label under it; talk share needs a
 * desktop's me/them split, so it is absent; filler sounds count the user's
 * own (`me`) lines, so a diarized `mix` recording counts zero. All exactly as
 * the desktop shows the same recording.
 */
@Composable
internal fun DeliveryScorecard(
    assessment: DeliveryAssessment?,
    display: ArtifactDisplay,
    speechRateHz: Double?,
    stats: DeliveryLocalStats,
) {
    val pending = assessment == null && (display == ArtifactDisplay.QUEUED || display == ArtifactDisplay.RUNNING)
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        // Two to a row, in the desktop's order: pace, talk share (only with a
        // me/them split), filler sounds, tone.
        val band = speechRateHz?.let(::paceBand)
        val tiles = buildList<Tile> {
            add(
                Tile(
                    label = stringResource(R.string.delivery_pace),
                    value = speechRateHz?.let { DeliveryStats.syllablesPerMin(it).toString() } ?: "—",
                    sub = when {
                        band != null ->
                            stringResource(R.string.delivery_unit_syllables_per_min) + " · " + stringResource(band.first)
                        else -> assessment?.pace?.let(::paceLabel)?.let { stringResource(it) }
                    },
                    watch = band?.second == true,
                ),
            )
            stats.talkShare?.let { share ->
                val (key, watch) = talkBand(share)
                add(Tile(stringResource(R.string.delivery_talk_share), "${Math.round(share * PERCENT)}%", stringResource(key), watch))
            }
            add(
                Tile(
                    label = stringResource(R.string.delivery_filler_sounds),
                    value = stats.fillerSounds.toString(),
                    sub = stringResource(R.string.delivery_unit_times),
                    watch = stats.fillerSounds >= FILLER_WATCH,
                ),
            )
            add(
                Tile(
                    label = stringResource(R.string.delivery_tone),
                    value = when {
                        assessment != null -> toneLabel(assessment.tone)?.let { stringResource(it) } ?: assessment.tone
                        pending -> "…"
                        else -> "—"
                    },
                    sub = assessment?.toneEvidence?.takeIf { it.isNotEmpty() }?.let { "“$it”" },
                    watch = assessment?.toneNeedsWatch == true,
                ),
            )
        }
        tiles.chunked(2).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { StatTile(it.label, it.value, it.sub, it.watch, Modifier.weight(1f)) }
                if (row.size == 1) Spacer(Modifier.weight(1f))
            }
        }
        AiRead(assessment, display)
    }
}

private data class Tile(val label: String, val value: String, val sub: String?, val watch: Boolean)

/** What the scorecard derives from the transcript alone. */
internal data class DeliveryLocalStats(val talkShare: Double?, val fillerSounds: Int)

@Composable
private fun AiRead(assessment: DeliveryAssessment?, display: ArtifactDisplay) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .border(0.5.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(10.dp))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            stringResource(R.string.delivery_ai_read),
            style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
        )
        when {
            display == ArtifactDisplay.RUNNING && assessment == null ->
                SectionStatus(stringResource(R.string.delivery_analyzing), display)
            display == ArtifactDisplay.QUEUED && assessment == null ->
                SectionStatus(stringResource(R.string.delivery_queued), display)
            assessment != null -> AssessmentLines(assessment)
            display == ArtifactDisplay.ERROR -> SectionStatus(stringResource(R.string.delivery_error), display)
            else -> Text(
                stringResource(R.string.delivery_none),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun AssessmentLines(assessment: DeliveryAssessment) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    LabelValue(
        stringResource(R.string.delivery_tone),
        toneLabel(assessment.tone)?.let { stringResource(it) } ?: assessment.tone,
        if (assessment.toneNeedsWatch) ParleyTheme.colors.warning else MaterialTheme.colorScheme.onSurface,
    )
    if (assessment.toneEvidence.isNotEmpty()) {
        Text(
            "“${assessment.toneEvidence}”",
            style = MaterialTheme.typography.labelSmall.copy(fontStyle = FontStyle.Italic),
            color = muted,
        )
    }
    Text(stringResource(R.string.delivery_tone_advisory), style = MaterialTheme.typography.labelSmall, color = muted)
    val frequent = assessment.fillers.level == "frequent"
    val fillers = stringResource(if (frequent) R.string.delivery_filler_frequent else R.string.delivery_filler_ok) +
        if (frequent && assessment.fillers.examples.isNotEmpty()) {
            " (" + assessment.fillers.examples.take(3).joinToString("、") + ")"
        } else {
            ""
        }
    LabelValue(stringResource(R.string.delivery_fillers), fillers, if (frequent) ParleyTheme.colors.warning else muted)
    if (assessment.summary.isNotEmpty()) {
        Text(assessment.summary, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurface)
    }
}

@Composable
private fun LabelValue(label: String, value: String, valueColor: Color) {
    Row(Modifier.fillMaxWidth()) {
        Text(
            label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(1f),
        )
        Text(value, style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.Medium), color = valueColor)
    }
}

@Composable
private fun StatTile(label: String, value: String, sub: String?, watch: Boolean, modifier: Modifier = Modifier) {
    val accent = if (watch) ParleyTheme.colors.warning else MaterialTheme.colorScheme.onSurface
    Column(
        modifier = modifier
            .border(0.5.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(10.dp))
            .padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
        )
        Text(
            value,
            style = MaterialTheme.typography.titleMedium.copy(fontFeatureSettings = "tnum"),
            color = accent,
            maxLines = 1,
        )
        Text(
            sub.orEmpty(),
            style = MaterialTheme.typography.labelSmall,
            color = if (watch) accent else MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
        )
    }
}

/** The desktop's `paceBand`: over 4 syllables/s is fast, under 2 slow. */
private fun paceBand(hz: Double): Pair<Int, Boolean> = when {
    hz > FAST_HZ -> R.string.delivery_pace_fast to true
    hz >= SLOW_HZ -> R.string.delivery_pace_comfortable to false
    else -> R.string.delivery_pace_slow to false
}

/** The desktop's `talkBand`: 65% or more of the talking is steamrolling, 35% or less quiet. */
private fun talkBand(me: Double): Pair<Int, Boolean> = when {
    me >= TALK_HIGH -> R.string.delivery_talk_high to true
    me <= TALK_LOW -> R.string.delivery_talk_low to false
    else -> R.string.delivery_talk_balanced to false
}

@StringRes
private fun paceLabel(pace: String): Int? = when (pace) {
    "slow" -> R.string.delivery_pace_slow
    "comfortable" -> R.string.delivery_pace_comfortable
    "fast" -> R.string.delivery_pace_fast
    else -> null
}

@StringRes
private fun toneLabel(tone: String): Int? = when (tone) {
    "neutral" -> R.string.delivery_tone_neutral
    "warm" -> R.string.delivery_tone_warm
    "firm" -> R.string.delivery_tone_firm
    "sharp" -> R.string.delivery_tone_sharp
    "aggressive" -> R.string.delivery_tone_aggressive
    "rude" -> R.string.delivery_tone_rude
    else -> null
}

private val DOT_TARGET = 24.dp
private const val FAST_HZ = 4.0
private const val SLOW_HZ = 2.0
private const val TALK_HIGH = 0.65
private const val TALK_LOW = 0.35
private const val FILLER_WATCH = 10
private const val PERCENT = 100
