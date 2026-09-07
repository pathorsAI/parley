import XCTest

@testable import ParleyKit

/// The app's presence heartbeat and the session-liveness rule built on it. What
/// a phone would add is whether iOS delivers the Darwin notes on time; what can
/// be settled here is that the keyboard draws the right conclusion from the
/// stamps it finds.
final class AppPresenceTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    private func roundTrip<T: Codable>(_ value: T) throws -> T {
        try JSONDecoder().decode(T.self, from: try JSONEncoder().encode(value))
    }

    // MARK: presence

    func testPresenceRoundTrips() throws {
        let value = AppPresence(awake: true, servesInPlace: true, updatedAt: t0)
        XCTAssertEqual(try roundTrip(value), value)
    }

    func testAFreshStampIsAwake() {
        let presence = AppPresence(awake: true, servesInPlace: false, updatedAt: t0)
        XCTAssertTrue(presence.isAwake(at: t0))
        XCTAssertTrue(presence.isAwake(at: t0.addingTimeInterval(AppPresence.heartbeat)))
        XCTAssertFalse(presence.isAwake(at: t0.addingTimeInterval(AppPresence.staleAfter)))
    }

    func testStalenessToleratesTwoMissedHeartbeats() {
        // A busy app must never read as a dead one.
        XCTAssertGreaterThan(AppPresence.staleAfter, AppPresence.heartbeat * 2)
    }

    func testGoneIsNotAwakeHoweverFreshTheStamp() {
        var gone = AppPresence.gone
        gone.updatedAt = t0
        XCTAssertFalse(gone.isAwake(at: t0))
        XCTAssertFalse(gone.canServeInPlace(at: t0))
    }

    func testAFileWithoutAStampIsNotAwake() {
        XCTAssertFalse(AppPresence(awake: true, servesInPlace: true).isAwake(at: t0))
    }

    func testServingInPlaceNeedsBothTheClaimAndAFreshStamp() {
        let serving = AppPresence(awake: true, servesInPlace: true, updatedAt: t0)
        XCTAssertTrue(serving.canServeInPlace(at: t0))
        XCTAssertFalse(serving.canServeInPlace(at: t0.addingTimeInterval(AppPresence.staleAfter)))
        let awakeOnly = AppPresence(awake: true, servesInPlace: false, updatedAt: t0)
        XCTAssertFalse(awakeOnly.canServeInPlace(at: t0))
    }

    // MARK: session liveness

    private func downlink(
        _ state: DictationChannel.Downlink.State, stampedAt: Date?
    ) -> DictationChannel.Downlink {
        DictationChannel.Downlink(session: "s", state: state, updatedAt: stampedAt)
    }

    func testOnlyLiveStatesCanLookDead() {
        let longAgo = t0.addingTimeInterval(-3600)
        for state in DictationChannel.Downlink.State.allCases {
            let d = downlink(state, stampedAt: longAgo)
            XCTAssertEqual(d.looksDead(presence: nil, at: t0), state.isLive, "\(state)")
        }
    }

    func testTheLiveStatesAreTheFourThatClaimAProcess() {
        let live = DictationChannel.Downlink.State.allCases.filter(\.isLive)
        XCTAssertEqual(Set(live), [.starting, .listening, .reconnecting, .finishing])
    }

    func testAFreshDownlinkIsAliveWithoutAnyPresence() {
        let d = downlink(.listening, stampedAt: t0)
        XCTAssertFalse(d.looksDead(presence: nil, at: t0.addingTimeInterval(10)))
        XCTAssertTrue(d.looksDead(presence: nil, at: t0.addingTimeInterval(AppPresence.staleAfter)))
    }

    func testAPausedSpeakerIsKeptAliveByTheHeartbeat() {
        // The transcript stopped moving half a minute ago; the app is still
        // stamping. That is a user thinking, not a dead app.
        let d = downlink(.listening, stampedAt: t0)
        let now = t0.addingTimeInterval(40)
        let presence = AppPresence(awake: true, servesInPlace: false, updatedAt: now.addingTimeInterval(-5))
        XCTAssertFalse(d.looksDead(presence: presence, at: now))
    }

    func testAStalePresenceDoesNotVouchForAnything() {
        let d = downlink(.listening, stampedAt: t0)
        let now = t0.addingTimeInterval(60)
        let stale = AppPresence(awake: true, servesInPlace: false, updatedAt: t0)
        XCTAssertTrue(d.looksDead(presence: stale, at: now))
    }

    func testAGoodbyeDoesNotVouchEitherHoweverFresh() {
        let d = downlink(.listening, stampedAt: t0)
        let now = t0.addingTimeInterval(30)
        var gone = AppPresence.gone
        gone.updatedAt = now
        XCTAssertTrue(d.looksDead(presence: gone, at: now))
    }

    func testTheDeadlineIsTheNewerStampPlusTheStalePeriod() {
        let d = downlink(.listening, stampedAt: t0)
        let later = t0.addingTimeInterval(12)
        let presence = AppPresence(awake: true, servesInPlace: false, updatedAt: later)
        XCTAssertEqual(
            d.presumedDeadAt(presence: presence), later.addingTimeInterval(AppPresence.staleAfter))
        XCTAssertEqual(d.presumedDeadAt(presence: nil), t0.addingTimeInterval(AppPresence.staleAfter))
        XCTAssertNil(downlink(.done, stampedAt: t0).presumedDeadAt(presence: presence))
    }

    func testAnUnstampedLiveDownlinkIsDeadUnlessPresenceVouches() {
        // Written by a build before the stamp existed. Nothing says when, so
        // only a live heartbeat can keep it.
        let d = downlink(.listening, stampedAt: nil)
        XCTAssertTrue(d.looksDead(presence: nil, at: t0))
        let presence = AppPresence(awake: true, servesInPlace: false, updatedAt: t0)
        XCTAssertFalse(d.looksDead(presence: presence, at: t0))
    }
}
