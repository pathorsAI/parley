import XCTest

@testable import ParleyKit

final class RelayLivenessTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    func testThreeMissedPingsIsTheLine() {
        let policy = RelayLiveness.standard

        XCTAssertFalse(policy.isDead(now: t0, lastProof: t0))
        XCTAssertFalse(policy.isDead(now: t0.addingTimeInterval(5), lastProof: t0))
        XCTAssertFalse(policy.isDead(now: t0.addingTimeInterval(14), lastProof: t0))
        XCTAssertTrue(policy.isDead(now: t0.addingTimeInterval(15), lastProof: t0))
    }

    /// The regression this type exists for, from the other side: a room where
    /// nobody is talking produces no transcript traffic, and must not be
    /// mistaken for a socket that has gone away. Pongs keep the clock honest.
    func testATwoMinuteSilenceWithPongsIsNotADeadSocket() {
        let policy = RelayLiveness.standard
        // A pong every 5 s for two minutes: the last one lands at t+120.
        let lastProof = t0.addingTimeInterval(120)

        XCTAssertFalse(policy.isDead(now: t0.addingTimeInterval(120), lastProof: lastProof))
        XCTAssertFalse(policy.isDead(now: t0.addingTimeInterval(124), lastProof: lastProof))
    }

    func testASocketThatStopsAnsweringDies() {
        let policy = RelayLiveness.standard
        // Last pong at t+30, then nothing.
        let lastProof = t0.addingTimeInterval(30)

        XCTAssertFalse(policy.isDead(now: t0.addingTimeInterval(40), lastProof: lastProof))
        XCTAssertTrue(policy.isDead(now: t0.addingTimeInterval(45), lastProof: lastProof))
        XCTAssertTrue(policy.isDead(now: t0.addingTimeInterval(600), lastProof: lastProof))
    }

    /// `Date` is wall time and can step backwards when the system clock syncs.
    /// A negative age must read as "just heard from", not wrap into a large
    /// positive one and cut a healthy session.
    func testAClockThatStepsBackwardsDoesNotKillTheSession() {
        let policy = RelayLiveness.standard

        XCTAssertFalse(policy.isDead(now: t0.addingTimeInterval(-3600), lastProof: t0))
        XCTAssertFalse(policy.isDead(now: t0.addingTimeInterval(-1), lastProof: t0))
    }

    func testCheckIntervalIsThePingCadence() {
        XCTAssertEqual(RelayLiveness.standard.checkInterval, .seconds(5))
    }

    /// A caller that polls on `checkInterval` has to get at least one look
    /// inside the deadline, or the deadline is decided by the poll instead.
    func testCheckIntervalNeverOutrunsTheDeadlineItDefends() {
        let lopsided = RelayLiveness(pingInterval: .seconds(30), deadline: .seconds(10))

        XCTAssertEqual(lopsided.checkInterval, .seconds(10))
    }

    func testThresholdsAreTunable() {
        let twitchy = RelayLiveness(pingInterval: .seconds(1), deadline: .seconds(3))

        XCTAssertTrue(twitchy.isDead(now: t0.addingTimeInterval(3), lastProof: t0))
        XCTAssertFalse(RelayLiveness.standard.isDead(now: t0.addingTimeInterval(3), lastProof: t0))
    }

    /// The deadline has to sit between two numbers set elsewhere: long enough
    /// that a reconnect the policy would have made anyway is not pre-empted,
    /// short enough that the silence fits in the bridge's hold window and the
    /// words spoken during it still reach the next leg.
    func testTheDeadlineSitsBetweenTheReconnectLadderAndTheHoldWindow() {
        let policy = RelayLiveness.standard
        let holdSeconds = Double(RelayAudioBridge.defaultHoldLimit.components.seconds)

        XCTAssertGreaterThan(
            policy.deadlineSeconds, Double(ReconnectPolicy().base.components.seconds))
        XCTAssertLessThan(policy.deadlineSeconds, holdSeconds)
    }
}
