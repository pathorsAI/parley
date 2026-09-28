import XCTest

@testable import ParleyKit

/// The race between the AI polish and the user tapping to insert the raw words
/// — the two ways a finishing dictation can end, of which exactly one may run.
final class FinishingPolishTests: XCTestCase {
    func testWithoutASkipTheDrainStartsThePolishAndItsReturnSettles() {
        var finish = FinishingPolish()
        XCTAssertTrue(finish.drained(wantsPolish: true))
        XCTAssertEqual(finish.phase, .polishing)
        XCTAssertTrue(finish.polishReturned())
        XCTAssertEqual(finish.phase, .settled)
    }

    func testNotWantingAPolishSettlesRawAtTheDrain() {
        var finish = FinishingPolish()
        XCTAssertFalse(finish.drained(wantsPolish: false))
        XCTAssertEqual(finish.phase, .settled)
        // Nothing is in flight, so a late return (there is none) or a late
        // skip changes nothing.
        XCTAssertFalse(finish.polishReturned())
        XCTAssertEqual(finish.skip(), .tooLate)
    }

    func testSkipDuringTheDrainNeverStartsThePolish() {
        var finish = FinishingPolish()
        // The last words are still arriving: the skip must not cut them off,
        // only decide what happens once they are in.
        XCTAssertEqual(finish.skip(), .afterDrain)
        XCTAssertEqual(finish.phase, .draining)
        XCTAssertTrue(finish.skipRequested)
        // The drain completes: settle raw, no polish, even though the polish
        // would otherwise have been wanted.
        XCTAssertFalse(finish.drained(wantsPolish: true))
        XCTAssertEqual(finish.phase, .settled)
    }

    func testSkipDuringThePolishSettlesRawOnceAndTheLateReplyLoses() {
        var finish = FinishingPolish()
        XCTAssertTrue(finish.drained(wantsPolish: true))
        XCTAssertEqual(finish.skip(), .settleRawNow)
        XCTAssertEqual(finish.phase, .settled)
        // The polish comes back after the raw words were settled — cancelled
        // or not, it must not settle the session a second time.
        XCTAssertFalse(finish.polishReturned())
        // And a second tap is harmless.
        XCTAssertEqual(finish.skip(), .tooLate)
    }

    func testThePolishReturningFirstMakesALateSkipTooLate() {
        var finish = FinishingPolish()
        XCTAssertTrue(finish.drained(wantsPolish: true))
        XCTAssertTrue(finish.polishReturned())
        XCTAssertEqual(finish.skip(), .tooLate)
    }

    func testRepeatedSkipsDuringTheDrainAreOneSkip() {
        var finish = FinishingPolish()
        XCTAssertEqual(finish.skip(), .afterDrain)
        XCTAssertEqual(finish.skip(), .afterDrain)
        XCTAssertFalse(finish.drained(wantsPolish: true))
        XCTAssertEqual(finish.skip(), .tooLate)
    }

    // MARK: the deadline

    func testADrainStillRunningAtTheDeadlineEndsAndSettlesRawWithoutAPolish() {
        // The relay never took the finalize (a stalled socket): the session
        // has to end anyway, with the words it has, and must not then go and
        // spend another round trip on a polish.
        var finish = FinishingPolish()
        XCTAssertEqual(finish.deadlinePassed(), .endDrainNow)
        XCTAssertFalse(finish.drained(wantsPolish: true))
        XCTAssertEqual(finish.phase, .settled)
        // And the drain returning late (or `finishUp` reached a second time)
        // changes nothing.
        XCTAssertFalse(finish.drained(wantsPolish: true))
        XCTAssertFalse(finish.polishReturned())
    }

    func testAPolishStillOutAtTheDeadlineSettlesRawAndItsLateReplyLoses() {
        var finish = FinishingPolish()
        XCTAssertTrue(finish.drained(wantsPolish: true))
        XCTAssertEqual(finish.deadlinePassed(), .settleRawNow)
        XCTAssertEqual(finish.phase, .settled)
        XCTAssertFalse(finish.polishReturned())
        XCTAssertEqual(finish.skip(), .tooLate)
    }

    func testTheDeadlineAfterTheSessionSettledDoesNothing() {
        var finish = FinishingPolish()
        XCTAssertTrue(finish.drained(wantsPolish: true))
        XCTAssertTrue(finish.polishReturned())
        XCTAssertEqual(finish.deadlinePassed(), .settled)
        XCTAssertEqual(finish.phase, .settled)
    }

    func testASkipWaitingOnAStuckDrainIsEndedByTheDeadline() {
        // The shape of the 1.24 report: ⏹, the drain never completes, and the
        // user taps "insert without polishing" — which, during the drain, only
        // waits for it. Without the deadline nothing would ever settle.
        var finish = FinishingPolish()
        XCTAssertEqual(finish.skip(), .afterDrain)
        XCTAssertEqual(finish.phase, .draining)
        XCTAssertEqual(finish.deadlinePassed(), .endDrainNow)
        XCTAssertFalse(finish.drained(wantsPolish: true))
        XCTAssertEqual(finish.phase, .settled)
    }

    func testTheDrainOnlyEndsOnce() {
        // `finishUp` can be reached twice for one session (the relay signing
        // off while `stop` is still awaiting it); the second must not start a
        // second polish or settle again.
        var finish = FinishingPolish()
        XCTAssertTrue(finish.drained(wantsPolish: true))
        XCTAssertFalse(finish.drained(wantsPolish: true))
        XCTAssertEqual(finish.phase, .polishing)
    }
}
