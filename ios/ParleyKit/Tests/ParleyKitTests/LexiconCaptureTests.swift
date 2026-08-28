import XCTest

@testable import ParleyKit

/// The half of the keyboard's capture that can be run without a keyboard.
///
/// Everything here is about the same question: given two clipped views of a
/// field taken at different times, is there anything here worth learning? The
/// answer is usually no, and being confidently wrong is the expensive failure —
/// a bogus pair becomes a rule that rewrites the user's words from then on.
final class LexiconCaptureTests: XCTestCase {

    // MARK: the window

    func testTheWindowKeepsTheTail() {
        let long = String(repeating: "a", count: LexiconCapture.windowLimit + 50) + "end"
        let window = LexiconCapture.window(long)
        XCTAssertEqual(window.count, LexiconCapture.windowLimit)
        XCTAssertTrue(window.hasSuffix("end"))
    }

    func testNoContextIsAnEmptyWindow() {
        XCTAssertEqual(LexiconCapture.window(nil), "")
    }

    // MARK: the alignment gate

    func testTwoViewsOfOneFieldAlign() {
        XCTAssertTrue(LexiconCapture.alignable("we use pearly today", "we use Parley today"))
    }

    func testASharedTailAloneIsEnough() {
        // The window slid at the front — the field grew — but the text up to the
        // cursor still matches, which is all the gate needs.
        XCTAssertTrue(LexiconCapture.alignable("xyz and the pearly report", "the Parley report"))
    }

    func testUnrelatedTextDoesNotAlign() {
        XCTAssertFalse(LexiconCapture.alignable("we use pearly today", "totally different"))
    }

    func testAShortCoincidenceDoesNotAlign() {
        // "the " in common is not evidence of anything.
        XCTAssertFalse(LexiconCapture.alignable("the quick brown fox", "the lazy dog sleeps"))
    }

    func testAShortCJKAnchorIsStillEnough() {
        // The anchor is weighted, not counted. Five shared ideographs are a
        // clause; five shared Latin characters are half a word.
        // Three shared ideographs clear the bar; five shared Latin characters
        // do not.
        XCTAssertTrue(LexiconCapture.alignable("我在來一次好嗎", "我再來一次好嗎"))
        XCTAssertFalse(LexiconCapture.alignable("abcd fox", "abcd dog"))
    }

    func testIdenticalOrEmptyWindowsDoNotAlign() {
        XCTAssertFalse(LexiconCapture.alignable("same text here", "same text here"))
        XCTAssertFalse(LexiconCapture.alignable("", "anything at all"))
        XCTAssertFalse(LexiconCapture.alignable("anything at all", ""))
    }

    // MARK: end to end

    func testACorrectionInAFieldIsCaptured() {
        XCTAssertEqual(
            LexiconCapture.spans(before: "let's use pearly", after: "let's use Parley"),
            [EditDiff.Span(original: "pearly", replacement: "Parley")])
    }

    func testAWordIsCapturedWholeRatherThanCutAtTheSharedEdges() {
        // The regression this file exists for: a character-level trim would hand
        // the diff "pearl" against "Parle" — a pair that can never match,
        // because a Latin original only applies on a word boundary.
        let spans = LexiconCapture.spans(before: "we use pearly", after: "we use Parley")
        XCTAssertEqual(spans.map(\.original), ["pearly"])
        XCTAssertEqual(spans.map(\.replacement), ["Parley"])
    }

    func testACJKCorrectionIsCaptured() {
        XCTAssertEqual(
            LexiconCapture.spans(before: "明天我在來一次好嗎", after: "明天我再來一次好嗎"),
            [EditDiff.Span(original: "在", replacement: "再")])
    }

    func testTypingOnAfterDictatingTeachesNothing() {
        XCTAssertTrue(
            LexiconCapture.spans(
                before: "meeting at three", after: "meeting at three tomorrow"
            ).isEmpty)
    }

    func testAFieldTheUserRetypedTeachesNothing() {
        XCTAssertTrue(
            LexiconCapture.spans(before: "meeting at three", after: "never mind").isEmpty)
    }

    func testAWindowThatSlidOutOfAlignmentTeachesNothing() {
        // Two windows on two different parts of a long document. There is a
        // shared "ipsum " in there; there is no edit.
        let before = String(repeating: "lorem ipsum ", count: 5) + "alpha"
        let after = String(repeating: "ipsum lorem ", count: 5) + "omega"
        XCTAssertTrue(LexiconCapture.spans(before: before, after: after).isEmpty)
    }
}
