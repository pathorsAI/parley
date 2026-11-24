import XCTest

@testable import ParleyKit

final class ImportSplitTests: XCTestCase {
    func testUnknownDurationIsNotSplit() {
        XCTAssertEqual(ImportSplit.partCount(durationSeconds: nil), 1)
        XCTAssertEqual(ImportSplit.partCount(durationSeconds: .nan), 1)
        XCTAssertEqual(ImportSplit.partCount(durationSeconds: .infinity), 1)
    }

    func testShortAndExactlyAtTheLimitIsOnePart() {
        XCTAssertEqual(ImportSplit.partCount(durationSeconds: 0), 1)
        XCTAssertEqual(ImportSplit.partCount(durationSeconds: 3600), 1)
        XCTAssertEqual(ImportSplit.hostedMaxPartSeconds, 21_000)
        XCTAssertEqual(ImportSplit.partCount(durationSeconds: 5 * 3600 + 50 * 60), 1)
    }

    func testOneSecondOverTheLimitIsTwoParts() {
        XCTAssertEqual(ImportSplit.partCount(durationSeconds: 5 * 3600 + 50 * 60 + 1), 2)
        XCTAssertEqual(ImportSplit.partCount(durationSeconds: 6 * 3600), 2)
    }

    func testThirteenHoursIsThreeParts() {
        XCTAssertEqual(ImportSplit.partCount(durationSeconds: 13 * 3600), 3)
        // 11 h 40 m is exactly two full parts; one more second needs a third.
        XCTAssertEqual(ImportSplit.partCount(durationSeconds: 2 * 21_000), 2)
        XCTAssertEqual(ImportSplit.partCount(durationSeconds: 2 * 21_000 + 1), 3)
    }

    func testPartsAreEqualAndCoverTheStream() {
        let total: Int64 = 13 * 3600 * 16_000
        let ranges = ImportSplit.partRanges(totalSamples: total, parts: 3)
        XCTAssertEqual(ranges.count, 3)
        XCTAssertEqual(ranges.first?.lowerBound, 0)
        XCTAssertEqual(ranges.last?.upperBound, total)
        for (a, b) in zip(ranges, ranges.dropFirst()) { XCTAssertEqual(a.upperBound, b.lowerBound) }
        XCTAssertEqual(Set(ranges.map(\.count)).count, 1)
        // Every part fits one hosted transcription.
        for range in ranges {
            XCTAssertLessThanOrEqual(
                Double(range.count) / 16_000, ImportSplit.hostedMaxPartSeconds)
        }
    }

    func testUnevenRemainderGoesToTheFirstParts() {
        XCTAssertEqual(ImportSplit.partEnds(totalSamples: 10, parts: 3), [4, 7, 10])
        XCTAssertEqual(ImportSplit.partEnds(totalSamples: 9, parts: 3), [3, 6, 9])
    }

    func testSinglePartIsTheWholeStream() {
        XCTAssertEqual(ImportSplit.partEnds(totalSamples: 1000, parts: 1), [1000])
        XCTAssertEqual(ImportSplit.partRanges(totalSamples: 1000, parts: 1), [0..<1000])
    }

    func testPartTitles() {
        XCTAssertEqual(ImportSplit.partTitle("週會", part: 1, of: 3, chinese: true), "週會（1/3）")
        XCTAssertEqual(
            ImportSplit.partTitle("Offsite", part: 2, of: 3, chinese: false), "Offsite (2/3)")
        XCTAssertEqual(ImportSplit.partTitle("Offsite", part: 1, of: 1, chinese: false), "Offsite")
    }

    func testHoursAndMinutesRoundToTheMinute() {
        XCTAssertEqual(ImportSplit.hoursAndMinutes(7 * 3600 + 12 * 60).hours, 7)
        XCTAssertEqual(ImportSplit.hoursAndMinutes(7 * 3600 + 12 * 60).minutes, 12)
        let half = ImportSplit.hoursAndMinutes(13 * 3600 / 3)  // 4 h 20 m
        XCTAssertEqual(half.hours, 4)
        XCTAssertEqual(half.minutes, 20)
        XCTAssertEqual(ImportSplit.hoursAndMinutes(3600 * 2 - 10).hours, 2)
        XCTAssertEqual(ImportSplit.hoursAndMinutes(3600 * 2 - 10).minutes, 0)
    }
}
