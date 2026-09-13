import Foundation
import XCTest

@testable import ParleyKit

/// The App Group mailboxes' wire format. The container itself needs two signed
/// processes and a phone, so what is testable here is the encoding — which is
/// exactly where a change breaks the other side of the channel silently, since
/// a mailbox that fails to decode reads as "nothing there".
final class DictationChannelTests: XCTestCase {
    private func roundTrip<T: Codable>(_ value: T) throws -> T {
        try JSONDecoder().decode(T.self, from: try JSONEncoder().encode(value))
    }

    // MARK: readiness

    func testReadinessRoundTrips() throws {
        let stamped = Date(timeIntervalSince1970: 1_700_000_000)
        let value = DictationChannel.KeyboardReadiness(
            signedIn: true, micGranted: true, updatedAt: stamped)
        let back = try roundTrip(value)
        XCTAssertEqual(back, value)
        XCTAssertTrue(back.canDictate)
        XCTAssertEqual(back.updatedAt, stamped)
    }

    func testReadinessNeedsBothHalves() {
        XCTAssertFalse(
            DictationChannel.KeyboardReadiness(signedIn: true, micGranted: false).canDictate)
        XCTAssertFalse(
            DictationChannel.KeyboardReadiness(signedIn: false, micGranted: true).canDictate)
        XCTAssertFalse(DictationChannel.KeyboardReadiness().canDictate)
    }

    func testReadinessDecodesWithoutAStamp() throws {
        // `updatedAt` is optional so a file written by an older build still
        // decodes. It is diagnostic only — unlike the microphone window, these
        // facts outlive the process that wrote them, so nothing reads the stamp
        // to decide whether to believe the rest.
        let json = Data(#"{"signedIn":true,"micGranted":true}"#.utf8)
        let value = try JSONDecoder().decode(DictationChannel.KeyboardReadiness.self, from: json)
        XCTAssertNil(value.updatedAt)
        XCTAssertTrue(value.canDictate)
    }

    // MARK: session mailboxes

    func testDownlinkRoundTripsEveryState() throws {
        for state in DictationChannel.Downlink.State.allCases {
            let back = try roundTrip(
                DictationChannel.Downlink(
                    session: "s", committed: "hello ", partial: "world", state: state))
            XCTAssertEqual(back.state, state)
            XCTAssertEqual(back.committed, "hello ")
            XCTAssertEqual(back.partial, "world")
        }
    }

    func testCancelledIsItsOwnEnding() throws {
        // The keyboard inserts on `done` and only on `done`. If a discarded
        // session ever encoded as anything the other side reads as `done`, the
        // words the user threw away would land in their document — so this is
        // the one state whose raw value is worth pinning down.
        XCTAssertEqual(DictationChannel.Downlink.State.cancelled.rawValue, "cancelled")
        XCTAssertNotEqual(DictationChannel.Downlink.State.cancelled, .done)
        XCTAssertNotEqual(DictationChannel.Downlink.State.cancelled, .error)
    }

    func testMicTakenIsNeitherAnEndingNorSomethingToWaitOn() throws {
        let taken = DictationChannel.Downlink.State.micTaken

        // Pinned like `cancelled`, and for a neighbouring reason: nothing may be
        // inserted from this state, so it must never be read as `done`. It is
        // also not `error` — the pane shows no red copy for the user having used
        // their own phone's dictation.
        XCTAssertEqual(taken.rawValue, "micTaken")
        XCTAssertNotEqual(taken, .done)
        XCTAssertNotEqual(taken, .error)

        // Not live: the question `isLive` answers is "should a reader keep
        // waiting on this", and while the microphone is gone the answer is no
        // whatever the app is doing about it. A live `micTaken` would leave the
        // keyboard drawing ⏹ over a microphone nobody has — which is the bug —
        // and would hand it to the liveness watchdog, which would cancel a
        // session the app may still resume.
        XCTAssertFalse(taken.isLive)
        let down = DictationChannel.Downlink(session: "s", state: taken, updatedAt: .distantPast)
        XCTAssertNil(down.presumedDeadAt(presence: nil))
        XCTAssertFalse(down.looksDead(presence: nil))
    }

    func testMicTakenKeepsTheWordsAlreadySpoken() throws {
        // The transcript rides along so the app can publish `listening` again for
        // the same session and have it carry on where it stopped — recovery is
        // the point, and a state that dropped the words could only start over.
        let back = try roundTrip(
            DictationChannel.Downlink(
                session: "s", committed: "the first half ", partial: "of a sen",
                state: .micTaken))
        XCTAssertEqual(back.state, .micTaken)
        XCTAssertEqual(back.committed, "the first half ")
        XCTAssertNil(back.errorMessage)
    }

    func testUplinkCarriesTheInsertionHighWaterMark() throws {
        let back = try roundTrip(
            DictationChannel.Uplink(
                session: "s", hostBundleID: "com.example.app", stopRequested: true,
                insertedCount: 42))
        XCTAssertEqual(back.insertedCount, 42)
        XCTAssertEqual(back.hostBundleID, "com.example.app")
        XCTAssertTrue(back.stopRequested)
        XCTAssertFalse(back.wantsCancel)
    }

    func testUplinkCarriesTheCancelAlongsideTheStop() throws {
        // ✕ is written as both flags: `stopRequested` is what makes it read as
        // "end this session" to the whole existing path, and `cancelRequested`
        // is the only thing that says the transcript is to be thrown away.
        let back = try roundTrip(
            DictationChannel.Uplink(session: "s", stopRequested: true, cancelRequested: true))
        XCTAssertTrue(back.stopRequested)
        XCTAssertTrue(back.wantsCancel)
    }

    func testUplinkFromAnOlderBuildStillDecodes() throws {
        // `cancelRequested` is optional for this reason and no other. A
        // mailbox that fails to decode reads as "nothing there", and the file
        // this parses is how the app hears ⏹ at all — an uplink left behind by
        // the build before this one must not silently swallow a stop.
        let json = Data(#"{"session":"s","stopRequested":true,"insertedCount":7}"#.utf8)
        let value = try JSONDecoder().decode(DictationChannel.Uplink.self, from: json)
        XCTAssertTrue(value.stopRequested)
        XCTAssertFalse(value.wantsCancel)
        XCTAssertEqual(value.insertedCount, 7)
    }

    // MARK: URLs

    func testStartURLRoundTripsTheSession() {
        let id = UUID().uuidString
        XCTAssertEqual(DictationChannel.session(fromStart: .init(string: "parley://x")!), nil)
        XCTAssertEqual(
            DictationChannel.session(fromStart: DictationChannel.startURL(session: id)), id)
    }

    func testAppURLAsksForNothing() {
        // The keyboard opens this when there is no session worth minting; it
        // must not look like a start request to the app's `onOpenURL`.
        XCTAssertNil(DictationChannel.session(fromStart: DictationChannel.appURL))
    }
}
