package com.pathors.parley.ui

import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.indication
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.pathors.parley.R
import com.pathors.parley.kit.CloudMeetingDraft
import com.pathors.parley.kit.MeetingDraftSchedule
import com.pathors.parley.meeting.AgendaItem
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.delay

// Meeting drafts on the Library overview, read-only (#774) — the Android half
// of iOS `MeetingDraftViews.swift` (#772): the desktop's 即將開始的會議 and
// 會議草稿 (`src/components/home/UpcomingMeetings.tsx`, `DraftRow.tsx`), the
// full list 查看全部 opens, and a page that shows one draft. Drafts are made
// and edited on the desktop (or by an AI over the cloud MCP); the phone shows
// them, and starts a meeting from one (開始, as the desktop's row) — never
// create, edit or delete. Starting hides the draft on this phone rather than
// deleting it (`library/StartedDrafts.kt`). `HomeScreen` places the sections
// and owns the pages; everything here only draws and reports taps.

/** How often the draft sections re-read the clock — the desktop's `useNow`. */
private const val DRAFT_CLOCK_MS = 30_000L

/**
 * The time now, re-read every 30 s while on screen, so a meeting moves up into
 * 即將開始的會議 and its "in 25 min" counts down while the page is open.
 */
@Composable
internal fun rememberDraftClock(): Long {
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(DRAFT_CLOCK_MS)
            now = System.currentTimeMillis()
        }
    }
    return now
}

// ── Sections ─────────────────────────────────────────────────────────────────

/**
 * A draft section's heading — [OverviewHeading]'s look, with the desktop's
 * count right beside the title rather than across the row, and [trailing] at
 * the far end (最近錄音's 查看全部 →).
 */
@Composable
private fun DraftSectionHeading(title: String, count: Int, trailing: @Composable () -> Unit = {}) {
    val color = MaterialTheme.colorScheme.onSurfaceVariant
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 32.dp),
    ) {
        Text(
            text = title,
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.SemiBold,
            color = color,
            modifier = Modifier.semantics { heading() },
        )
        Spacer(Modifier.width(6.dp))
        Text(
            text = count.toString(),
            style = MaterialTheme.typography.labelSmall.copy(fontFeatureSettings = "tnum"),
            color = color,
            modifier = Modifier.clearAndSetSemantics {},
        )
        Spacer(Modifier.weight(1f))
        trailing()
    }
}

/**
 * One of the overview's draft sections — 即將開始的會議 (all of them) or 會議草稿
 * (at most [limit], then 查看全部 when there are more). The caller leaves a
 * section out when [drafts] is empty rather than drawing it empty: two empty
 * boxes around the folders would push the library down for nothing.
 */
@Composable
internal fun DraftSection(
    title: String,
    drafts: List<CloudMeetingDraft>,
    now: Long,
    folderName: (String?) -> String?,
    onOpen: (String) -> Unit,
    // 開始 on the rows only for 即將開始的會議; null = none (a later draft is
    // started from its page).
    onStart: ((CloudMeetingDraft) -> Unit)?,
    modifier: Modifier = Modifier,
    limit: Int? = null,
    onSeeAll: (() -> Unit)? = null,
) {
    val shown = if (limit != null) drafts.take(limit) else drafts
    Column(modifier.fillMaxWidth()) {
        DraftSectionHeading(title = title, count = drafts.size) {
            if (limit != null && drafts.size > limit && onSeeAll != null) {
                OverviewLink(stringResource(R.string.library_overview_see_all), leading = false, onClick = onSeeAll)
            }
        }
        shown.forEachIndexed { index, draft ->
            if (index > 0) {
                HorizontalDivider(thickness = 0.5.dp, color = MaterialTheme.colorScheme.outlineVariant)
            }
            DraftRow(
                draft = draft,
                now = now,
                folder = folderName(draft.meetingFolderId),
                onClick = { onOpen(draft.id) },
                onStart = onStart?.let { start -> { start(draft) } },
            )
        }
    }
}

/**
 * 會議草稿's 查看全部: every draft that is not starting soon, soonest first —
 * the page's title says what they are, so no section heading over them.
 */
@Composable
internal fun MeetingDraftsList(
    drafts: List<CloudMeetingDraft>,
    folderName: (String?) -> String?,
    onOpen: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val now = rememberDraftClock()
    val later = remember(drafts, now) { MeetingDraftSchedule.split(drafts, now).later }
    LazyColumn(
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 32.dp),
    ) {
        itemsIndexed(later, key = { _, draft -> "draft-" + draft.id }) { index, draft ->
            Column {
                if (index > 0) {
                    HorizontalDivider(thickness = 0.5.dp, color = MaterialTheme.colorScheme.outlineVariant)
                }
                DraftRow(
                    draft = draft,
                    now = now,
                    folder = folderName(draft.meetingFolderId),
                    onClick = { onOpen(draft.id) },
                    onStart = null,
                )
            }
        }
    }
}

// ── Row ──────────────────────────────────────────────────────────────────────

/** A draft's title, or the desktop's 未命名的會議 when it has none. */
@Composable
private fun draftTitle(draft: CloudMeetingDraft): String =
    draft.title.takeIf { it.isNotBlank() } ?: stringResource(R.string.draft_untitled)

/**
 * The desktop's `DraftRow`, phone-sized — iOS `DraftRow`: the lead column
 * (16:00 today, 10/31 another day, 未定 without a time), the title, and under
 * it how soon and which folder — and, on 即將開始的會議 only, the desktop's 開始
 * at the trailing edge ([DraftStartButton]), beside the part that opens the draft rather than
 * inside it, so a press on 開始 never also opens the page.
 */
@Composable
private fun DraftRow(
    draft: CloudMeetingDraft,
    now: Long,
    folder: String?,
    onClick: () -> Unit,
    onStart: (() -> Unit)?,
) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        DraftRowText(draft = draft, now = now, folder = folder, onClick = onClick, modifier = Modifier.weight(1f))
        if (onStart != null) {
            Spacer(Modifier.width(8.dp))
            DraftStartButton(onClick = onStart)
        }
    }
}

/** The row's when, what and where — the part that opens the draft's page. */
@Composable
private fun DraftRowText(
    draft: CloudMeetingDraft,
    now: Long,
    folder: String?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val soon = draftSoon(draft, now)
    Column(
        modifier = modifier
            .clickable(role = Role.Button, onClick = onClick)
            .semantics(mergeDescendants = true) {}
            .padding(vertical = 11.dp),
    ) {
        Row(modifier = Modifier.fillMaxWidth()) {
            Text(
                text = DraftTime.lead(draft, now) ?: stringResource(R.string.draft_no_time),
                style = MaterialTheme.typography.labelSmall.copy(fontFeatureSettings = "tnum"),
                fontWeight = FontWeight.Normal,
                color = secondary,
                maxLines = 1,
                softWrap = false,
                overflow = TextOverflow.Clip,
                modifier = Modifier
                    .width(DraftLeadWidth)
                    .alignByBaseline(),
            )
            Spacer(Modifier.width(DraftLeadGap))
            Text(
                text = draftTitle(draft),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .weight(1f)
                    .alignByBaseline(),
            )
        }
        if (soon != null || folder != null) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier.padding(start = DraftLeadWidth + DraftLeadGap, top = 3.dp),
            ) {
                if (soon != null) DraftSoonLabel(soon)
                if (folder != null) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                        modifier = Modifier.weight(1f, fill = false),
                    ) {
                        Icon(LibraryIcons.Folder, contentDescription = null, tint = secondary, modifier = Modifier.size(12.dp))
                        Text(
                            text = folder,
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.Normal,
                            color = secondary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }
}

/**
 * The desktop's 開始 (`DraftRow.tsx`, `home.upcoming.start`): a small outline
 * button — the page's own fill, a hairline border, label-coloured medium text,
 * 28 dp tall with 8 dp corners — inside a 48 dp touch target. iOS
 * `DraftStartButton`.
 */
@Composable
private fun DraftStartButton(onClick: () -> Unit) {
    val shape = RoundedCornerShape(8.dp)
    // The press lands anywhere in the 48 dp target; the ripple stays inside
    // the drawn button.
    val interaction = remember { MutableInteractionSource() }
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .heightIn(min = 48.dp)
            .clickable(
                interactionSource = interaction,
                indication = null,
                role = Role.Button,
                onClick = onClick,
            ),
    ) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .height(28.dp)
                .clip(shape)
                .background(MaterialTheme.colorScheme.background, shape)
                .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
                .indication(interaction, LocalIndication.current)
                .padding(horizontal = 10.dp),
        ) {
            Text(
                text = stringResource(R.string.draft_start),
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                softWrap = false,
            )
        }
    }
}

/**
 * A draft page's 開始錄音 — the row's 開始 at the page's size, in the record
 * screen's own look and words: primary ink and the record dot on a faint
 * primary wash, full width (the Library's bottom Start recording).
 */
@Composable
private fun DraftStartRecordingButton(onClick: () -> Unit) {
    val primary = MaterialTheme.colorScheme.primary
    Row(
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(primary.copy(alpha = 0.12f))
            .clickable(role = Role.Button, onClick = onClick),
    ) {
        Box(
            Modifier
                .size(9.dp)
                .background(primary, CircleShape),
        )
        Spacer(Modifier.width(8.dp))
        Text(
            text = stringResource(R.string.meeting_start),
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
            color = primary,
        )
    }
}

/** The lead column: wide enough for 未定 / "No time" and a M/d date at the caption size. */
private val DraftLeadWidth = 48.dp
private val DraftLeadGap = 10.dp

/**
 * What a draft's row says about its time, as the desktop's row does. A draft
 * is still a draft once its time comes — nothing was recorded — so it never
 * says the meeting "started": inside its slot the start time has gone by,
 * after the slot it has lapsed.
 */
private sealed interface DraftSoon {
    data class Until(val until: MeetingDraftSchedule.Until) : DraftSoon
    data object PastStart : DraftSoon
    data object Missed : DraftSoon
}

/** [DraftSoon] for [draft] at [now]; null for a draft with no time. */
private fun draftSoon(draft: CloudMeetingDraft, now: Long): DraftSoon? {
    val start = draft.meetingAt ?: return null
    val until = MeetingDraftSchedule.untilStart(start, now)
    return when {
        until != MeetingDraftSchedule.Until.Started -> DraftSoon.Until(until)
        MeetingDraftSchedule.isOver(draft, now) -> DraftSoon.Missed
        else -> DraftSoon.PastStart
    }
}

@Composable
private fun DraftSoonLabel(soon: DraftSoon) {
    val style = MaterialTheme.typography.labelSmall.copy(fontFeatureSettings = "tnum")
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val text = when (soon) {
        is DraftSoon.Until -> when (val until = soon.until) {
            is MeetingDraftSchedule.Until.Minutes -> stringResource(R.string.draft_in_minutes, until.count)
            is MeetingDraftSchedule.Until.Hours -> stringResource(R.string.draft_in_hours, until.count)
            is MeetingDraftSchedule.Until.Days -> pluralStringResource(R.plurals.draft_in_days, until.count, until.count)
            MeetingDraftSchedule.Until.Started -> null
        }
        DraftSoon.PastStart -> stringResource(R.string.draft_past_start)
        DraftSoon.Missed -> stringResource(R.string.draft_missed)
    } ?: return
    // The one to act on: the desktop's primary, medium weight.
    val pastStart = soon == DraftSoon.PastStart
    Text(
        text = text,
        style = style,
        fontWeight = if (pastStart) FontWeight.Medium else FontWeight.Normal,
        color = if (pastStart) MaterialTheme.colorScheme.primary else secondary,
        maxLines = 1,
        softWrap = false,
    )
}

/** How a draft's time reads. */
internal object DraftTime {
    /**
     * The row's lead column: the clock time for a meeting today, the date for
     * any other day — 24-hour and numeric, as the desktop's row is
     * (`hour12: false` in both languages). Null = no time.
     */
    fun lead(draft: CloudMeetingDraft, now: Long, locale: Locale = Locale.getDefault()): String? {
        val at = draft.meetingAt ?: return null
        val pattern = if (sameDay(at, now)) {
            "HH:mm"
        } else {
            android.text.format.DateFormat.getBestDateTimePattern(locale, "Md")
        }
        return SimpleDateFormat(pattern, locale).format(Date(at))
    }

    /**
     * The detail page's line: the day, the start and the end — "Sat, Oct 31
     * 10:30 AM – 11:30 AM", 「10月31日 週六 上午10:30 – 上午11:30」. The year only
     * outside the current one, as the recording rows do.
     */
    fun full(
        draft: CloudMeetingDraft,
        locale: Locale = Locale.getDefault(),
        nowMs: Long = System.currentTimeMillis(),
    ): String? {
        val at = draft.meetingAt ?: return null
        val daySkeleton = if (LibraryRules.showsYear(at, nowMs)) "yMMMdEEE" else "MMMdEEE"
        val day = format(at, daySkeleton, locale)
        val start = format(at, "jmm", locale)
        val endAt = draft.meetingEndAt?.takeIf { it > at } ?: return "$day $start"
        val end = format(endAt, if (sameDay(at, endAt)) "jmm" else "MMMdjmm", locale)
        return "$day $start – $end"
    }

    private fun format(epochMs: Long, skeleton: String, locale: Locale): String {
        val pattern = android.text.format.DateFormat.getBestDateTimePattern(locale, skeleton)
        return SimpleDateFormat(pattern, locale).format(Date(epochMs))
    }

    private fun sameDay(a: Long, b: Long): Boolean {
        val ca = Calendar.getInstance().apply { timeInMillis = a }
        val cb = Calendar.getInstance().apply { timeInMillis = b }
        return ca.get(Calendar.YEAR) == cb.get(Calendar.YEAR) &&
            ca.get(Calendar.DAY_OF_YEAR) == cb.get(Calendar.DAY_OF_YEAR)
    }
}

// ── Detail ───────────────────────────────────────────────────────────────────

/**
 * One draft, read-only — iOS `MeetingDraftDetailView`: its title, when, which
 * folder the recording will be filed into, the context the desktop prepared
 * (its 補充背景), and the agenda, with 開始錄音 under the heading ([onStart]).
 * Editing is the desktop's; the page says so at the bottom rather than
 * offering a button that cannot work.
 *
 * The column takes the page's full width, not its content's, so a draft with
 * only a time and a folder still reads from the left edge; its height is the
 * caller's (the Library's page fills the screen, [MeetingDraftSheet] wraps
 * the content).
 *
 * @param onStart 開始錄音; null leaves the button out — the record screen's
 *   sheet shows the draft of a meeting that has already started.
 * @param meetingAgenda the running meeting's agenda, shown in place of the
 *   draft's and ticked with [onToggleAgenda] — the record screen's sheet. Null
 *   (the Library's page) shows the draft's agenda, display-only.
 */
@Composable
internal fun MeetingDraftPage(
    draft: CloudMeetingDraft,
    folder: String?,
    onStart: (() -> Unit)?,
    modifier: Modifier = Modifier,
    meetingAgenda: List<AgendaItem>? = null,
    onToggleAgenda: ((String) -> Unit)? = null,
) {
    val now = rememberDraftClock()
    val context = draft.meetingContext.trim()
    val agenda = (meetingAgenda?.map { AgendaRowModel(it.id, it.text, it.done) }
        ?: draft.todos.map { AgendaRowModel(it.id, it.text, it.done) })
        .filter { it.text.isNotBlank() }
    val toggle = onToggleAgenda.takeIf { meetingAgenda != null }
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Column(
        verticalArrangement = Arrangement.spacedBy(24.dp),
        horizontalAlignment = Alignment.Start,
        modifier = modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 32.dp),
    ) {
        Column(
            verticalArrangement = Arrangement.spacedBy(10.dp),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(
                text = draftTitle(draft),
                style = MaterialTheme.typography.titleLarge,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier
                    .fillMaxWidth()
                    .semantics { heading() },
            )
            Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
                Row(verticalAlignment = Alignment.Top, modifier = Modifier.fillMaxWidth()) {
                    Icon(
                        Icons.Filled.DateRange,
                        contentDescription = null,
                        tint = secondary,
                        modifier = Modifier
                            .padding(top = 1.dp)
                            .size(18.dp),
                    )
                    Spacer(Modifier.width(8.dp))
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp), modifier = Modifier.weight(1f)) {
                        Text(
                            text = DraftTime.full(draft) ?: stringResource(R.string.draft_no_time_set),
                            style = MaterialTheme.typography.bodyMedium,
                            color = secondary,
                        )
                        draftSoon(draft, now)?.let { DraftSoonLabel(it) }
                    }
                }
                if (folder != null) {
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                        Icon(LibraryIcons.Folder, contentDescription = null, tint = secondary, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        Text(
                            text = folder,
                            style = MaterialTheme.typography.bodyMedium,
                            color = secondary,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
            }
        }
        if (onStart != null) DraftStartRecordingButton(onClick = onStart)
        if (context.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
                OverviewHeading(title = stringResource(R.string.draft_context))
                SelectionContainer {
                    Text(
                        text = context,
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
        if (agenda.isNotEmpty()) {
            Column(modifier = Modifier.fillMaxWidth()) {
                OverviewHeading(title = stringResource(R.string.draft_agenda))
                agenda.forEachIndexed { index, item ->
                    if (index > 0) {
                        HorizontalDivider(thickness = 0.5.dp, color = MaterialTheme.colorScheme.outlineVariant)
                    }
                    AgendaRow(item, onToggle = toggle?.let { tick -> { tick(item.id) } })
                }
            }
        }
        Text(
            text = stringResource(R.string.draft_edit_on_desktop),
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Normal,
            color = MaterialTheme.colorScheme.outline,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

/**
 * The record screen's "view the meeting draft": the draft the meeting was
 * started from in a modal sheet — the Library's draft page without 開始錄音,
 * since the meeting it would start is the one already going. The draft itself
 * is read-only, but its agenda is the meeting's to-do list: [agenda] is the
 * meeting's live state (not the draft's), and a tap ticks or unticks an item
 * through [onToggleAgenda], as the desktop's meeting does. As tall as the
 * draft needs; a long agenda scrolls inside the sheet.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun MeetingDraftSheet(
    draft: CloudMeetingDraft,
    folder: String?,
    agenda: List<AgendaItem>,
    onToggleAgenda: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        MeetingDraftPage(
            draft = draft,
            folder = folder,
            onStart = null,
            meetingAgenda = agenda,
            onToggleAgenda = onToggleAgenda,
        )
    }
}

/** What an agenda row draws: a draft's item, or the meeting's. */
private data class AgendaRowModel(val id: String, val text: String, val done: Boolean)

/**
 * One agenda item with its circle: filled when done, an empty ring when not.
 * With [onToggle] the whole row is a checkbox (at least 48dp tall) that ticks
 * it; without, it only shows the state.
 */
@Composable
private fun AgendaRow(item: AgendaRowModel, onToggle: (() -> Unit)?) {
    val interaction = if (onToggle != null) {
        Modifier
            .heightIn(min = 48.dp)
            .toggleable(
                value = item.done,
                role = Role.Checkbox,
                onValueChange = { onToggle() },
            )
    } else {
        Modifier.semantics(mergeDescendants = true) { selected = item.done }
    }
    Row(
        verticalAlignment = Alignment.Top,
        modifier = Modifier
            .fillMaxWidth()
            .then(interaction)
            .padding(vertical = 10.dp),
    ) {
        Box(Modifier.size(20.dp), contentAlignment = Alignment.Center) {
            if (item.done) {
                Icon(
                    Icons.Filled.CheckCircle,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(20.dp),
                )
            } else {
                Box(
                    Modifier
                        .size(16.dp)
                        .border(1.5.dp, MaterialTheme.colorScheme.outline, CircleShape),
                )
            }
        }
        Spacer(Modifier.width(10.dp))
        // Done reads done: greyed and struck through, as the desktop's
        // TodosPanel and iOS draw it.
        Text(
            text = item.text,
            style = MaterialTheme.typography.bodyMedium,
            color = if (item.done) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
            textDecoration = if (item.done) TextDecoration.LineThrough else null,
            modifier = Modifier.weight(1f),
        )
    }
}
