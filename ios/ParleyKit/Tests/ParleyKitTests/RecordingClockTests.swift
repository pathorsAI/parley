import XCTest

@testable import ParleyKit

final class RecordingClockTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)

    private func at(_ seconds: TimeInterval) -> Date { t0.addingTimeInterval(seconds) }

    func testCountsWallTimeWhileRunning() {
        let clock = RecordingClock(startedAt: t0)
        XCTAssertEqual(clock.elapsed(at: at(90)), 90)
        XCTAssertEqual(clock.timerAnchor, t0)
    }

    func testPausedTimeIsNotCounted() {
        var clock = RecordingClock(startedAt: t0)
        clock.pause(at: at(60))
        XCTAssertEqual(clock.elapsed(at: at(60)), 60)
        XCTAssertEqual(clock.elapsed(at: at(3_600)), 60, "an hour paused adds nothing")
        XCTAssertNil(clock.timerAnchor)
        XCTAssertTrue(clock.isPaused)

        clock.resume(at: at(600))
        XCTAssertEqual(clock.elapsed(at: at(630)), 90)
    }

    func testSeveralPausesAccumulate() {
        var clock = RecordingClock(startedAt: t0)
        clock.pause(at: at(10))
        clock.resume(at: at(100))
        clock.pause(at: at(120))
        clock.resume(at: at(500))
        XCTAssertEqual(clock.elapsed(at: at(530)), 60)
        XCTAssertEqual(clock.banked, 30)
    }

    func testTheAnchorMakesASystemTimerShowElapsed() {
        var clock = RecordingClock(startedAt: t0)
        clock.pause(at: at(45))
        clock.resume(at: at(1_000))
        let now = at(1_015)
        let anchor = try! XCTUnwrap(clock.timerAnchor)
        XCTAssertEqual(now.timeIntervalSince(anchor), 60)
        XCTAssertEqual(anchor, at(955))
    }

    func testRepeatedPauseAndResumeAreNoOps() {
        var clock = RecordingClock(startedAt: t0)
        clock.pause(at: at(20))
        clock.pause(at: at(80))
        XCTAssertEqual(clock.elapsed(at: at(90)), 20)

        clock.resume(at: at(100))
        clock.resume(at: at(150))
        XCTAssertEqual(clock.elapsed(at: at(160)), 80, "the second resume did not restart the run")
    }

    func testAClockThatStepsBackwardsNeverSubtracts() {
        var clock = RecordingClock(startedAt: t0)
        clock.pause(at: at(30))
        clock.resume(at: at(100))
        XCTAssertEqual(clock.elapsed(at: at(50)), 30)
        clock.pause(at: at(40))
        XCTAssertEqual(clock.elapsed(at: at(200)), 30)
    }

    func testTimerTextMatchesTheSystemTimerStyle() {
        XCTAssertEqual(RecordingClock.timerText(0), "0:00")
        XCTAssertEqual(RecordingClock.timerText(7.9), "0:07")
        XCTAssertEqual(RecordingClock.timerText(754), "12:34")
        XCTAssertEqual(RecordingClock.timerText(3_723), "1:02:03")
        XCTAssertEqual(RecordingClock.timerText(-5), "0:00")
    }
}
