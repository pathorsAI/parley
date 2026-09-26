import Foundation
import XCTest

@testable import ParleyKit

/// A clock the test moves by hand.
private final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = Date(timeIntervalSince1970: 1_000_000)
    var now: Date { lock.withLock { current } }
    func advance(_ seconds: TimeInterval) { lock.withLock { current += seconds } }
}

final class GuidedLapTests: XCTestCase {

    private func state(
        recorded: Bool = true, filed: Bool = false, replayed: Bool = false,
        shared: Bool = false, dismissed: Bool = false
    ) -> GettingStartedState {
        GettingStartedState(
            recorded: recorded, filed: filed, replayed: replayed, sharedToAI: shared,
            dismissedAt: dismissed ? Date(timeIntervalSince1970: 0) : nil)
    }

    func testStepIsTheFirstUndoneOfFileReplayShare() {
        XCTAssertEqual(GuidedLap.step(for: state()), .file)
        XCTAssertEqual(GuidedLap.step(for: state(filed: true)), .replay)
        XCTAssertEqual(GuidedLap.step(for: state(filed: true, replayed: true)), .share)
        // Order is fixed: a replay done early does not skip the filing step.
        XCTAssertEqual(GuidedLap.step(for: state(replayed: true)), .file)
        XCTAssertEqual(GuidedLap.step(for: state(filed: true, replayed: true, shared: true)), .done)
    }

    func testADoneStepIsHeldForOneAndAHalfSecondsThenTheNextShows() {
        let clock = TestClock()
        var lap = GuidedLap(state: state(), now: { clock.now })
        XCTAssertEqual(lap.display, .step(.file))
        XCTAssertNil(lap.holdEndsAt)

        lap.observe(state(filed: true))
        XCTAssertEqual(lap.display, .confirmed(.file))
        XCTAssertEqual(lap.holdEndsAt, clock.now.addingTimeInterval(1.5))

        clock.advance(1.4)
        XCTAssertEqual(lap.display, .confirmed(.file))
        clock.advance(0.2)
        XCTAssertEqual(lap.display, .step(.replay))
        XCTAssertNil(lap.holdEndsAt)
    }

    func testTheSameStateTwiceDoesNotRestartTheHold() {
        let clock = TestClock()
        var lap = GuidedLap(state: state(), now: { clock.now })
        lap.observe(state(filed: true))
        clock.advance(1.0)
        lap.observe(state(filed: true))
        clock.advance(0.6)
        XCTAssertEqual(lap.display, .step(.replay))
    }

    func testTwoStepsAtOnceConfirmTheOneThatWasUp() {
        let clock = TestClock()
        var lap = GuidedLap(state: state(filed: true), now: { clock.now })
        lap.observe(state(filed: true, replayed: true, shared: true))
        XCTAssertEqual(lap.display, .confirmed(.replay))
        clock.advance(2)
        XCTAssertEqual(lap.display, .step(.done))
    }

    func testAResetGoesBackWithoutAConfirmation() {
        let clock = TestClock()
        var lap = GuidedLap(state: state(filed: true, replayed: true), now: { clock.now })
        lap.observe(state(recorded: false))
        XCTAssertEqual(lap.display, .step(.file))
    }

    func testVisibility() {
        let lap = GuidedLap(state: state())
        XCTAssertTrue(lap.isVisible(state: state(), isLapRecording: true))
        XCTAssertFalse(lap.isVisible(state: state(), isLapRecording: false), "not on the fortieth recording")
        XCTAssertFalse(lap.isVisible(state: state(dismissed: true), isLapRecording: true), "No thanks")
    }

    func testTheFinishShowsOnlyWhenThisBarSawTheLapUnfinished() {
        let done = state(filed: true, replayed: true, shared: true)
        var watched = GuidedLap(state: state(filed: true, replayed: true))
        watched.observe(done)
        XCTAssertTrue(watched.isVisible(state: done, isLapRecording: true))
        watched.close()
        XCTAssertFalse(watched.isVisible(state: done, isLapRecording: true), "Close hides it")

        let later = GuidedLap(state: done)
        XCTAssertFalse(later.isVisible(state: done, isLapRecording: true), "a finished lap stays finished")
    }
}
