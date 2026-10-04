import XCTest

@testable import ParleyKit

/// What the keyboard is allowed to learn from an edit.
///
/// Most of these assert a *refusal*. That is the point of the file: the diff
/// sees every edit the user makes in the field, and all but one shape of them
/// would teach the lexicon something false.
final class EditDiffTests: XCTestCase {

    // MARK: what a correction looks like

    func testLatinWordSwap() {
        XCTAssertEqual(
            EditDiff.spans(pasted: "we use pearly for that", edited: "we use Parley for that"),
            [EditDiff.Span(original: "pearly", replacement: "Parley")])
    }

    func testCJKHomophoneFix() {
        // The case this feature exists for: one character, one tone apart, and
        // the sentence around it untouched. Learned with the character after
        // it, because a single character applied as a substring would rewrite
        // every 在 the user ever dictates.
        XCTAssertEqual(
            EditDiff.spans(pasted: "我在來一次", edited: "我再來一次"),
            [EditDiff.Span(original: "在來", replacement: "再來")])
    }

    // MARK: the CJK minimum span

    func testASingleCharacterFixKeepsTheSharedCharacterAfterIt() {
        // 派斯 → 帕斯 aligns 斯 and diffs to 派 → 帕; stored like that it would
        // turn 派對 into 帕對.
        XCTAssertEqual(
            EditDiff.spans(pasted: "我們派斯很好", edited: "我們帕斯很好"),
            [EditDiff.Span(original: "派斯", replacement: "帕斯")])
    }

    func testASingleCharacterReplacementIsWidenedToo() {
        // 帕索斯 → 派斯 diffs to 帕索 → 派. The original is two characters
        // already, but a one-character replacement is as narrow a rule.
        XCTAssertEqual(
            EditDiff.spans(pasted: "用帕索斯做", edited: "用派斯做"),
            [EditDiff.Span(original: "帕索斯", replacement: "派斯")])
    }

    func testWideningFallsBackToTheCharacterBefore() {
        // Nothing ideographic after the change, so the character before it is
        // taken instead.
        XCTAssertEqual(
            EditDiff.spans(pasted: "我在。", edited: "我再。"),
            [EditDiff.Span(original: "我在", replacement: "我再")])
    }

    func testASingleCharacterWithNothingToWidenIntoIsRefused() {
        XCTAssertTrue(EditDiff.spans(pasted: "在", edited: "再").isEmpty)
        XCTAssertTrue(EditDiff.spans(pasted: "ok 在 ok", edited: "ok 再 ok").isEmpty)
    }

    func testASingleCharacterOriginalWithALatinReplacementIsRefused() {
        // There is no "rest of the word" to widen with across scripts.
        XCTAssertTrue(EditDiff.spans(pasted: "我們派的", edited: "我們Pathors的").isEmpty)
    }

    func testATwoCharacterFixIsLeftAsItIs() {
        XCTAssertEqual(
            EditDiff.spans(pasted: "我們派斯的產品", edited: "我們Pathors的產品"),
            [EditDiff.Span(original: "派斯", replacement: "Pathors")])
    }

    func testAdjacentChangedTokensBecomeOneSpan() {
        // Two characters fixed side by side are one vocabulary item, not two —
        // merging is what `regions` does by construction, because a region is
        // the whole gap between two aligned tokens.
        XCTAssertEqual(
            EditDiff.spans(pasted: "我在萊一次", edited: "我再來一次"),
            [EditDiff.Span(original: "在萊", replacement: "再來")])
    }

    func testChangedTokensSeparatedByMatchingTextStaySeparate() {
        // The mirror of the test above, and the reason merging is bounded: two
        // misheard words with an intact space between them are two things the
        // user cares about, and learning them as one phrase would only fire
        // when both were misheard together again.
        XCTAssertEqual(
            EditDiff.spans(pasted: "ship it on pearly clod", edited: "ship it on Parley Cloud"),
            [
                EditDiff.Span(original: "pearly", replacement: "Parley"),
                EditDiff.Span(original: "clod", replacement: "Cloud"),
            ])
    }

    func testMultipleSpans() {
        let spans = EditDiff.spans(
            pasted: "我在來一次 with pearly", edited: "我再來一次 with Parley")
        XCTAssertEqual(
            spans,
            [
                EditDiff.Span(original: "在來", replacement: "再來"),
                EditDiff.Span(original: "pearly", replacement: "Parley"),
            ])
    }

    func testSpansComeBackInDocumentOrder() {
        let spans = EditDiff.spans(pasted: "alfa bravo charlie", edited: "alpha bravo charley")
        XCTAssertEqual(spans.map(\.original), ["alfa", "charlie"])
        XCTAssertEqual(spans.map(\.replacement), ["alpha", "charley"])
    }

    // MARK: what it refuses

    func testIdenticalTextsProduceNothing() {
        XCTAssertTrue(EditDiff.spans(pasted: "nothing changed", edited: "nothing changed").isEmpty)
    }

    func testEmptyInputProducesNothing() {
        XCTAssertTrue(EditDiff.spans(pasted: "", edited: "something").isEmpty)
        XCTAssertTrue(EditDiff.spans(pasted: "something", edited: "").isEmpty)
    }

    func testInsertionOnlyProducesNothing() {
        // The user added a word. That says nothing about how any word should be
        // transcribed.
        XCTAssertTrue(EditDiff.spans(pasted: "hello world", edited: "hello there world").isEmpty)
        XCTAssertTrue(EditDiff.spans(pasted: "我來一次", edited: "我再來一次").isEmpty)
    }

    func testDeletionOnlyProducesNothing() {
        XCTAssertTrue(EditDiff.spans(pasted: "hello there world", edited: "hello world").isEmpty)
        XCTAssertTrue(EditDiff.spans(pasted: "我再來一次", edited: "我來一次").isEmpty)
    }

    func testTrailingInsertionProducesNothing() {
        // The commonest edit of all: the user keeps typing after dictating.
        XCTAssertTrue(
            EditDiff.spans(pasted: "send it today", edited: "send it today please").isEmpty)
    }

    func testCaseOnlyChangeProducesNothing() {
        // Autocapitalisation, or the user styling their own sentence. Learning
        // it would have the lexicon fighting the host app forever.
        XCTAssertTrue(EditDiff.spans(pasted: "the api call", edited: "the API call").isEmpty)
        XCTAssertTrue(EditDiff.spans(pasted: "parley", edited: "Parley").isEmpty)
    }

    func testPunctuationOnlyChangeProducesNothing() {
        XCTAssertTrue(EditDiff.spans(pasted: "done, thanks", edited: "done. thanks").isEmpty)
        XCTAssertTrue(EditDiff.spans(pasted: "ok?", edited: "ok!").isEmpty)
    }

    func testWhitespaceOnlyChangeProducesNothing() {
        XCTAssertTrue(EditDiff.spans(pasted: "a  b", edited: "a b").isEmpty)
    }

    func testSpansLongerThanTheCapAreDropped() {
        // A whole clause replaced is the user rewriting, and there is no way to
        // tell that from a very long name being fixed — so neither is learned.
        XCTAssertTrue(
            EditDiff.spans(
                pasted: "prefix internationalization suffix",
                edited: "prefix globalizationalization suffix"
            ).isEmpty)
    }

    func testALongSideDropsThePairEvenWhenTheOtherIsShort() {
        XCTAssertTrue(
            EditDiff.spans(pasted: "call sql today", edited: "call structuredquery today").isEmpty)
    }

    func testAnAbsurdlyLongEditIsRefusedOutright() {
        // The alignment table is O(n·m) and this runs in a keyboard extension.
        let pasted = String(repeating: "word ", count: 300)
        let edited = String(repeating: "other ", count: 300)
        XCTAssertTrue(EditDiff.spans(pasted: pasted, edited: edited).isEmpty)
    }

    // MARK: tokens

    func testLatinRunsAreWholeWordsAndCJKIsPerCharacter() {
        XCTAssertEqual(EditDiff.tokenize("hi 你好"), ["hi", " ", "你", "好"])
    }

    func testPunctuationIsItsOwnToken() {
        XCTAssertEqual(EditDiff.tokenize("a, b."), ["a", ",", " ", "b", "."])
    }

    func testAnApostropheStaysInsideItsWord() {
        XCTAssertEqual(EditDiff.tokenize("don't stop"), ["don't", " ", "stop"])
    }

    func testAccentedLatinIsAWordNotIdeographic() {
        XCTAssertEqual(EditDiff.tokenize("café au lait"), ["café", " ", "au", " ", "lait"])
        XCTAssertFalse(EditDiff.isIdeographic("é"))
        XCTAssertTrue(EditDiff.isIdeographic("再"))
    }
}
