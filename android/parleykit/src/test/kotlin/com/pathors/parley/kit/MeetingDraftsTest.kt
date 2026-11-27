package com.pathors.parley.kit

import com.pathors.parley.kit.MeetingDraftSchedule.Until
import java.time.ZoneId
import java.time.ZonedDateTime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The desktop's own cases for `sortDrafts`, `isStartingSoon` and `untilStart`
 * (`src/lib/store/prep.test.ts`, `src/lib/meeting/timeSlots.test.ts`), ported
 * case for case from iOS `ParleyKitTests/MeetingDraftsTests.swift`, plus the
 * cloud body read defensively.
 */
class MeetingDraftsTest {

    private fun draft(
        id: String,
        at: Long? = null,
        endAt: Long? = null,
        updatedAt: Long = 0L,
        deletedAt: Long? = null,
    ) = CloudMeetingDraft(
        id = id,
        title = id,
        meetingAt = at,
        meetingEndAt = endAt,
        updatedAt = updatedAt,
        deletedAt = deletedAt,
    )

    // ── sortDrafts ───────────────────────────────────────────────────────────

    @Test
    fun `timed drafts soonest first, then untimed newest first`() {
        val sorted = MeetingDraftSchedule.sorted(
            listOf(
                draft("untimed-old", updatedAt = 1),
                draft("later", at = 2_000),
                draft("untimed-new", updatedAt = 5),
                draft("sooner", at = 1_000),
            ),
        )
        assertEquals(listOf("sooner", "later", "untimed-new", "untimed-old"), sorted.map { it.id })
    }

    @Test
    fun `given now, meetings already over drop below the rest, latest first`() {
        val h = 3_600_000L
        val now = 10 * h
        val sorted = MeetingDraftSchedule.sorted(
            listOf(
                draft("over-long-ago", at = now - 5 * h),
                draft("untimed", updatedAt = 1),
                draft("in-2h", at = now + 2 * h),
                draft("over-recently", at = now - 3 * h, endAt = now - h),
                draft("in-10m", at = now + 600_000),
            ),
            now,
        )
        assertEquals(
            listOf("in-10m", "in-2h", "untimed", "over-recently", "over-long-ago"),
            sorted.map { it.id },
        )
    }

    @Test
    fun `sorting leaves the input alone`() {
        val input = listOf(draft("b", at = 20), draft("a", at = 10))
        assertEquals(listOf("a", "b"), MeetingDraftSchedule.sorted(input).map { it.id })
        assertEquals(listOf("b", "a"), input.map { it.id })
    }

    @Test
    fun `ties keep their input order`() {
        val sorted = MeetingDraftSchedule.sorted(
            listOf(draft("first", at = 10), draft("second", at = 10), draft("third", updatedAt = 3)),
        )
        assertEquals(listOf("first", "second", "third"), sorted.map { it.id })
    }

    // ── isStartingSoon ───────────────────────────────────────────────────────

    private val now = 1_000_000_000L
    private val min = 60_000L

    @Test
    fun `takes a meeting starting within the hour and not one further out`() {
        assertTrue(MeetingDraftSchedule.isStartingSoon(draft("a", at = now + 30 * min), now))
        assertTrue(
            MeetingDraftSchedule.isStartingSoon(draft("b", at = now + MeetingDraftSchedule.STARTING_SOON_MS), now),
        )
        assertFalse(MeetingDraftSchedule.isStartingSoon(draft("c", at = now + 61 * min), now))
    }

    @Test
    fun `keeps a meeting under way until it ends, an hour when it has no end`() {
        assertTrue(MeetingDraftSchedule.isStartingSoon(draft("a", at = now - 10 * min, endAt = now + 20 * min), now))
        assertFalse(MeetingDraftSchedule.isStartingSoon(draft("b", at = now - 90 * min, endAt = now - min), now))
        assertTrue(MeetingDraftSchedule.isStartingSoon(draft("c", at = now - 30 * min), now))
        assertFalse(MeetingDraftSchedule.isStartingSoon(draft("d", at = now - 61 * min), now))
    }

    @Test
    fun `never takes an untimed draft`() {
        assertFalse(MeetingDraftSchedule.isStartingSoon(draft("a"), now))
        assertFalse(MeetingDraftSchedule.isOver(draft("a"), now))
    }

    // ── the overview's split ─────────────────────────────────────────────────

    @Test
    fun `splits starting soon from the rest and leaves tombstones out`() {
        val split = MeetingDraftSchedule.split(
            listOf(
                draft("tomorrow", at = now + 24 * 60 * min),
                draft("in-20m", at = now + 20 * min),
                draft("untimed", updatedAt = 3),
                draft("deleted", at = now + 5 * min, deletedAt = now - min),
                draft("under-way", at = now - 15 * min),
            ),
            now,
        )
        assertEquals(listOf("under-way", "in-20m"), split.startingSoon.map { it.id })
        assertEquals(listOf("tomorrow", "untimed"), split.later.map { it.id })
    }

    // ── untilStart ───────────────────────────────────────────────────────────

    @Test
    fun `counts minutes, hours, then days`() {
        val zone = ZoneId.of("Asia/Taipei")
        fun at(h: Int, m: Int, plusDays: Long = 0): Long =
            ZonedDateTime.of(2026, 10, 30, h, m, 0, 0, zone).plusDays(plusDays).toInstant().toEpochMilli()
        val now = at(14, 0)
        assertEquals(Until.Minutes(25), MeetingDraftSchedule.untilStart(at(14, 25), now))
        assertEquals(Until.Hours(2), MeetingDraftSchedule.untilStart(at(16, 10), now))
        assertEquals(Until.Days(2), MeetingDraftSchedule.untilStart(at(14, 0, plusDays = 2), now))
        assertEquals(Until.Started, MeetingDraftSchedule.untilStart(at(13, 50), now))
    }

    @Test
    fun `rounds half hours up like the desktop`() {
        assertEquals(Until.Hours(2), MeetingDraftSchedule.untilStart(now + 90 * min, now))
        assertEquals(Until.Hours(1), MeetingDraftSchedule.untilStart(now + 89 * min, now))
        assertEquals(Until.Minutes(1), MeetingDraftSchedule.untilStart(now + 30_000, now))
        assertEquals(Until.Started, MeetingDraftSchedule.untilStart(now, now))
    }

    // ── the cloud body ───────────────────────────────────────────────────────

    @Test
    fun `reads the cloud body defensively`() {
        val json = """
            {"now": 1700000000000, "drafts": [
              {"id": "d1", "title": "Renewal", "meetingAt": 1700000600000, "meetingEndAt": null,
               "reminderLeadMin": 5, "meetingContext": "Two people from procurement.",
               "meetingBatna": "", "meetingTarget": "", "meetingFloor": "",
               "todos": [{"id": "t1", "text": "Ask about volume", "done": false}, {"text": "no id"}],
               "playbook": {"branches": [], "topics": []},
               "meetingFolderId": "f1", "meetingOrgShare": {"orgId": "o1", "folderId": null},
               "updatedAt": 1699999000000, "deletedAt": null},
              {"id": "d2", "title": 42, "meetingAt": "soon", "todos": "nope", "updatedAt": 5,
               "deletedAt": 6, "meetingOrgShare": "off"},
              {"title": "no id at all"},
              "not even an object"
            ]}
        """.trimIndent()
        val drafts = MeetingDraftJson.parseList(json)
        assertNotNull(drafts)
        assertEquals(listOf("d1", "d2"), drafts!!.map { it.id })
        val d1 = drafts[0]
        assertEquals("Renewal", d1.title)
        assertEquals(1_700_000_600_000L, d1.meetingAt)
        assertNull(d1.meetingEndAt)
        assertEquals("Two people from procurement.", d1.meetingContext)
        assertEquals(listOf(CloudDraftTodo(id = "t1", text = "Ask about volume")), d1.todos)
        assertEquals("f1", d1.meetingFolderId)
        assertEquals(1_699_999_000_000L, d1.updatedAt)
        val d2 = drafts[1]
        assertEquals("", d2.title)
        assertNull(d2.meetingAt)
        assertEquals(emptyList<CloudDraftTodo>(), d2.todos)
        assertEquals(6L, d2.deletedAt)
        assertEquals(listOf("d1"), MeetingDraftSchedule.live(drafts).map { it.id })
    }

    @Test
    fun `a body without a drafts array is unreadable, not empty`() {
        assertNull(MeetingDraftJson.parseList("""{"now": 1}"""))
        assertNull(MeetingDraftJson.parseList("""{"drafts": "nope"}"""))
        assertNull(MeetingDraftJson.parseList("not json"))
        assertEquals(emptyList<CloudMeetingDraft>(), MeetingDraftJson.parseList("""{"drafts": []}"""))
    }
}
