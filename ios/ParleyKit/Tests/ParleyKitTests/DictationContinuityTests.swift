import Foundation
import XCTest

@testable import ParleyKit

/// The decisions behind "the next dictation starts where I am, and a long one
/// keeps what I said": the keyboard's start handshake, which failures keep the
/// microphone, the cap's countdown, and the wire format that carries them.
final class DictationContinuityTests: XCTestCase {
    private typealias State = DictationChannel.Downlink.State

    // MARK: start handshake

    func testSilenceOpensTheAppAtTheFirstAckWindow() {
        let h = StartHandshake()
        XCTAssertEqual(h.decide(elapsed: 0), .wait)
        XCTAssertEqual(h.decide(elapsed: StartHandshake.firstAck - 0.01), .wait)
        // Nothing heard by the old 700 ms mark: the app is suspended or gone,
        // and only the URL can wake it. Unchanged from before.
        XCTAssertEqual(h.decide(elapsed: StartHandshake.firstAck), .openApp)
    }

    func testAnAppWithAMicrophoneIsAckedByItsFirstStarting() {
        // The borrowed-microphone path publishes an ordinary `starting` and then
        // spends the relay handshake before `listening`. That wait must never
        // be read as provisional — a slow network would otherwise throw the
        // user into Parley over a session that is already running.
        var h = StartHandshake()
        h.observe(.starting, openingMicrophone: false)
        XCTAssertEqual(h.decide(elapsed: 0.1), .acked)
        XCTAssertEqual(h.decide(elapsed: 60), .acked)
    }

    func testAProvisionalStartingBuysTheMicrophoneWait() {
        var h = StartHandshake()
        h.observe(.starting, openingMicrophone: true)
        XCTAssertEqual(h.heard, .provisional)
        // Past the old 700 ms mark: still waiting, which is the fix.
        XCTAssertEqual(h.decide(elapsed: 1.5), .wait)
        XCTAssertEqual(h.decide(elapsed: StartHandshake.microphoneWait - 0.01), .wait)
        // Still only provisional at the bound: fall back to the app as before.
        XCTAssertEqual(h.decide(elapsed: StartHandshake.microphoneWait), .openApp)
    }

    func testTheSessionItselfTurnsAProvisionalAnswerIntoAnAck() {
        for state in [State.starting, .listening, .reconnecting] {
            var h = StartHandshake()
            h.observe(.starting, openingMicrophone: true)
            h.observe(state, openingMicrophone: false)
            XCTAssertEqual(h.decide(elapsed: 2), .acked, "\(state)")
        }
    }

    func testARefusalOpensTheAppAtOnce() {
        var h = StartHandshake()
        h.observe(.starting, openingMicrophone: true)
        h.observe(.needsApp, openingMicrophone: false)
        XCTAssertEqual(h.decide(elapsed: 0.2), .openApp)
        // A refusal without the provisional step first (the two notes coalesced
        // before the keyboard read the file) means the same thing.
        var direct = StartHandshake()
        direct.observe(.needsApp, openingMicrophone: false)
        XCTAssertEqual(direct.decide(elapsed: 0.1), .openApp)
    }

    func testAnErrorIsAnAnswerNotARefusal() {
        // The app served the request and it failed — signed out, say. The pane
        // shows the reason where the user is; jumping to Parley would only
        // repeat it.
        var h = StartHandshake()
        h.observe(.error, openingMicrophone: false)
        XCTAssertEqual(h.decide(elapsed: 0.1), .acked)
    }

    func testWhatWasHeardIsNotForgotten() {
        // A late provisional read cannot undo an answer or a refusal.
        var answered = StartHandshake()
        answered.observe(.listening, openingMicrophone: false)
        answered.observe(.starting, openingMicrophone: true)
        XCTAssertEqual(answered.decide(elapsed: 5), .acked)

        var refused = StartHandshake()
        refused.observe(.needsApp, openingMicrophone: false)
        refused.observe(.listening, openingMicrophone: false)
        XCTAssertEqual(refused.decide(elapsed: 0.1), .openApp)
    }

    func testTheMicrophoneWaitOutlastsTheFirstAck() {
        XCTAssertGreaterThan(StartHandshake.microphoneWait, StartHandshake.firstAck)
    }

    // MARK: which failures keep the microphone

    func testOnlyAConnectionFailureKeepsTheMicrophone() {
        XCTAssertTrue(DictationFailure.connection.keepsMicrophone)
        XCTAssertFalse(DictationFailure.notSignedIn.keepsMicrophone)
        XCTAssertFalse(DictationFailure.quotaExhausted.keepsMicrophone)
        XCTAssertFalse(DictationFailure.microphone.keepsMicrophone)
        // A new kind has to take a side on purpose.
        XCTAssertEqual(DictationFailure.allCases.count, 4)
    }

    // MARK: the cap and its countdown

    func testTheCapIsTheDesktopsTenMinutes() {
        XCTAssertEqual(MicActivityPolicy.dictationLimit, 600)
        XCTAssertEqual(DictationCountdown.limitMinutes(), 10)
        XCTAssertEqual(DictationCountdown.limitMinutes(90), 2)
        XCTAssertEqual(DictationCountdown.limitMinutes(10), 1)
    }

    func testTheCountdownShowsOnlyTheLastThirtySeconds() {
        let deadline = Date(timeIntervalSince1970: 1_000)
        func left(_ secondsBefore: TimeInterval) -> Int? {
            DictationCountdown.secondsLeft(
                until: deadline, at: deadline.addingTimeInterval(-secondsBefore))
        }
        XCTAssertNil(left(300))
        XCTAssertNil(left(30.5))
        XCTAssertEqual(left(30), 30)
        XCTAssertEqual(left(25), 25)
        XCTAssertEqual(left(24.2), 25)  // rounded up
        XCTAssertEqual(left(0.2), 1)
        XCTAssertNil(left(0))
        XCTAssertNil(left(-3))
        XCTAssertNil(DictationCountdown.secondsLeft(until: nil, at: deadline))
    }

    func testTheNextTickLandsOnTheCountdownsStartThenEverySecond() {
        let deadline = Date(timeIntervalSince1970: 1_000)
        let early = deadline.addingTimeInterval(-100)
        XCTAssertEqual(
            DictationCountdown.nextTick(until: deadline, at: early),
            deadline.addingTimeInterval(-DictationCountdown.warningLead))

        let mid = deadline.addingTimeInterval(-24.25)
        let next = try? XCTUnwrap(DictationCountdown.nextTick(until: deadline, at: mid))
        XCTAssertEqual(next?.timeIntervalSince(mid) ?? 0, 0.25, accuracy: 0.0001)
        XCTAssertEqual(
            DictationCountdown.secondsLeft(until: deadline, at: next ?? mid), 24)

        let onTheSecond = deadline.addingTimeInterval(-10)
        XCTAssertEqual(
            DictationCountdown.nextTick(until: deadline, at: onTheSecond)?
                .timeIntervalSince(onTheSecond) ?? 0, 1, accuracy: 0.0001)

        XCTAssertNil(DictationCountdown.nextTick(until: deadline, at: deadline))
        XCTAssertNil(DictationCountdown.nextTick(until: nil, at: deadline))
    }

    // MARK: wire format

    func testNeedsAppIsNotLiveAndNothingToInsert() {
        XCTAssertEqual(State.needsApp.rawValue, "needsApp")
        XCTAssertFalse(State.needsApp.isLive)
        let down = DictationChannel.Downlink(session: "s", state: .needsApp)
        XCTAssertNil(down.presumedDeadAt(presence: nil))
        XCTAssertNil(
            DictationCopy.text(for: .needsApp, committed: "words", hasFullAccess: true))
    }

    func testTheContinuityFieldsRoundTrip() throws {
        let deadline = Date(timeIntervalSince1970: 1_700_000_600)
        let value = DictationChannel.Downlink(
            session: "s", committed: "so far", state: .done, deadline: deadline,
            notice: .connectionLost)
        let back = try JSONDecoder().decode(
            DictationChannel.Downlink.self, from: JSONEncoder().encode(value))
        XCTAssertEqual(back.notice, .connectionLost)
        XCTAssertEqual(back.deadline, deadline)
        XCTAssertNil(back.openingMicrophone)
        XCTAssertFalse(back.isOpeningMicrophone)

        let provisional = try JSONDecoder().decode(
            DictationChannel.Downlink.self,
            from: JSONEncoder().encode(
                DictationChannel.Downlink(session: "s", openingMicrophone: true)))
        XCTAssertTrue(provisional.isOpeningMicrophone)
    }

    func testAnOlderDownlinkStillDecodes() throws {
        // Written before any of the continuity fields existed.
        let json = Data(
            #"{"session":"s","committed":"hi","partial":"","state":"done"}"#.utf8)
        let value = try JSONDecoder().decode(DictationChannel.Downlink.self, from: json)
        XCTAssertEqual(value.state, .done)
        XCTAssertNil(value.notice)
        XCTAssertNil(value.deadline)
        XCTAssertNil(value.openingMicrophone)
    }

    func testAnUnknownNoticeIsDroppedNotFatal() throws {
        // A `done` that failed to decode would read as "nothing there" and the
        // words would never be inserted. An unfamiliar note is not worth that.
        let json = Data(
            #"{"session":"s","committed":"hi","partial":"","state":"done","notice":"somethingNew"}"#
                .utf8)
        let value = try JSONDecoder().decode(DictationChannel.Downlink.self, from: json)
        XCTAssertEqual(value.state, .done)
        XCTAssertEqual(value.committed, "hi")
        XCTAssertNil(value.notice)
    }

    func testTheHistoryKeepsTheEnding() throws {
        let entry = DictationHistoryEntry(
            text: "hello", startedAt: Date(timeIntervalSince1970: 0), durationMs: 600_000,
            source: .keyboard, ending: .limitReached)
        let back = try JSONDecoder().decode(
            DictationHistoryEntry.self, from: JSONEncoder().encode(entry))
        XCTAssertEqual(back.ending, .limitReached)

        let unknown = Data(
            #"{"id":"\#(UUID().uuidString)","text":"hi","startedAt":0,"durationMs":1,"source":"keyboard","ending":"somethingNew"}"#
                .utf8)
        XCTAssertNil(try JSONDecoder().decode(DictationHistoryEntry.self, from: unknown).ending)
    }
}
