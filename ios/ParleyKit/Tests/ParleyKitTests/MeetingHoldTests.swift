import XCTest

@testable import ParleyKit

/// A phone call during a meeting, without the phone call.
final class MeetingHoldTests: XCTestCase {

    // MARK: the reported bug

    /// A call long enough to outlast the capture's recovery ladder. The capture
    /// gives up (`.lost(.takenBySystem)`) while the call is still going — and
    /// the meeting used to end right there. Now it waits, and the `.ended` the
    /// hang-up posts brings the recording back.
    func testACallLongerThanTheLadderPausesTheMeetingInsteadOfEndingIt() {
        var capture = CaptureRecovery()
        var meeting = MeetingHold()

        // `.began`: the capture reports `.interrupted`.
        _ = capture.apply(.interrupted)
        XCTAssertEqual(
            meeting.apply(.micTaken), .init(clock: .pause, relay: .suspend))

        // Every probe is refused for as long as the call lasts.
        while case .rebuild = capture.apply(.refusedWhileHeld) {}
        XCTAssertTrue(capture.hasGivenUp)

        // The capture's give-up is the same hold, not an end.
        let lost = meeting.apply(.micTaken)
        XCTAssertEqual(lost, .none)
        XCTAssertFalse(lost.endMeeting)
        XCTAssertFalse(meeting.isCapturing)

        // Hang up: `.ended`, from `.lost`, still rebuilds.
        XCTAssertEqual(
            capture.apply(.interruptionEnded),
            .rebuild(afterMilliseconds: capture.resumeAfterMilliseconds))
        _ = capture.apply(.rebuildSucceeded)
        XCTAssertTrue(capture.holdsMicrophone)

        XCTAssertEqual(
            meeting.apply(.micBack), .init(clock: .resume, relay: .reconnect))
        XCTAssertTrue(meeting.isCapturing)
    }

    /// No `.ended` at all — a long call, or the person switched apps during
    /// it. Coming back to Parley is what resumes the meeting.
    func testAnInterruptionWithNoEndResumesWhenTheAppComesForward() {
        var capture = CaptureRecovery()
        var meeting = MeetingHold()

        _ = capture.apply(.interrupted)
        _ = meeting.apply(.micTaken)
        while case .rebuild = capture.apply(.refusedWhileHeld) {}
        _ = meeting.apply(.micTaken)

        XCTAssertEqual(capture.apply(.appBecameActive), .rebuild(afterMilliseconds: 0))
        _ = capture.apply(.rebuildSucceeded)
        XCTAssertEqual(
            meeting.apply(.micBack), .init(clock: .resume, relay: .reconnect))
    }

    /// A short interruption — Siri for two seconds — resumes before the ladder
    /// ever gives up. Same effects, in the same order.
    func testAShortInterruptionPausesAndResumesOnce() {
        var meeting = MeetingHold()
        XCTAssertEqual(meeting.apply(.micTaken), .init(clock: .pause, relay: .suspend))
        XCTAssertEqual(meeting.apply(.micBack), .init(clock: .resume, relay: .reconnect))
        // A quiet rebuild after that (a route change) is not a second resume.
        XCTAssertEqual(meeting.apply(.micBack), .none)
    }

    // MARK: Stop during the call

    /// The person gives up waiting and taps Stop mid-call. The meeting ends the
    /// ordinary way; the hold leaves nothing behind for the next one.
    func testStoppingDuringAnInterruptionClearsTheHold() {
        var meeting = MeetingHold()
        _ = meeting.apply(.micTaken)
        XCTAssertEqual(meeting.apply(.stopped), .none)
        XCTAssertFalse(meeting.systemHeld)
        XCTAssertFalse(meeting.userPaused)
        XCTAssertTrue(meeting.isCapturing)
        // A late `.resumed` from the capture being torn down is harmless.
        XCTAssertEqual(meeting.apply(.micBack), .none)
    }

    // MARK: the person's pause and the system's

    /// A call during a pause: the clock is already stopped, and the call
    /// ending must not start it — only Resume does.
    func testACallDuringAPauseLeavesTheMeetingPaused() {
        var meeting = MeetingHold()
        XCTAssertEqual(meeting.apply(.userPaused), .init(clock: .pause))
        XCTAssertEqual(meeting.apply(.micTaken), .init(relay: .suspend))
        XCTAssertEqual(meeting.apply(.micBack), .init(relay: .reconnect))
        XCTAssertFalse(meeting.isCapturing)
        XCTAssertEqual(meeting.apply(.userResumed), .init(clock: .resume))
    }

    /// Resume pressed mid-call: the person's pause is over, but the clock stays
    /// stopped until the microphone is back.
    func testResumingDuringACallWaitsForTheMicrophone() {
        var meeting = MeetingHold()
        _ = meeting.apply(.userPaused)
        _ = meeting.apply(.micTaken)
        XCTAssertEqual(meeting.apply(.userResumed), .none)
        XCTAssertEqual(meeting.apply(.micBack), .init(clock: .resume, relay: .reconnect))
    }

    // MARK: the one loss that still ends the meeting

    func testABrokenAudioStackEndsTheMeeting() {
        var meeting = MeetingHold()
        XCTAssertTrue(meeting.apply(.micBroken).endMeeting)
    }
}

private extension CaptureRecovery.Event {
    /// What `setActive(true)` says while the phone app holds the input.
    static let refusedWhileHeld = CaptureRecovery.Event.rebuildFailed(
        systemHoldsInput: true, description: "!int")
}
