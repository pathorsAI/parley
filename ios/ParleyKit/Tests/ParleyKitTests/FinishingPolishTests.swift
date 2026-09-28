import XCTest

@testable import ParleyKit

/// The race between the AI polish and the user tapping to insert the raw words
/// — the two ways a finishing dictation can end, of which exactly one may run.
final class FinishingPolishTests: XCTestCase {
    func testWithoutASkipTheDrainStartsThePolishAndItsReturnSettles() {
        var finish = FinishingPolish()
        XCTAssertTrue(finish.drained(declined: nil))
        XCTAssertEqual(finish.phase, .polishing)
        XCTAssertTrue(finish.polishReturned(.polished))
        XCTAssertEqual(finish.phase, .settled)
    }

    func testNotWantingAPolishSettlesRawAtTheDrain() {
        var finish = FinishingPolish()
        XCTAssertFalse(finish.drained(declined: .off))
        XCTAssertEqual(finish.phase, .settled)
        // Nothing is in flight, so a late return (there is none) or a late
        // skip changes nothing.
        XCTAssertFalse(finish.polishReturned(.polished))
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
        XCTAssertFalse(finish.drained(declined: nil))
        XCTAssertEqual(finish.phase, .settled)
    }

    func testSkipDuringThePolishSettlesRawOnceAndTheLateReplyLoses() {
        var finish = FinishingPolish()
        XCTAssertTrue(finish.drained(declined: nil))
        XCTAssertEqual(finish.skip(), .settleRawNow)
        XCTAssertEqual(finish.phase, .settled)
        // The polish comes back after the raw words were settled — cancelled
        // or not, it must not settle the session a second time.
        XCTAssertFalse(finish.polishReturned(.polished))
        // And a second tap is harmless.
        XCTAssertEqual(finish.skip(), .tooLate)
    }

    func testThePolishReturningFirstMakesALateSkipTooLate() {
        var finish = FinishingPolish()
        XCTAssertTrue(finish.drained(declined: nil))
        XCTAssertTrue(finish.polishReturned(.polished))
        XCTAssertEqual(finish.skip(), .tooLate)
    }

    func testRepeatedSkipsDuringTheDrainAreOneSkip() {
        var finish = FinishingPolish()
        XCTAssertEqual(finish.skip(), .afterDrain)
        XCTAssertEqual(finish.skip(), .afterDrain)
        XCTAssertFalse(finish.drained(declined: nil))
        XCTAssertEqual(finish.skip(), .tooLate)
    }

    // MARK: the deadline

    func testADrainStillRunningAtTheDeadlineEndsAndSettlesRawWithoutAPolish() {
        // The relay never took the finalize (a stalled socket): the session
        // has to end anyway, with the words it has, and must not then go and
        // spend another round trip on a polish.
        var finish = FinishingPolish()
        XCTAssertEqual(finish.deadlinePassed(), .endDrainNow)
        XCTAssertFalse(finish.drained(declined: nil))
        XCTAssertEqual(finish.phase, .settled)
        // And the drain returning late (or `finishUp` reached a second time)
        // changes nothing.
        XCTAssertFalse(finish.drained(declined: nil))
        XCTAssertFalse(finish.polishReturned(.polished))
    }

    func testAPolishStillOutAtTheDeadlineSettlesRawAndItsLateReplyLoses() {
        var finish = FinishingPolish()
        XCTAssertTrue(finish.drained(declined: nil))
        XCTAssertEqual(finish.deadlinePassed(), .settleRawNow)
        XCTAssertEqual(finish.phase, .settled)
        XCTAssertFalse(finish.polishReturned(.polished))
        XCTAssertEqual(finish.skip(), .tooLate)
    }

    func testTheDeadlineAfterTheSessionSettledDoesNothing() {
        var finish = FinishingPolish()
        XCTAssertTrue(finish.drained(declined: nil))
        XCTAssertTrue(finish.polishReturned(.polished))
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
        XCTAssertFalse(finish.drained(declined: nil))
        XCTAssertEqual(finish.phase, .settled)
    }

    // MARK: the outcome — why the session settled with what it settled with

    func testNoOutcomeUntilSomethingSettles() {
        var finish = FinishingPolish()
        XCTAssertNil(finish.outcome)
        XCTAssertEqual(finish.skip(), .afterDrain)
        XCTAssertNil(finish.outcome, "a skip during the drain only waits")
        var polishing = FinishingPolish()
        XCTAssertTrue(polishing.drained(declined: nil))
        XCTAssertNil(polishing.outcome, "the polish is out; nothing has settled")
    }

    func testAReturnedPolishRecordsWhatItCameTo() {
        for result in PolishOutcome.allCases {
            var finish = FinishingPolish()
            XCTAssertTrue(finish.drained(declined: nil))
            XCTAssertTrue(finish.polishReturned(result))
            XCTAssertEqual(finish.outcome, result)
        }
    }

    func testADeclinedPolishRecordsTheReason() {
        var short = FinishingPolish()
        XCTAssertFalse(short.drained(declined: .tooShort))
        XCTAssertEqual(short.outcome, .tooShort)

        var off = FinishingPolish()
        XCTAssertFalse(off.drained(declined: .off))
        XCTAssertEqual(off.outcome, .off)
    }

    func testASkipDuringTheDrainIsSkipped() {
        var finish = FinishingPolish()
        _ = finish.skip()
        XCTAssertFalse(finish.drained(declined: nil))
        XCTAssertEqual(finish.outcome, .skipped)
    }

    func testASkipDuringThePolishIsSkippedAndTheLateReplyCannotOverwriteIt() {
        var finish = FinishingPolish()
        XCTAssertTrue(finish.drained(declined: nil))
        XCTAssertEqual(finish.skip(), .settleRawNow)
        XCTAssertEqual(finish.outcome, .skipped)
        // The cancelled request comes back anyway, with whatever it came to.
        XCTAssertFalse(finish.polishReturned(.polished))
        XCTAssertEqual(finish.outcome, .skipped)
    }

    func testTheDeadlineDuringThePolishIsOverdue() {
        var finish = FinishingPolish()
        XCTAssertTrue(finish.drained(declined: nil))
        XCTAssertEqual(finish.deadlinePassed(), .settleRawNow)
        XCTAssertEqual(finish.outcome, .overdue)
        XCTAssertFalse(finish.polishReturned(.timedOut))
        XCTAssertEqual(finish.outcome, .overdue)
    }

    func testTheDeadlineDuringTheDrainIsOverdueNotSkipped() {
        // The deadline ends the drain by marking it skipped — the same ending —
        // but the label must not blame the user for a stalled socket.
        var finish = FinishingPolish()
        XCTAssertEqual(finish.deadlinePassed(), .endDrainNow)
        XCTAssertFalse(finish.drained(declined: nil))
        XCTAssertEqual(finish.outcome, .overdue)

        // Also when the user had tapped skip first: that tap only waited on the
        // drain, and it was the deadline that stopped waiting.
        var skippedFirst = FinishingPolish()
        _ = skippedFirst.skip()
        _ = skippedFirst.deadlinePassed()
        XCTAssertFalse(skippedFirst.drained(declined: nil))
        XCTAssertEqual(skippedFirst.outcome, .overdue)
    }

    func testANeverWantedPolishKeepsItsReasonOverASkipOrTheDeadline() {
        // "Too short" stays true whatever the user tapped or the clock did.
        var skipped = FinishingPolish()
        _ = skipped.skip()
        XCTAssertFalse(skipped.drained(declined: .tooShort))
        XCTAssertEqual(skipped.outcome, .tooShort)

        var overdue = FinishingPolish()
        _ = overdue.deadlinePassed()
        XCTAssertFalse(overdue.drained(declined: .off))
        XCTAssertEqual(overdue.outcome, .off)
    }

    func testTheDeadlineAfterSettlingKeepsTheOutcome() {
        var finish = FinishingPolish()
        XCTAssertTrue(finish.drained(declined: nil))
        XCTAssertTrue(finish.polishReturned(.rejectedScript))
        XCTAssertEqual(finish.deadlinePassed(), .settled)
        XCTAssertEqual(finish.skip(), .tooLate)
        XCTAssertEqual(finish.outcome, .rejectedScript)
    }

    func testTheDrainOnlyEndsOnce() {
        // `finishUp` can be reached twice for one session (the relay signing
        // off while `stop` is still awaiting it); the second must not start a
        // second polish or settle again.
        var finish = FinishingPolish()
        XCTAssertTrue(finish.drained(declined: nil))
        XCTAssertFalse(finish.drained(declined: nil))
        XCTAssertEqual(finish.phase, .polishing)
    }
}
