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

        XCTAssertTrue(log.hostReported(before: "ㄋ", after: ""))
        XCTAssertEqual(log.pending, ["ㄋ", "ㄋ ㄏ", "ㄋ ㄏㄠ"])

        XCTAssertTrue(log.hostReported(before: "ㄋ ㄏㄠ", after: ""))
        XCTAssertEqual(log.pending, ["ㄋ ㄏㄠ"])

        XCTAssertFalse(log.hostReported(before: "你好", after: ""))
    }

    func testAPickWithARemainderIsConfirmedOneStateAtATime() {
        var log = MarkedTextLog()
        log.sent("ㄋ ㄏ")
        log.sent("")
        log.sent("ㄏ")

        XCTAssertTrue(log.hostReported(before: "你好", after: ""))
        XCTAssertEqual(log.pending, ["", "ㄏ"])

        XCTAssertTrue(log.hostReported(before: "你好ㄏ", after: ""))
        XCTAssertEqual(log.pending, ["ㄏ"])
    }

    func testAnyReportIsConsistentWithNothingPending() {
        var log = MarkedTextLog()
        XCTAssertTrue(log.hostReported(before: "a", after: "b"))
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
}
