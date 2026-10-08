import XCTest

@testable import ParleyKit

/// The half of the keyboard's capture that can be run without a keyboard.
///
/// Everything here is about the same question: given two clipped views of a
/// field taken at different times, is there anything here worth learning? The
/// answer is usually no, and being confidently wrong is the expensive failure —
/// a bogus pair becomes a rule that rewrites the user's words from then on.
final class LexiconCaptureTests: XCTestCase {
    private typealias Window = LexiconCapture.Window

    private func span(_ original: String, _ replacement: String) -> EditDiff.Span {
        EditDiff.Span(original: original, replacement: replacement)
    }

    /// A long, non-repeating stretch of Chinese prose, so a long-field test
    /// cannot pass by the alignment latching onto a period in the filler.
    private let prose = [
        "今天早上我們開了一個很長的會議", "大家討論了下一季的產品規劃", "行銷團隊希望能提早發表新功能",
        "工程團隊則認為測試時間還不夠", "最後決定先做一個小規模的試用", "如果反應不錯再擴大到所有客戶",
        "會後我整理了一份待辦清單寄給大家", "下週三之前每個人都要回覆進度", "財務那邊也提醒預算要重新估算",
        "新的辦公室裝潢預計月底完工", "搬家的日期還要再跟房東確認", "實習生下個月開始報到",
        "需要有人帶他們熟悉開發流程", "客服反映最近的回覆速度變慢", "我們打算加開一個晚班時段",
    ].joined(separator: "，")

    // MARK: the window

    func testTheWindowKeepsTheTextNearestTheCursorOnEachSide() {
        let long = String(repeating: "a", count: LexiconCapture.windowLimit + 50)
        let window = Window(before: long + "end", after: "start" + long)
        XCTAssertEqual(window.before.count, LexiconCapture.windowLimit)
        XCTAssertTrue(window.before.hasSuffix("end"))
        XCTAssertEqual(window.after.count, LexiconCapture.windowLimit)
        XCTAssertTrue(window.after.hasPrefix("start"))
        XCTAssertTrue(window.clippedStart)
        XCTAssertTrue(window.clippedEnd)
    }

    func testAShortFieldIsNotClipped() {
        let window = Window(before: "我們", after: "很好")
        XCTAssertEqual(window.text, "我們很好")
        XCTAssertFalse(window.clippedStart)
        XCTAssertFalse(window.clippedEnd)
    }

    func testNoContextIsAnEmptyWindow() {
        XCTAssertEqual(Window(before: nil, after: nil).text, "")
    }

    // MARK: the cursor

    func testACursorLeftMidTextAfterAFixLearnsOnlyTheWord() {
        // The garbage pair this rewrite exists for: fix 派斯 → Pathors and leave
        // the cursor right after it. A view of only the text before the cursor
        // saw 的產品很好 "deleted" and learned 派斯的產品很好 → Pathors.
        let before = Window(before: "我們派斯的產品很好", after: nil)
        let after = Window(before: "我們Pathors", after: "的產品很好")
        XCTAssertEqual(LexiconCapture.spans(before: before, after: after), [span("派斯", "Pathors")])
    }

    func testAOneSidedViewOfThatEditNoLongerLearnsGarbage() {
        // The same edit as the test above, seen the old way. Two shared
        // characters are all that is left in common, which is not evidence of
        // one field, so it is refused instead of becoming a rule.
        let outcome = LexiconCapture.harvest(
            before: Window(before: "我們派斯的產品很好", after: nil),
            after: Window(before: "我們Pathors", after: nil))
        XCTAssertEqual(outcome.learned, [])
        XCTAssertEqual(outcome.refusals, [.unrelated])
    }

    func testAnErrorAfterTheCursorIsLearned() {
        // The user fixed the word and then tapped back to the start of the
        // field: everything is after the cursor now.
        let before = Window(before: "我們派斯的產品很好", after: nil)
        let after = Window(before: nil, after: "我們Pathors的產品很好")
        XCTAssertEqual(LexiconCapture.spans(before: before, after: after), [span("派斯", "Pathors")])
    }

    func testADictationInsertedMidFieldIsComparedWithTheTextAfterIt() {
        // Dictated into the middle of existing text, so the snapshot already
        // has text after the cursor — and the fix is in the dictated part.
        let before = Window(before: "開會紀錄：我們派斯的產品很好", after: "，下週再談細節")
        let after = Window(before: "開會紀錄：我們Pathors", after: "的產品很好，下週再談細節")
        XCTAssertEqual(LexiconCapture.spans(before: before, after: after), [span("派斯", "Pathors")])
    }

    func testAFixInTheFirstCharactersOfTheFieldIsLearned() {
        // No shared text before the change — but the field genuinely starts
        // there, because neither view was clipped.
        let before = Window(before: "派斯的產品很好", after: nil)
        let after = Window(before: "Pathors", after: "的產品很好")
        XCTAssertEqual(LexiconCapture.spans(before: before, after: after), [span("派斯", "Pathors")])
    }

    func testAChangeAgainstAClippedEdgeIsRefused() {
        // The same shape as the test above, except the snapshot's window was
        // cut at 200 characters, so its first word is not the field's first
        // word — and the change might include text that merely slid out of
        // view.
        let filler = String(
            (0..<60).map { "w\($0)" }.joined(separator: " ").prefix(193))
        let clipped = "lead " + "pearly " + filler  // 205 characters
        let before = Window(before: clipped, after: nil)
        XCTAssertTrue(before.clippedStart)
        XCTAssertTrue(before.text.hasPrefix("pearly "))
        let after = Window(before: "Parley " + filler, after: nil)
        let outcome = LexiconCapture.harvest(before: before, after: after)
        XCTAssertEqual(outcome.learned, [])
        XCTAssertEqual(outcome.refusals, [.unanchored])
    }

    // MARK: long fields

    func testAFixInALongParagraphIsLearnedWhenTheCursorMoved() {
        // Dictated into the middle of a long paragraph; the windows on either
        // side are clipped, and after the fix the cursor sits somewhere else,
        // so the two views cover different, overlapping stretches.
        let lead = prose
        let tail = "，" + String(prose.reversed())
        XCTAssertGreaterThan(lead.count, LexiconCapture.windowLimit)
        XCTAssertGreaterThan(tail.count, LexiconCapture.windowLimit)

        let before = Window(before: lead + "我們派斯的產品很好", after: tail)
        let after = Window(before: lead + "我們Pathors", after: "的產品很好" + tail)
        XCTAssertEqual(LexiconCapture.spans(before: before, after: after), [span("派斯", "Pathors")])
    }

    func testAFixWellBehindTheCursorInALongFieldIsLearned() {
        // Dictated at the end of a long field, then a word about a hundred
        // characters back fixed, with the cursor left right after it.
        let head = String(prose.prefix(150))
        let middle = "我們派斯的產品很好"
        let rest = String(prose.suffix(100))
        let before = Window(before: head + middle + rest, after: nil)
        let after = Window(before: head + "我們Pathors", after: "的產品很好" + rest)
        XCTAssertTrue(before.text.contains(middle))
        XCTAssertEqual(LexiconCapture.spans(before: before, after: after), [span("派斯", "Pathors")])
    }

    func testALongEnglishParagraphLearnsTheWord() {
        let lead = String(
            repeating: "We went through the roadmap and agreed on the next steps. ", count: 3)
            + "Then the team looked at numbers from last quarter and the hiring plan. "
        let before = Window(before: lead + "We use pearly for our notes", after: " every day.")
        let after = Window(before: lead + "We use Parley", after: " for our notes every day.")
        XCTAssertEqual(LexiconCapture.spans(before: before, after: after), [span("pearly", "Parley")])
    }

    // MARK: the same-field gate

    func testUnrelatedTextTeachesNothing() {
        let outcome = LexiconCapture.harvest(
            before: Window(before: "we use pearly today", after: nil),
            after: Window(before: "totally different", after: nil))
        XCTAssertEqual(outcome.learned, [])
        XCTAssertEqual(outcome.refusals, [.unrelated])
    }

    func testAShortCoincidenceTeachesNothing() {
        // "the " in common is not evidence of anything.
        XCTAssertEqual(
            LexiconCapture.spans(before: "the quick brown fox", after: "the lazy dog sleeps"), [])
    }

    func testIdenticalOrEmptyViewsTeachNothing() {
        XCTAssertEqual(
            LexiconCapture.harvest(
                before: Window(before: "same text", after: " here"),
                after: Window(before: "same", after: " text here")
            ).refusals, [.unchanged], "the cursor moving is not an edit")
        XCTAssertEqual(LexiconCapture.spans(before: "", after: "anything at all"), [])
        XCTAssertEqual(LexiconCapture.spans(before: "anything at all", after: ""), [])
    }

    func testAWindowThatSlidOutOfAlignmentTeachesNothing() {
        // Two windows on two different parts of a long document. There is a
        // shared "ipsum " in there; there is no edit.
        let before = String(repeating: "lorem ipsum ", count: 5) + "alpha"
        let after = String(repeating: "ipsum lorem ", count: 5) + "omega"
        XCTAssertTrue(LexiconCapture.spans(before: before, after: after).isEmpty)
    }

    // MARK: end to end

    func testACorrectionInAFieldIsCaptured() {
        XCTAssertEqual(
            LexiconCapture.spans(before: "let's use pearly", after: "let's use Parley"),
            [span("pearly", "Parley")])
    }

    func testAWordIsCapturedWholeRatherThanCutAtTheSharedEdges() {
        // A character-level trim would hand the diff "pearl" against "Parle" —
        // a pair that can never match, because a Latin original only applies
        // on a word boundary.
        let spans = LexiconCapture.spans(before: "we use pearly", after: "we use Parley")
        XCTAssertEqual(spans.map(\.original), ["pearly"])
        XCTAssertEqual(spans.map(\.replacement), ["Parley"])
    }

    func testACJKCorrectionIsCapturedAtTwoCharacters() {
        XCTAssertEqual(
            LexiconCapture.spans(before: "明天我在來一次好嗎", after: "明天我再來一次好嗎"),
            [span("在來", "再來")])
    }

    func testPaisiToPasiStaysTwoCharactersAndLeavesPartiesAlone() {
        let spans = LexiconCapture.spans(before: "我們派斯的產品很好", after: "我們帕斯的產品很好")
        XCTAssertEqual(spans, [span("派斯", "帕斯")])

        var lexicon = Lexicon()
        for _ in 0..<Lexicon.autoApplyThreshold {
            for span in spans { lexicon.record(original: span.original, replacement: span.replacement) }
        }
        XCTAssertEqual(lexicon.apply(to: "派斯辦了派對"), "帕斯辦了派對")
    }

    func testPasuosiToPaisiIsLearnedWhole() {
        XCTAssertEqual(
            LexiconCapture.spans(before: "我們用帕索斯的產品", after: "我們用派斯的產品"),
            [span("帕索斯", "派斯")])
    }

    func testTypingOnAfterDictatingTeachesNothing() {
        let outcome = LexiconCapture.harvest(
            before: Window(before: "meeting at three", after: nil),
            after: Window(before: "meeting at three tomorrow", after: nil))
        XCTAssertEqual(outcome.learned, [])
        XCTAssertEqual(outcome.refusals, [.insertion])
    }

    func testAFieldTheUserRetypedTeachesNothing() {
        XCTAssertTrue(
            LexiconCapture.spans(before: "meeting at three", after: "never mind").isEmpty)
    }
}
