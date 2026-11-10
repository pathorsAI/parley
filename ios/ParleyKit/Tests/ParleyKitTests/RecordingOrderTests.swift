import XCTest

@testable import ParleyKit

final class RecordingOrderTests: XCTestCase {

    private func recording(_ id: String, _ iso: String) -> CloudRecordingSummary {
        let date = ISO8601DateFormatter().date(from: iso)!
        return CloudRecordingSummary(
            id: id, title: id, source: "live", createdAt: date.timeIntervalSince1970 * 1000,
            durationMs: 60_000, speakerCount: nil, findingsCount: nil, actionItemsCount: nil,
            hasAudio: true, snippet: nil, folderId: "acme", updatedAt: nil)
    }

    func testNewestMeetingComesFirst() {
        let list = [
            recording("mar-8", "2026-03-08T10:00:00Z"),
            recording("jul-17", "2026-07-17T09:30:00Z"),
            recording("jan-2", "2026-01-02T15:00:00Z"),
        ]
        XCTAssertEqual(RecordingOrder.newestFirst(list).map(\.id), ["jul-17", "mar-8", "jan-2"])
    }

    func testTheYearCountsNotJustTheDay() {
        let list = [
            recording("jul-17-2025", "2025-07-17T09:30:00Z"),
            recording("mar-8-2026", "2026-03-08T10:00:00Z"),
        ]
        XCTAssertEqual(
            RecordingOrder.newestFirst(list).map(\.id), ["mar-8-2026", "jul-17-2025"])
    }

    func testSameMomentIsOrderedById() {
        let list = [
            recording("b", "2026-03-08T10:00:00Z"),
            recording("a", "2026-03-08T10:00:00Z"),
        ]
        XCTAssertEqual(RecordingOrder.newestFirst(list).map(\.id), ["a", "b"])
    }
}
