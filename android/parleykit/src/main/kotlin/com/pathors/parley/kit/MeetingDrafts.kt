package com.pathors.parley.kit

import kotlin.math.ceil
import kotlin.math.floor
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

// Meeting drafts, read-only on the phone (#774, the Android half of iOS #772).
// A draft is everything the desktop prepared for one upcoming meeting — title,
// time, the context, the agenda — saved to Parley Cloud by the desktop's draft
// sync (`src/lib/cloud/draftSync.ts`) or by an AI over the cloud MCP. The phone
// only reads them (`GET /v1/drafts`); creating, editing and deleting stay on
// the desktop, so nothing here ever writes one back.
//
// The ordering and the "starting soon" split are the desktop's own
// (`sortDrafts`, `isOver`, `isStartingSoon` in `src/lib/store/prep.ts`, and
// `untilStart` in `src/lib/meeting/timeSlots.ts`), ported as pure functions —
// the same port as iOS `MeetingDraftSchedule` — so the unit tests hold them to
// the desktop's cases.

/** One agenda item of a draft, as the cloud stores it. */
data class CloudDraftTodo(
    val id: String,
    val text: String,
    val done: Boolean = false,
)

/**
 * A draft as `GET /v1/drafts` returns it — only the fields the phone shows.
 * The negotiation fields, the playbook and the org share ride along in the
 * response and are ignored here.
 */
data class CloudMeetingDraft(
    val id: String,
    val title: String,
    /** Epoch ms the meeting starts; null = no time set yet. */
    val meetingAt: Long? = null,
    /** Epoch ms it ends; null = an hour after it starts. */
    val meetingEndAt: Long? = null,
    val meetingContext: String = "",
    val todos: List<CloudDraftTodo> = emptyList(),
    /** The personal folder the recording will be filed into. */
    val meetingFolderId: String? = null,
    /** Epoch ms of the last change. */
    val updatedAt: Long = 0L,
    /** Epoch ms of the deletion; null = live. */
    val deletedAt: Long? = null,
)

/**
 * Reads `GET /v1/drafts`'s body, `{ drafts, now }`, defensively — as the
 * desktop's `fromCloudDraft` and iOS's `Lossy` rows do: a malformed field falls
 * back to empty, a row without a string id is dropped alone, and an agenda item
 * without one costs only that item.
 */
object MeetingDraftJson {
    private val json = Json { ignoreUnknownKeys = true }

    /** The drafts of a response body, or null when the body has no `drafts` array at all. */
    fun parseList(text: String): List<CloudMeetingDraft>? {
        val root = runCatching { json.parseToJsonElement(text) }.getOrNull() as? JsonObject ?: return null
        val rows = root["drafts"] as? JsonArray ?: return null
        return rows.mapNotNull(::parseDraft)
    }

    /** One draft row, or null when it is not an object with a string `id`. */
    fun parseDraft(element: JsonElement): CloudMeetingDraft? {
        val obj = element as? JsonObject ?: return null
        val id = obj.draftString("id") ?: return null
        return CloudMeetingDraft(
            id = id,
            title = obj.draftString("title").orEmpty(),
            meetingAt = obj.draftMs("meetingAt"),
            meetingEndAt = obj.draftMs("meetingEndAt"),
            meetingContext = obj.draftString("meetingContext").orEmpty(),
            todos = (obj["todos"] as? JsonArray).orEmpty().mapNotNull(::parseTodo),
            meetingFolderId = obj.draftString("meetingFolderId"),
            updatedAt = obj.draftMs("updatedAt") ?: 0L,
            deletedAt = obj.draftMs("deletedAt"),
        )
    }

    private fun parseTodo(element: JsonElement): CloudDraftTodo? {
        val obj = element as? JsonObject ?: return null
        val id = obj.draftString("id") ?: return null
        return CloudDraftTodo(
            id = id,
            text = obj.draftString("text").orEmpty(),
            done = (obj["done"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull ?: false,
        )
    }

    /** A string field; null when it is missing, null, or not a string. */
    private fun JsonObject.draftString(key: String): String? =
        (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    /** An epoch-ms field; null when it is missing, null, not a number, or not finite. */
    private fun JsonObject.draftMs(key: String): Long? =
        (this[key] as? JsonPrimitive)
            ?.takeIf { !it.isString }
            ?.doubleOrNull
            ?.takeIf { it.isFinite() }
            ?.toLong()
}

/** The desktop's draft lists, as pure functions of the drafts and the clock. */
object MeetingDraftSchedule {
    /**
     * How far ahead 即將開始的會議 looks: a meeting moves up there an hour
     * before it starts. Also how long a meeting without an end time runs.
     */
    const val STARTING_SOON_MS: Long = 60L * 60_000L

    /** The live drafts of a pull: the tombstones (`deletedAt`) left out. */
    fun live(drafts: List<CloudMeetingDraft>): List<CloudMeetingDraft> = drafts.filter { it.deletedAt == null }

    /** The end of a timed draft's meeting: its end time, or an hour after it starts. */
    private fun end(d: CloudMeetingDraft, start: Long): Long = d.meetingEndAt ?: (start + STARTING_SOON_MS)

    /** Has this draft's meeting come and gone? Untimed drafts never have. */
    fun isOver(d: CloudMeetingDraft, now: Long): Boolean {
        val start = d.meetingAt ?: return false
        return end(d, start) <= now
    }

    /**
     * Is this draft's meeting about to start (within an hour) or under way? A
     * meeting without an end time counts as running for an hour.
     */
    fun isStartingSoon(d: CloudMeetingDraft, now: Long): Boolean {
        val start = d.meetingAt ?: return false
        return start <= now + STARTING_SOON_MS && !isOver(d, now)
    }

    /**
     * The order the draft lists show: timed drafts soonest first, then the
     * untimed ones, newest first. Given [now], a meeting already over drops
     * below both, the latest first, so the next meeting is always on top.
     * Stable, like the desktop's `Array.prototype.sort`: ties keep their input
     * order.
     */
    fun sorted(drafts: List<CloudMeetingDraft>, now: Long? = null): List<CloudMeetingDraft> {
        fun rank(d: CloudMeetingDraft): Int = when {
            d.meetingAt == null -> 1
            now != null && isOver(d, now) -> 2
            else -> 0
        }
        return drafts.sortedWith { a, b ->
            val ra = rank(a)
            val rb = rank(b)
            val ta = a.meetingAt
            val tb = b.meetingAt
            when {
                ra != rb -> ra.compareTo(rb)
                ta != null && tb != null && ta != tb -> if (ra == 2) tb.compareTo(ta) else ta.compareTo(tb)
                ta == null && tb == null && a.updatedAt != b.updatedAt -> b.updatedAt.compareTo(a.updatedAt)
                else -> 0
            }
        }
    }

    /** The overview's two lists: the meetings starting within the hour (or under way), and every other draft. */
    data class Split(
        val startingSoon: List<CloudMeetingDraft>,
        val later: List<CloudMeetingDraft>,
    )

    /** 總覽's split, both lists in [sorted] order, tombstones left out. */
    fun split(drafts: List<CloudMeetingDraft>, now: Long): Split {
        val ordered = sorted(live(drafts), now)
        val (soon, later) = ordered.partition { isStartingSoon(it, now) }
        return Split(startingSoon = soon, later = later)
    }

    /** How long until a meeting starts, as the row says it: minutes, then hours, then days — or that it has started. */
    sealed interface Until {
        data object Started : Until
        data class Minutes(val count: Int) : Until
        data class Hours(val count: Int) : Until
        data class Days(val count: Int) : Until
    }

    fun untilStart(startMs: Long, now: Long): Until {
        val minutes = ceil((startMs - now) / 60_000.0).toInt()
        return when {
            minutes <= 0 -> Until.Started
            minutes < 60 -> Until.Minutes(minutes)
            minutes < 24 * 60 -> Until.Hours(jsRound(minutes / 60.0))
            else -> Until.Days(jsRound(minutes / (24.0 * 60.0)))
        }
    }

    /** JavaScript's `Math.round`: halves go up (towards +∞). */
    private fun jsRound(x: Double): Int = floor(x + 0.5).toInt()
}
