import XCTest

@testable import ParleyKit

final class ReconnectPolicyTests: XCTestCase {
    func testBackoffDoublesFromTheBaseAndCaps() {
        let policy = ReconnectPolicy(maxAttempts: 8, base: .seconds(1), cap: .seconds(15))
        let ladder = (1...8).map { policy.delay(forAttempt: $0) }

        XCTAssertEqual(
            ladder,
            [
                .seconds(1), .seconds(2), .seconds(4), .seconds(8),
                .seconds(15), .seconds(15), .seconds(15), .seconds(15),
            ])
    }

    func testTotalWaitCoversAFlakyStretchWithoutHammering() {
        let policy = ReconnectPolicy()
        let total = (1...policy.maxAttempts)
            .map { policy.delay(forAttempt: $0).components.seconds }
            .reduce(0, +)

        // 1+2+4+8+15+15+15+15 — a minute and a quarter of trying, and never
        // more than four dials in the first ten seconds.
        XCTAssertEqual(total, 75)
        XCTAssertLessThanOrEqual(
            (1...3).map { policy.delay(forAttempt: $0).components.seconds }.reduce(0, +), 10)
    }

    func testGivesUpPastTheAttemptCeiling() {
        let policy = ReconnectPolicy(maxAttempts: 3)

        XCTAssertEqual(policy.decide(attempt: 1), .retry(after: .seconds(1)))
        XCTAssertEqual(policy.decide(attempt: 3), .retry(after: .seconds(4)))
        XCTAssertEqual(policy.decide(attempt: 4), .giveUp)
        XCTAssertEqual(policy.decide(attempt: 99), .giveUp)
    }

    func testDictationRedialsFasterAndGivesUpSooner() {
        let dictation = ReconnectPolicy.dictation
        let meeting = ReconnectPolicy()

        XCTAssertLessThan(dictation.delay(forAttempt: 1), meeting.delay(forAttempt: 1))
        XCTAssertLessThan(dictation.maxAttempts, meeting.maxAttempts)
        XCTAssertEqual(dictation.decide(attempt: dictation.maxAttempts + 1), .giveUp)
        // The whole ladder fits inside a dictation session's two-minute cap.
        let total = (1...dictation.maxAttempts)
            .map { dictation.delay(forAttempt: $0) }
            .reduce(Duration.zero, +)
        XCTAssertLessThan(total, .seconds(30))
    }

    func testAttemptZeroIsNeverAskedToWaitNegatively() {
        let policy = ReconnectPolicy()
        XCTAssertEqual(policy.delay(forAttempt: 0), policy.base)
        XCTAssertEqual(policy.decide(attempt: 0), .giveUp)
    }
}
