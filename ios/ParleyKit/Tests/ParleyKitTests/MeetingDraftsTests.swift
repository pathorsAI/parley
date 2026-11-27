import XCTest

@testable import ParleyKit

/// The desktop's own cases for `sortDrafts`, `isStartingSoon` and
/// `untilStart` (`src/lib/store/prep.test.ts`, `src/lib/meeting/timeSlots.test.ts`),
/// ported, plus the cloud body read defensively.
final class MeetingDraftsTests: XCTestCase {
    private func draft(
        _ id: String, at: Double? = nil, endAt: Double? = nil, updatedAt: Double = 0,
        deletedAt: Double? = nil
    ) -> CloudMeetingDraft {
        CloudMeetingDraft(
            id: id, title: id, meetingAt: at, meetingEndAt: endAt, updatedAt: updatedAt,
            deletedAt: deletedAt)
    }

    // MARK: sortDrafts

    func testTimedDraftsSoonestFirstThenUntimedNewestFirst() {
        let sorted = MeetingDraftSchedule.sorted([
            draft("untimed-old", updatedAt: 1),
            draft("later", at: 2_000),
            draft("untimed-new", updatedAt: 5),
            draft("sooner", at: 1_000),
        ])
        XCTAssertEqual(sorted.map(\.id), ["sooner", "later", "untimed-new", "untimed-old"])
    }

    func testGivenNowMeetingsAlreadyOverDropBelowTheRestLatestFirst() {
        let h = 3_600_000.0
        let now = 10 * h
        let sorted = MeetingDraftSchedule.sorted(
            [
                draft("over-long-ago", at: now - 5 * h),
                draft("untimed", updatedAt: 1),
                draft("in-2h", at: now + 2 * h),
                draft("over-recently", at: now - 3 * h, endAt: now - h),
                draft("in-10m", at: now + 600_000),
            ], now: now)
        XCTAssertEqual(
            sorted.map(\.id), ["in-10m", "in-2h", "untimed", "over-recently", "over-long-ago"])
    }

    func testSortingLeavesTheInputAlone() {
        let input = [draft("b", at: 20), draft("a", at: 10)]
        XCTAssertEqual(MeetingDraftSchedule.sorted(input).map(\.id), ["a", "b"])
        XCTAssertEqual(input.map(\.id), ["b", "a"])
    }

    // MARK: isStartingSoon

    private let now = 1_000_000_000.0
    private let min = 60_000.0

    func testTakesAMeetingStartingWithinTheHourAndNotOneFurtherOut() {
        XCTAssertTrue(MeetingDraftSchedule.isStartingSoon(draft("a", at: now + 30 * min), now: now))
        XCTAssertTrue(
            MeetingDraftSchedule.isStartingSoon(
                draft("b", at: now + MeetingDraftSchedule.startingSoonMs), now: now))
        XCTAssertFalse(MeetingDraftSchedule.isStartingSoon(draft("c", at: now + 61 * min), now: now))
    }

    func testKeepsAMeetingUnderWayUntilItEndsAnHourWhenItHasNoEnd() {
        XCTAssertTrue(
            MeetingDraftSchedule.isStartingSoon(
                draft("a", at: now - 10 * min, endAt: now + 20 * min), now: now))
        XCTAssertFalse(
            MeetingDraftSchedule.isStartingSoon(
                draft("b", at: now - 90 * min, endAt: now - min), now: now))
        XCTAssertTrue(MeetingDraftSchedule.isStartingSoon(draft("c", at: now - 30 * min), now: now))
        XCTAssertFalse(MeetingDraftSchedule.isStartingSoon(draft("d", at: now - 61 * min), now: now))
    }

    func testNeverTakesAnUntimedDraft() {
        XCTAssertFalse(MeetingDraftSchedule.isStartingSoon(draft("a"), now: now))
    }

    // MARK: the overview's split

    func testSplitsStartingSoonFromTheRestAndLeavesTombstonesOut() {
        let split = MeetingDraftSchedule.split(
            [
                draft("tomorrow", at: now + 24 * 60 * min),
                draft("in-20m", at: now + 20 * min),
                draft("untimed", updatedAt: 3),
                draft("deleted", at: now + 5 * min, deletedAt: now - min),
                draft("under-way", at: now - 15 * min),
            ], now: now)
        XCTAssertEqual(split.startingSoon.map(\.id), ["under-way", "in-20m"])
        XCTAssertEqual(split.later.map(\.id), ["tomorrow", "untimed"])
    }

    // MARK: untilStart

    func testCountsMinutesHoursThenDays() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Asia/Taipei")!
        func at(_ h: Int, _ m: Int, day: Int = 30) -> Double {
            cal.date(from: DateComponents(year: 2026, month: 10, day: day, hour: h, minute: m))!
                .timeIntervalSince1970 * 1000
        }
        let now = at(14, 0)
        XCTAssertEqual(MeetingDraftSchedule.untilStart(at(14, 25), now: now), .minutes(25))
        XCTAssertEqual(MeetingDraftSchedule.untilStart(at(16, 10), now: now), .hours(2))
        XCTAssertEqual(MeetingDraftSchedule.untilStart(at(14, 0, day: 32), now: now), .days(2))
        XCTAssertEqual(MeetingDraftSchedule.untilStart(at(13, 50), now: now), .started)
    }

    func testRoundsHalfHoursUpLikeTheDesktop() {
        XCTAssertEqual(MeetingDraftSchedule.untilStart(now + 90 * min, now: now), .hours(2))
        XCTAssertEqual(MeetingDraftSchedule.untilStart(now + 89 * min, now: now), .hours(1))
        XCTAssertEqual(MeetingDraftSchedule.untilStart(now + 30_000, now: now), .minutes(1))
    }

    // MARK: the cloud body

    func testReadsTheCloudBodyDefensively() throws {
        let json = """
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
              {"title": "no id at all"}
            ]}
            """
        let body = try JSONDecoder().decode(DraftListResponse.self, from: Data(json.utf8))
        XCTAssertEqual(body.drafts.map(\.id), ["d1", "d2"])
        let d1 = body.drafts[0]
        XCTAssertEqual(d1.title, "Renewal")
        XCTAssertEqual(d1.meetingAt, 1_700_000_600_000)
        XCTAssertNil(d1.meetingEndAt)
        XCTAssertEqual(d1.meetingContext, "Two people from procurement.")
        XCTAssertEqual(d1.todos, [CloudDraftTodo(id: "t1", text: "Ask about volume")])
        XCTAssertEqual(d1.meetingFolderId, "f1")
        let d2 = body.drafts[1]
        XCTAssertEqual(d2.title, "")
        XCTAssertNil(d2.meetingAt)
        XCTAssertEqual(d2.todos, [])
        XCTAssertEqual(d2.deletedAt, 6)
        XCTAssertEqual(MeetingDraftSchedule.live(body.drafts).map(\.id), ["d1"])
    }
}
