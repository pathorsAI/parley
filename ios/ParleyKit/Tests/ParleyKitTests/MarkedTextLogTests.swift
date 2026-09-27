import XCTest
import ParleyKit

final class MarkedTextLogTests: XCTestCase {
    func testTheCaretIsInsideTheMarkedTextOrAtEitherEnd() {
        XCTAssertTrue(MarkedTextLog.caretIsInside("ㄋ ㄏ", before: "你好ㄋ ㄏ", after: ""))
        XCTAssertTrue(MarkedTextLog.caretIsInside("ㄋ ㄏ", before: "你好", after: "ㄋ ㄏ"))
        XCTAssertTrue(MarkedTextLog.caretIsInside("ㄋ ㄏ", before: "你好ㄋ", after: " ㄏ"))
    }

    func testTheCaretIsOutsideTheMarkedText() {
        XCTAssertFalse(MarkedTextLog.caretIsInside("ㄋ ㄏ", before: "你好", after: ""))
        XCTAssertFalse(MarkedTextLog.caretIsInside("ㄋ ㄏ", before: "ㄋ ㄏ你好", after: ""),
                       "the same reading elsewhere in the field")
        XCTAssertFalse(MarkedTextLog.caretIsInside("ㄋ ㄏ", before: "ㄋ", after: "ㄏ"),
                       "the space is missing")
    }

    func testToneMarksAreCharactersOfTheirOwn() {
        XCTAssertTrue(MarkedTextLog.caretIsInside("ㄋㄧˇ ㄏ", before: "ㄋㄧ", after: "ˇ ㄏ"))
        XCTAssertTrue(MarkedTextLog.caretIsInside("ㄋㄧˇ ㄏ", before: "ㄋㄧˇ", after: " ㄏ"))
        XCTAssertTrue(MarkedTextLog.caretIsInside("ㄨㄛˉ", before: "ㄨㄛˉ", after: ""))
        XCTAssertFalse(MarkedTextLog.caretIsInside("ㄨㄛˉ", before: "ㄨㄛ", after: ""))
    }

    func testAClippedContextCanStillHoldTheCaret() {
        XCTAssertTrue(MarkedTextLog.caretIsInside("ㄋ ㄏ", before: "ㄏ", after: ""), "clipped before")
        XCTAssertTrue(MarkedTextLog.caretIsInside("ㄋ ㄏ", before: "", after: "ㄋ"), "clipped after")
        XCTAssertFalse(MarkedTextLog.caretIsInside("ㄋ ㄏ", before: "好", after: ""))
        XCTAssertFalse(MarkedTextLog.caretIsInside("ㄋ", before: "", after: ""), "an empty field")
        XCTAssertFalse(MarkedTextLog.caretIsInside("ㄋ ㄏ", before: "", after: "你好ㄋ ㄏ"),
                       "the caret moved to the field's start")
    }

    func testNoMarkedTextIsAlwaysConsistent() {
        XCTAssertTrue(MarkedTextLog.caretIsInside("", before: "x", after: "y"))
    }

    func testAStaleReportMatchesAnOlderPendingState() {
        var log = MarkedTextLog()
        log.sent("ㄋ")
        log.sent("ㄋ ㄏ")
        log.sent("ㄋ ㄏㄠ")

        XCTAssertEqual(log.hostReported(before: "ㄋ", after: ""), .consistent)
        XCTAssertEqual(log.pending, ["ㄋ", "ㄋ ㄏ", "ㄋ ㄏㄠ"])

        XCTAssertEqual(log.hostReported(before: "ㄋ ㄏㄠ", after: ""), .consistent)
        XCTAssertEqual(log.pending, ["ㄋ ㄏㄠ"])

        XCTAssertEqual(log.hostReported(before: "你好", after: ""), .left)
    }

    func testAPickWithARemainderIsConfirmedOneStateAtATime() {
        var log = MarkedTextLog()
        log.sent("ㄋ ㄏ")
        log.sent("")
        log.sent("ㄏ")

        XCTAssertEqual(log.hostReported(before: "你好", after: ""), .consistent)
        XCTAssertEqual(log.pending, ["", "ㄏ"])

        XCTAssertEqual(log.hostReported(before: "你好ㄏ", after: ""), .consistent)
        XCTAssertEqual(log.pending, ["ㄏ"])
    }

    func testAnyReportIsConsistentWithNothingPending() {
        var log = MarkedTextLog()
        XCTAssertEqual(log.hostReported(before: "a", after: "b"), .consistent)
        XCTAssertEqual(log.current, "")
    }

    func testTheLogKeepsTheNewest32States() {
        var log = MarkedTextLog()
        for i in 0..<40 { log.sent("ㄋ\(i)") }
        XCTAssertEqual(log.pending.count, 32)
        XCTAssertEqual(log.current, "ㄋ39")
        XCTAssertEqual(log.pending.first, "ㄋ8")
    }

    func testResetForgetsEveryState() {
        var log = MarkedTextLog()
        log.sent("ㄋ")
        log.reset()
        XCTAssertEqual(log.pending, [])
        XCTAssertEqual(log.current, "")
    }

    // MARK: per-field fallback to the strip

    func testAHostThatNeverShowsTheReadingInAnEmptyFieldIgnoresMarkedText() {
        var log = MarkedTextLog()
        log.sent("ㄋ")
        XCTAssertEqual(log.hostSettled(before: nil, after: nil, hasText: false), .ignoresMarkedText)
        XCTAssertFalse(log.usesMarkedText)
        XCTAssertEqual(log.pending, [], "nothing is marked in that host")
        XCTAssertEqual(log.hostSettled(before: nil, after: nil, hasText: false), .consistent,
                       "the verdict is given once per field")
    }

    func testTheReadingAsTheFieldsOnlyTextConfirmsTheMark() {
        var log = MarkedTextLog()
        log.sent("ㄋ ㄏ")
        XCTAssertEqual(log.hostSettled(before: nil, after: nil, hasText: true), .consistent)
        XCTAssertTrue(log.confirmed)
        XCTAssertTrue(log.usesMarkedText)
    }

    func testAContextHoldingTheReadingConfirmsTheMark() {
        var log = MarkedTextLog()
        log.sent("ㄋ")
        XCTAssertEqual(log.hostReported(before: "你好ㄋ", after: ""), .consistent)
        XCTAssertTrue(log.confirmed)
    }

    func testAConfirmedFieldThatLosesTheReadingIsLeftNotIgnored() {
        var log = MarkedTextLog()
        log.sent("ㄋ")
        _ = log.hostSettled(before: "", after: "", hasText: true)
        log.sent("ㄋ ㄏ")
        XCTAssertEqual(log.hostReported(before: "", after: ""), .left,
                       "the host cleared its text, as Messages does on send")
        XCTAssertTrue(log.usesMarkedText)
    }

    func testTextAroundTheCaretWithoutTheReadingIsUnknownWhenSettling() {
        // iOS 26.5 hosts leave marked text out of the context they report, so
        // a host that shows the mark and one that dropped it look the same.
        var log = MarkedTextLog()
        log.sent("ㄇ")
        XCTAssertEqual(log.hostSettled(before: "ㄋ ㄏ", after: nil, hasText: true), .consistent)
        XCTAssertTrue(log.usesMarkedText)
        XCTAssertFalse(log.confirmed)
    }

    func testClippedOrMissingContextIsUnknown() {
        var log = MarkedTextLog()
        log.sent("ㄋ ㄏ")
        XCTAssertEqual(log.hostReported(before: nil, after: nil), .consistent)
        XCTAssertEqual(log.hostReported(before: "", after: ""), .consistent,
                       "an empty field before any confirmation may be a report from before the mark")
        XCTAssertEqual(log.hostReported(before: "ㄏ", after: nil), .consistent, "clipped before")
        XCTAssertTrue(log.usesMarkedText)
    }

    func testAFieldChangeStartsEveryVerdictOver() {
        var log = MarkedTextLog()
        log.sent("ㄋ")
        _ = log.hostSettled(before: nil, after: nil, hasText: false)
        XCTAssertFalse(log.usesMarkedText)
        log.fieldChanged()
        XCTAssertTrue(log.usesMarkedText)
        XCTAssertFalse(log.confirmed)
        XCTAssertEqual(log.pending, [])
    }

    func testResetKeepsTheFieldsVerdict() {
        var log = MarkedTextLog()
        log.sent("ㄋ")
        _ = log.hostSettled(before: nil, after: nil, hasText: true)
        log.reset()
        XCTAssertTrue(log.confirmed)
    }

    // MARK: stranded readings

    func testAStrandedReadingIsRepairedWhenTheTextEndsWithIt() {
        let at = Date(timeIntervalSince1970: 1_000)
        let stranded = StrandedReading(reading: "ㄋㄧˇ ㄏ", best: "你好", at: at)
        let repair = stranded.repair(before: "買菜 ㄋㄧˇ ㄏ", now: at.addingTimeInterval(5))
        XCTAssertEqual(repair?.delete, 5)
        XCTAssertEqual(repair?.insert, "你好")
    }

    func testAStrandedReadingMatchesExactlyOrNotAtAll() {
        let at = Date(timeIntervalSince1970: 1_000)
        let stranded = StrandedReading(reading: "ㄋ ㄏ", best: "你好", at: at)
        let now = at.addingTimeInterval(5)
        XCTAssertNil(stranded.repair(before: "ㄋㄏ", now: now), "the space is part of the reading")
        XCTAssertNil(stranded.repair(before: "ㄋ ㄏabc", now: now), "the caret is not after it")
        XCTAssertNil(stranded.repair(before: nil, now: now))
        XCTAssertNil(stranded.repair(before: "ㄋ ㄏ", now: at.addingTimeInterval(StrandedReading.lifetime)),
                     "too old to repair")
    }
}
