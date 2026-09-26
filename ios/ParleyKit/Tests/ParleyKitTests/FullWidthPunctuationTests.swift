import XCTest

@testable import ParleyKit

/// The 注音 pane's punctuation. The table is small enough to read, so the tests
/// are about the promises around it: what a 注音 typist can reach, and what must
/// never turn full-width.
final class FullWidthPunctuationTests: XCTestCase {
    func testTheSentenceMarks() {
        XCTAssertEqual(FullWidthPunctuation.fullWidth(","), "，")
        XCTAssertEqual(FullWidthPunctuation.fullWidth("."), "。")
        XCTAssertEqual(FullWidthPunctuation.fullWidth("?"), "？")
        XCTAssertEqual(FullWidthPunctuation.fullWidth("!"), "！")
        XCTAssertEqual(FullWidthPunctuation.fullWidth("["), "「")
        XCTAssertEqual(FullWidthPunctuation.fullWidth("]"), "」")
    }

    func testDigitsAndLettersStayHalfWidth() {
        for c in "0123456789abcXYZ" {
            XCTAssertEqual(FullWidthPunctuation.fullWidth(c), String(c))
        }
    }

    func testMarksWithNoConventionStayASCII() {
        // A full-width `＠` in an email address is a broken address.
        for c in "@$&#%*+=-/_\\|\"^" {
            XCTAssertEqual(FullWidthPunctuation.fullWidth(c), String(c), "\(c)")
        }
    }

    func testAMarkAlreadyFullWidthIsLeftAlone() {
        for c in "，。「」…、" {
            XCTAssertEqual(FullWidthPunctuation.fullWidth(c), String(c))
        }
    }

    /// Everything the owner asked to type on the 注音 pane has a key on one of
    /// its two symbol planes.
    func testTheRequiredMarksAreReachable() {
        let planes =
            FullWidthPunctuation.numbersMiddle + FullWidthPunctuation.numbersPunctuation
            + FullWidthPunctuation.symbolsTop + FullWidthPunctuation.symbolsMiddle
            + FullWidthPunctuation.symbolsPunctuation
        for mark in ["，", "。", "？", "！", "、", "：", "；", "「", "」", "（", "）", "…", "～"] {
            XCTAssertTrue(planes.contains(mark), "\(mark) has no key")
        }
    }

    /// The fixed rows are ten keys, like QWERTY's, so the two panes' planes
    /// line up key for key.
    func testTheFixedRowsAreTenWide() {
        XCTAssertEqual(FullWidthPunctuation.numbersMiddle.count, 10)
        XCTAssertEqual(FullWidthPunctuation.symbolsTop.count, 10)
        XCTAssertEqual(FullWidthPunctuation.symbolsMiddle.count, 10)
    }

    /// The numbers plane keeps one ASCII period, for decimals.
    func testTheNumbersPlaneKeepsADecimalPoint() {
        XCTAssertEqual(
            FullWidthPunctuation.numbersPunctuation, ["。", "，", "、", "？", "！", "."])
    }
}
