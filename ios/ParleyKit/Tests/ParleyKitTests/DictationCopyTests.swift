import XCTest

@testable import ParleyKit

/// When a tap on the voice keyboard's transcript slot copies, and what.
final class DictationCopyTests: XCTestCase {
    private let sentence = "嗨 Anna，跟你說一聲我的新電話號碼是 0912345678，之後再聊！"

    func testDoneCopiesTheWholeCommittedText() {
        XCTAssertEqual(
            DictationCopy.text(for: .done, committed: sentence, hasFullAccess: true), sentence)
    }

    func testErrorWithSettledTextCopiesIt() {
        // The case the feature is for: nothing was inserted, and these words
        // exist nowhere else.
        XCTAssertEqual(
            DictationCopy.text(for: .error, committed: sentence, hasFullAccess: true), sentence)
    }

    func testErrorBeforeAnyWordSettledIsNotACopyTarget() {
        XCTAssertNil(DictationCopy.text(for: .error, committed: "", hasFullAccess: true))
        XCTAssertNil(DictationCopy.text(for: .error, committed: " \n ", hasFullAccess: true))
    }

    func testAnEmptyDoneIsNotACopyTarget() {
        XCTAssertNil(DictationCopy.text(for: .done, committed: "", hasFullAccess: true))
    }

    func testNothingIsCopyableWhileTheSessionIsStillMoving() {
        for state: DictationChannel.Downlink.State in [
            .starting, .listening, .reconnecting, .finishing,
        ] {
            XCTAssertNil(
                DictationCopy.text(for: state, committed: sentence, hasFullAccess: true),
                "\(state) must not offer a copy")
        }
    }

    func testCancelledAndMicTakenAreNotCopyTargets() {
        // Cancelled: the pane was cleared on purpose. Mic taken: the notice
        // has the slot, and the session may still resume.
        XCTAssertNil(DictationCopy.text(for: .cancelled, committed: sentence, hasFullAccess: true))
        XCTAssertNil(DictationCopy.text(for: .micTaken, committed: sentence, hasFullAccess: true))
    }

    func testEveryStateIsDecided() {
        // A state added later must be placed on purpose; this keeps the two
        // copyable ones the only ones.
        let copyable = DictationChannel.Downlink.State.allCases.filter {
            DictationCopy.text(for: $0, committed: sentence, hasFullAccess: true) != nil
        }
        XCTAssertEqual(Set(copyable), [.done, .error])
    }

    func testWithoutFullAccessNothingIsCopyable() {
        XCTAssertNil(DictationCopy.text(for: .done, committed: sentence, hasFullAccess: false))
        XCTAssertNil(DictationCopy.text(for: .error, committed: sentence, hasFullAccess: false))
    }

    func testLongTextIsCopiedWholeNotTruncatedToTheSlotsTail() {
        // Well past the keyboard's 400-character echo.
        let long = String(repeating: "這是一段很長的聽寫內容，", count: 120)
        XCTAssertGreaterThan(long.count, 1_000)
        let copied = DictationCopy.text(for: .done, committed: long, hasFullAccess: true)
        XCTAssertEqual(copied, long)
        XCTAssertEqual(copied?.count, long.count)
    }

    func testTextIsCopiedAsDeliveredWithoutTrimming() {
        // Exactly what was inserted, including the whitespace the app put
        // there — the check for emptiness must not reshape the text.
        let delivered = "Talk soon! \n"
        XCTAssertEqual(
            DictationCopy.text(for: .done, committed: delivered, hasFullAccess: true), delivered)
    }
}
