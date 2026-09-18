import Foundation
import XCTest

@testable import ParleyKit

/// The meeting stop mailbox. Like the dictation ones, the container itself
/// needs two signed processes and a phone, so what is testable here is the
/// timestamp rule — which is the part that decides whether a leftover file is
/// harmless or stops a recording nobody asked it to.
final class MeetingControlTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    func testAStopAppliesToTheRecordingThatWasRunning() {
        let control = MeetingControl(stopRequestedAt: t0.addingTimeInterval(30))
        XCTAssertTrue(control.applies(toRecordingStartedAt: t0))
    }

    func testAStopAtTheVeryInstantTheRecordingBeganStillApplies() {
        // The card appears the moment the recording starts, so the two
        // timestamps can be the same to the microsecond. A `>` here would drop
        // the fastest tap in the app.
        let control = MeetingControl(stopRequestedAt: t0)
        XCTAssertTrue(control.applies(toRecordingStartedAt: t0))
    }

    func testAStopFromBeforeTheRecordingIsIgnored() {
        // Neither side ever clears this file, so last week's stop is still
        // sitting in the container. It must not end the recording that starts
        // next — a stale request is a request about a recording that is over.
        let control = MeetingControl(stopRequestedAt: t0.addingTimeInterval(-1))
        XCTAssertFalse(control.applies(toRecordingStartedAt: t0))
    }

    func testNoRecordingMeansNothingToStop() {
        // Also what makes acting on the file idempotent: once the app has
        // honoured a stop there is no start date left, so reading the same
        // still-true request again does nothing.
        XCTAssertFalse(MeetingControl(stopRequestedAt: t0).applies(toRecordingStartedAt: nil))
    }

    func testControlSurvivesTheAppGroupRoundTrip() throws {
        let control = MeetingControl(stopRequestedAt: t0)
        let back = try JSONDecoder().decode(
            MeetingControl.self, from: JSONEncoder().encode(control))
        XCTAssertEqual(back, control)
    }

    func testTheNoteIsNotOneOfTheDictationNotes() {
        // A meeting stop is not dictation (see `MeetingControlChannel`), and a
        // note collision would hand it to `DictationCoordinator`'s observers,
        // which would read a dictation mailbox that has nothing in it.
        let dictation = [
            DictationChannel.downNote, DictationChannel.upNote,
            DictationChannel.windowNote, DictationChannel.windowControlNote,
            DictationChannel.readyNote, DictationChannel.presenceNote,
        ]
        XCTAssertFalse(dictation.contains(MeetingControlChannel.note))
    }
}
