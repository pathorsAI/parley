package com.pathors.parley.ui

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.pathors.parley.R
import com.pathors.parley.kit.CloudDraftTodo
import com.pathors.parley.kit.CloudMeetingDraft
import com.pathors.parley.kit.MeetingDraftSchedule
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
// them and nothing more — no create, edit, delete, or start. `HomeScreen`
// places the sections and owns the pages; everything here only draws and
// reports taps.

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
 * it how soon and which folder. No 開始 button: starting a recording from a
 * draft waits for the record flow's redesign (#759).
 */
@Composable
private fun DraftRow(draft: CloudMeetingDraft, now: Long, folder: String?, onClick: () -> Unit) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val soon = draftSoon(draft, now)
    Column(
        modifier = Modifier
            .fillMaxWidth()
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
 * (its 補充背景), and the agenda. Editing is the desktop's; the page says so at
 * the bottom rather than offering a button that cannot work.
 *
 * The column takes the page's full width, not its content's, so a draft with
 * only a time and a folder still reads from the left edge.
 */
@Composable
internal fun MeetingDraftPage(draft: CloudMeetingDraft, folder: String?, modifier: Modifier = Modifier) {
    val now = rememberDraftClock()
    val context = draft.meetingContext.trim()
    val agenda = draft.todos.filter { it.text.isNotBlank() }
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Column(
        verticalArrangement = Arrangement.spacedBy(24.dp),
        horizontalAlignment = Alignment.Start,
        modifier = modifier
            .fillMaxSize()
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
                    AgendaRow(item)
                }
            }
        }
        Text(
            text = stringResource(R.string.draft_edit_on_desktop),
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Normal,
            color = MaterialTheme.colorScheme.outline,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

/** One agenda item with its read-only circle: filled when done, an empty ring when not. */
@Composable
private fun AgendaRow(item: CloudDraftTodo) {
    Row(
        verticalAlignment = Alignment.Top,
        modifier = Modifier
            .fillMaxWidth()
            .semantics(mergeDescendants = true) { selected = item.done }
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
        Text(
            text = item.text,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.weight(1f),
        )
    }
}
