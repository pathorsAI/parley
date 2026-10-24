import XCTest

@testable import ParleyKit

final class UploadParkingTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    // MARK: classification

    func testRefusalsThatUsedToDeleteTheMeetingNowPark() {
        // 402 (out of quota) and 400 (a body cut off mid-transfer) were the two
        // answers that sent the only copy of a meeting to the bin.
        for status in [400, 402, 404, 409, 410, 413, 415, 422, 499] {
            XCTAssertEqual(UploadFailureDisposition.of(httpStatus: status), .park, "\(status)")
        }
    }

    func testAnswersSomebodysLaterActionClearsStopThePass() {
        for status in [401, 403, 408, 425, 429] {
            XCTAssertEqual(UploadFailureDisposition.of(httpStatus: status), .stopPass, "\(status)")
        }
    }

    func testTransportAndServerFailuresStopThePass() {
        for status in [0, 200, 302, 500, 502, 503, 504] {
            XCTAssertEqual(UploadFailureDisposition.of(httpStatus: status), .stopPass, "\(status)")
        }
    }

    // MARK: ladder

    func testLadderWaitsAnHourThenSixThenADayThenForTheUser() {
        var parking = UploadParking(httpStatus: 413, at: t0)
        XCTAssertEqual(parking.nextAutomaticRetry, t0.addingTimeInterval(3_600))

        let t1 = t0.addingTimeInterval(3_600)
        parking = parking.refusedAgain(httpStatus: 413, at: t1)
        XCTAssertEqual(parking.nextAutomaticRetry, t1.addingTimeInterval(6 * 3_600))

        let t2 = t1.addingTimeInterval(6 * 3_600)
        parking = parking.refusedAgain(httpStatus: 413, at: t2)
        XCTAssertEqual(parking.nextAutomaticRetry, t2.addingTimeInterval(24 * 3_600))

        parking = parking.refusedAgain(httpStatus: 413, at: t2.addingTimeInterval(24 * 3_600))
        XCTAssertNil(parking.nextAutomaticRetry)
        XCTAssertEqual(parking.refusals, 4)
        XCTAssertEqual(parking.firstRefusedAt, t0)
    }

    func testAutomaticPassesWaitForTheLadder() {
        let parking = UploadParking(httpStatus: 400, at: t0)
        XCTAssertFalse(parking.isDue(now: t0.addingTimeInterval(60), trigger: .automatic))
        XCTAssertTrue(parking.isDue(now: t0.addingTimeInterval(3_600), trigger: .automatic))
    }

    func testAManualRetryAlwaysRuns() {
        var parking = UploadParking(httpStatus: 413, at: t0)
        for _ in 0..<5 { parking = parking.refusedAgain(httpStatus: 413, at: t0) }
        XCTAssertFalse(parking.isDue(now: t0.addingTimeInterval(1), trigger: .automatic))
        XCTAssertTrue(parking.isDue(now: t0.addingTimeInterval(1), trigger: .manual))
    }

    func testQuotaIsRetriedOnEveryLaunchButOtherRefusalsAreNot() {
        let quota = UploadParking(httpStatus: 402, at: t0)
        let refused = UploadParking(httpStatus: 413, at: t0)
        let soon = t0.addingTimeInterval(60)

        XCTAssertEqual(quota.reason, .quota)
        XCTAssertTrue(quota.isDue(now: soon, trigger: .launch))
        XCTAssertFalse(quota.isDue(now: soon, trigger: .automatic))

        XCTAssertEqual(refused.reason, .refused)
        XCTAssertFalse(refused.isDue(now: soon, trigger: .launch))
    }

    func testReasonFollowsTheLatestRefusal() {
        let parking = UploadParking(httpStatus: 402, at: t0).refusedAgain(httpStatus: 400, at: t0)
        XCTAssertEqual(parking.reason, .refused)
        XCTAssertEqual(parking.httpStatus, 400)
    }

    func testRoundTripsThroughTheManifest() throws {
        let parking = UploadParking(httpStatus: 402, at: t0).refusedAgain(
            httpStatus: 402, at: t0.addingTimeInterval(10))
        let decoded = try JSONDecoder().decode(
            UploadParking.self, from: JSONEncoder().encode(parking))
        XCTAssertEqual(decoded, parking)
    }

    // MARK: upload timeout

    func testUploadTimeoutGrowsWithTheBodyAndIsBounded() {
        XCTAssertEqual(AudioUploadTimeout.forBody(bytes: 0), AudioUploadTimeout.floor)
        XCTAssertGreaterThan(AudioUploadTimeout.forBody(bytes: 0), 60)

        // An hour of 24 kbit/s Opus is ~10.8 MB.
        let hour = AudioUploadTimeout.forBody(bytes: 10_800_000)
        XCTAssertGreaterThan(hour, 1_000)
        XCTAssertLessThanOrEqual(hour, AudioUploadTimeout.ceiling)

        XCTAssertEqual(AudioUploadTimeout.forBody(bytes: 500_000_000), AudioUploadTimeout.ceiling)
        XCTAssertEqual(AudioUploadTimeout.forBody(bytes: -1), AudioUploadTimeout.floor)
    }
}
