import XCTest

@testable import ParleyKit

/// The microphone window's state machine — the part of the feature that can be
/// reasoned about without a phone. What it cannot prove is that iOS keeps the
/// process resident for the window's length; that is on the device checklist.
final class MicWindowTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    // MARK: lengths

    func testOffHasNoDuration() {
        XCTAssertNil(MicWindowLength.off.seconds)
        XCTAssertNil(MicWindowState.opened(length: .off, at: t0))
    }

    func testEveryOtherLengthIsBounded() {
        // The point of the enum: there is no unbounded case. If one is ever
        // added, this test is the place that argues about it.
        for length in MicWindowLength.allCases where length != .off {
            guard let seconds = length.seconds else {
                return XCTFail("\(length) has no duration")
            }
            XCTAssertGreaterThan(seconds, 0)
            XCTAssertLessThanOrEqual(seconds, 3600)
        }
    }

    // MARK: open / expiry

    func testAWindowIsOpenUntilItExpires() {
        guard let window = MicWindowState.opened(length: .fiveMinutes, at: t0) else {
            return XCTFail("no window")
        }
        XCTAssertTrue(window.isOpen(at: t0))
        XCTAssertTrue(window.isOpen(at: t0.addingTimeInterval(10)))
        XCTAssertEqual(window.remaining(at: t0.addingTimeInterval(60)), 240)
    }

    func testAnExpiredWindowIsClosedEvenWithAFreshStamp() {
        // Expiry wins over the heartbeat: a process that is alive and stamping
        // must still stop claiming a window whose time is up.
        let expired = MicWindowState(
            length: .fiveMinutes, openedAt: t0, expiresAt: t0.addingTimeInterval(300),
            updatedAt: t0.addingTimeInterval(301))
        XCTAssertFalse(expired.isOpen(at: t0.addingTimeInterval(301)))
        XCTAssertEqual(expired.remaining(at: t0.addingTimeInterval(400)), 0)
    }

    func testAStaleStampClosesTheWindowLongBeforeItExpires() {
        // The jetsam case: the file says "open for another 50 minutes" and the
        // process that wrote it is gone. Believing the expiry alone would show
        // a ready microphone that does not exist.
        guard let window = MicWindowState.opened(length: .oneHour, at: t0) else {
            return XCTFail("no window")
        }
        let afterOneHeartbeat = t0.addingTimeInterval(MicWindowState.heartbeat)
        XCTAssertTrue(window.isOpen(at: afterOneHeartbeat))
        XCTAssertFalse(window.isOpen(at: t0.addingTimeInterval(MicWindowState.staleAfter)))
    }

    func testStalenessToleratesTwoMissedHeartbeats() {
        // A busy app must not read as a dead one.
        XCTAssertGreaterThan(MicWindowState.staleAfter, MicWindowState.heartbeat * 2)
    }

    func testAClosedWindowRemembersTheSetting() {
        let closed = MicWindowState.closed(length: .fifteenMinutes)
        XCTAssertFalse(closed.isOpen(at: t0))
        // Which is what lets the keyboard say "this tap opens Parley" instead
        // of saying nothing at all.
        XCTAssertEqual(closed.length, .fifteenMinutes)
    }

    func testAFileWrittenBeforeTheStampExistedReadsAsClosed() {
        let unstamped = MicWindowState(
            length: .oneHour, openedAt: t0, expiresAt: t0.addingTimeInterval(3600),
            updatedAt: nil)
        XCTAssertFalse(unstamped.isOpen(at: t0))
    }

    // MARK: ending early

    func testACloseRequestAppliesToTheWindowThatWasOpen() {
        guard let window = MicWindowState.opened(length: .fiveMinutes, at: t0) else {
            return XCTFail("no window")
        }
        XCTAssertTrue(window.closeApplies(requestedAt: t0.addingTimeInterval(30)))
        XCTAssertTrue(window.closeApplies(requestedAt: t0))
    }

    func testACloseRequestFromBeforeTheWindowIsIgnored() {
        // The control file is never cleared by either side, so yesterday's
        // "end now" is still sitting there. It must not refuse to let a new
        // window open — a stale request is a request about a window that is
        // already over.
        guard let window = MicWindowState.opened(length: .fiveMinutes, at: t0) else {
            return XCTFail("no window")
        }
        XCTAssertFalse(window.closeApplies(requestedAt: t0.addingTimeInterval(-1)))
    }

    func testNoWindowMeansNothingToClose() {
        XCTAssertFalse(MicWindowState.closed(length: .oneHour).closeApplies(requestedAt: t0))
        XCTAssertFalse(MicWindowState.closed(length: .oneHour).closeApplies(requestedAt: nil))
    }

    // MARK: wire format

    func testStateSurvivesTheAppGroupRoundTrip() throws {
        guard let window = MicWindowState.opened(length: .fifteenMinutes, at: t0) else {
            return XCTFail("no window")
        }
        let data = try JSONEncoder().encode(window)
        let back = try JSONDecoder().decode(MicWindowState.self, from: data)
        XCTAssertEqual(back, window)
        XCTAssertTrue(back.isOpen(at: t0))
    }

    func testAnUnknownLengthDoesNotDecode() throws {
        // Both processes ship together, so a length one side has never heard of
        // means a mismatched install. Failing to decode leaves the reader with
        // nil — no window — which is the safe reading.
        let json = Data(#"{"length":"twoDays"}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(MicWindowState.self, from: json))
    }

    func testControlSurvivesTheAppGroupRoundTrip() throws {
        let control = MicWindowControl(closeRequestedAt: t0)
        let back = try JSONDecoder().decode(
            MicWindowControl.self, from: JSONEncoder().encode(control))
        XCTAssertEqual(back, control)
    }
}
