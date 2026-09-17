import XCTest

@testable import ParleyKit

/// The Live Activity's decisions — which of the three things the card shows,
/// and when there should be no card. All of it is reachable without ActivityKit
/// on purpose (see `MicActivityState`); what is not reachable here is whether
/// `activity.update()` lands on a backgrounded device, which is a device
/// question and is written up on `MicActivityPolicy.staleAfter`.
final class MicActivityStateTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    private func window(_ length: MicWindowLength = .fifteenMinutes) -> MicWindowState {
        guard let open = MicWindowState.opened(length: length, at: t0) else {
            fatalError("\(length) has no window")
        }
        return open
    }

    // MARK: precedence

    func testAMeetingOutranksASimultaneousDictation() {
        // Not a hypothetical: `MeetingRecorder.start` takes the microphone by
        // calling `DictationCoordinator.yieldMicrophone`, so for as long as that
        // teardown takes, both inputs are non-nil. The one that is real is the
        // meeting.
        let state = MicActivityState.derive(
            meetingStartedAt: t0, meetingTitle: "Weekly",
            dictationStartedAt: t0.addingTimeInterval(-5),
            window: window(), trouble: false, at: t0)
        XCTAssertEqual(state?.mode, .meeting)
        XCTAssertEqual(state?.since, t0)
        XCTAssertEqual(state?.title, "Weekly")
    }

    func testADictationOutranksAnOpenWindow() {
        // The window is the microphone nobody is using; a dictation is somebody
        // using it.
        let state = MicActivityState.derive(
            meetingStartedAt: nil, meetingTitle: nil,
            dictationStartedAt: t0.addingTimeInterval(3),
            window: window(), trouble: false, at: t0.addingTimeInterval(3))
        XCTAssertEqual(state?.mode, .dictation)
        XCTAssertEqual(state?.since, t0.addingTimeInterval(3))
        // The title is the meeting's name and nothing else's.
        XCTAssertNil(state?.title)
    }

    func testAnOpenWindowAloneIsStandby() {
        let state = MicActivityState.derive(
            meetingStartedAt: nil, meetingTitle: nil, dictationStartedAt: nil,
            window: window(), trouble: false, at: t0.addingTimeInterval(10))
        XCTAssertEqual(state?.mode, .standby)
        XCTAssertEqual(state?.since, t0)
    }

    func testNothingRunningMeansNoCardAtAll() {
        XCTAssertNil(
            MicActivityState.derive(
                meetingStartedAt: nil, meetingTitle: nil, dictationStartedAt: nil,
                window: nil, trouble: false, at: t0))
        XCTAssertNil(
            MicActivityState.derive(
                meetingStartedAt: nil, meetingTitle: nil, dictationStartedAt: nil,
                window: .closed(length: .oneHour), trouble: false, at: t0))
    }

    func testAMeetingWithNoNameSendsNoTitleRatherThanAFallback() {
        // The widget is the only side that knows the reader's language, so an
        // English default written here would be the one string the app cannot
        // localize.
        let state = MicActivityState.derive(
            meetingStartedAt: t0, meetingTitle: nil, dictationStartedAt: nil,
            window: nil, trouble: false, at: t0)
        XCTAssertEqual(state?.mode, .meeting)
        XCTAssertNil(state?.title)
    }

    // MARK: staleness

    func testAStaleWindowDoesNotPutAStandbyCardOnTheLockScreen() {
        // The jetsam case, carried over from `MicWindowState`: the file still
        // says "open for another 14 minutes" and the process that wrote it is
        // gone. A card here would be a microphone claim nobody is backing.
        let state = MicActivityState.derive(
            meetingStartedAt: nil, meetingTitle: nil, dictationStartedAt: nil,
            window: window(),
            trouble: false,
            at: t0.addingTimeInterval(MicWindowState.staleAfter))
        XCTAssertNil(state)
    }

    func testAnExpiredWindowDoesNotPutAStandbyCardOnTheLockScreen() {
        let state = MicActivityState.derive(
            meetingStartedAt: nil, meetingTitle: nil, dictationStartedAt: nil,
            window: MicWindowState(
                length: .fiveMinutes, openedAt: t0, expiresAt: t0.addingTimeInterval(300),
                updatedAt: t0.addingTimeInterval(299)),
            trouble: false, at: t0.addingTimeInterval(300))
        XCTAssertNil(state)
    }

    // MARK: countdown

    func testOnlyStandbyCountsDown() {
        let standby = MicActivityState.derive(
            meetingStartedAt: nil, meetingTitle: nil, dictationStartedAt: nil,
            window: window(.fifteenMinutes), trouble: false, at: t0)
        XCTAssertEqual(standby?.until, t0.addingTimeInterval(15 * 60))

        // The other two run until the user stops them, and a countdown on them
        // would be a deadline Parley has not got.
        let meeting = MicActivityState.derive(
            meetingStartedAt: t0, meetingTitle: nil, dictationStartedAt: nil,
            window: window(), trouble: false, at: t0)
        XCTAssertNil(meeting?.until)
        let dictation = MicActivityState.derive(
            meetingStartedAt: nil, meetingTitle: nil, dictationStartedAt: t0,
            window: window(), trouble: false, at: t0)
        XCTAssertNil(dictation?.until)
    }

    // MARK: trouble

    func testTroubleReachesEveryMode() {
        // The honesty rule is not mode-specific: whichever card is up has to be
        // able to stop claiming to be listening.
        let inputs: [(Date?, Date?, MicWindowState?)] = [
            (t0, nil, nil), (nil, t0, nil), (nil, nil, window()),
        ]
        for (meeting, dictation, window) in inputs {
            let state = MicActivityState.derive(
                meetingStartedAt: meeting, meetingTitle: nil, dictationStartedAt: dictation,
                window: window, trouble: true, at: t0)
            XCTAssertEqual(state?.trouble, true)
        }
    }

    func testTroubleDoesNotConjureACard() {
        // Nothing is running, so there is nothing to be honest *about*. A card
        // that only ever said "something went wrong" would be the app reporting
        // on a microphone it does not hold.
        XCTAssertNil(
            MicActivityState.derive(
                meetingStartedAt: nil, meetingTitle: nil, dictationStartedAt: nil,
                window: nil, trouble: true, at: t0))
    }

    // MARK: wire format

    func testStateSurvivesTheCrossingIntoTheWidget() throws {
        // ActivityKit encodes this to hand it to another process, so a change
        // here breaks the card silently rather than at the call site.
        for mode in MicActivityState.Mode.allCases {
            let value = MicActivityState(
                mode: mode, since: t0, until: t0.addingTimeInterval(900),
                title: "季度檢討", trouble: true)
            let back = try JSONDecoder().decode(
                MicActivityState.self, from: JSONEncoder().encode(value))
            XCTAssertEqual(back, value)
        }
    }

    func testAModeTheOtherSideHasNeverHeardOfDoesNotDecode() throws {
        // The app and the widget ship together, so an unknown mode means a
        // mismatched install. Failing to decode leaves ActivityKit with
        // nothing, which beats a card drawn from a mode it cannot draw.
        let json = Data(#"{"mode":"podcast","since":0,"trouble":false}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(MicActivityState.self, from: json))
    }

    // MARK: policy

    func testTheStaleHorizonIsAheadOfTheUpdateThatSetsIt() {
        guard let staleAfter = MicActivityPolicy.staleAfter else {
            // The device spike came back negative and the card now makes no
            // stale claim at all — see `MicActivityPolicy.staleAfter`. Then
            // there is no horizon to check, and the clocks are the system's.
            return XCTAssertNil(MicActivityPolicy.staleDate(at: t0))
        }
        XCTAssertGreaterThan(staleAfter, 0)
        XCTAssertEqual(MicActivityPolicy.staleDate(at: t0), t0.addingTimeInterval(staleAfter))
    }

    func testTheSystemLimitIsEightHours() {
        // Not ours to choose; ActivityKit dismisses the card at eight hours
        // whatever we do, and the app has to stop trying to update one that is
        // no longer there.
        XCTAssertFalse(
            MicActivityPolicy.outlivesSystemLimit(
                since: t0, at: t0.addingTimeInterval(8 * 3600 - 1)))
        XCTAssertTrue(
            MicActivityPolicy.outlivesSystemLimit(since: t0, at: t0.addingTimeInterval(8 * 3600)))
        XCTAssertTrue(
            MicActivityPolicy.outlivesSystemLimit(since: t0, at: t0.addingTimeInterval(9 * 3600)))
    }
}
