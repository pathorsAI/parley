import ParleyKit
import XCTest

final class DeleteRepeatTests: XCTestCase {
    /// When repeat `n` fires, measured from touch-down.
    private func time(ofRepeat n: Int) -> TimeInterval {
        (1...n).reduce(0) { $0 + DeleteRepeat.delay(beforeRepeat: $1) }
    }

    func testTheFirstRepeatWaitsHalfASecond() {
        XCTAssertEqual(DeleteRepeat.delay(beforeRepeat: 1), 0.5)
    }

    func testRepeatsRunAtATenthForTheFirstSecondThenTwiceAsFast() {
        for n in 2...10 { XCTAssertEqual(DeleteRepeat.delay(beforeRepeat: n), 0.1, "repeat \(n)") }
        for n in 11...20 { XCTAssertEqual(DeleteRepeat.delay(beforeRepeat: n), 0.05, "repeat \(n)") }
        XCTAssertEqual(time(ofRepeat: 10), 1.4, accuracy: 1e-9)
        XCTAssertEqual(time(ofRepeat: 20), 1.9, accuracy: 1e-9)
    }

    func testAfterTwentyCharactersEveryRepeatTakesAWord() {
        for n in 1...20 { XCTAssertEqual(DeleteRepeat.unit(forRepeat: n), .character) }
        for n in 21...40 {
            XCTAssertEqual(DeleteRepeat.unit(forRepeat: n), .word)
            XCTAssertEqual(DeleteRepeat.delay(beforeRepeat: n), 0.1)
        }
        XCTAssertEqual(time(ofRepeat: 21), 2.0, accuracy: 1e-9)
    }

    func testAWordTakesItsTrailingSpaceAndPunctuation() {
        XCTAssertEqual(DeleteRepeat.wordLength(before: "Hello, world. "), "world. ".count)
        XCTAssertEqual(DeleteRepeat.wordLength(before: "Hello, "), "Hello, ".count)
        XCTAssertEqual(DeleteRepeat.wordLength(before: "the quick"), "quick".count)
        XCTAssertEqual(DeleteRepeat.wordLength(before: "the quick   "), "quick   ".count)
        XCTAssertEqual(DeleteRepeat.wordLength(before: "wait..."), "wait...".count)
    }

    func testAnApostropheInsideAWordIsPartOfIt() {
        XCTAssertEqual(DeleteRepeat.wordLength(before: "I don't"), "don't".count)
        XCTAssertEqual(DeleteRepeat.wordLength(before: "I don\u{2019}t"), 5)
        // A closing quote after a word is punctuation, not part of it.
        XCTAssertEqual(DeleteRepeat.wordLength(before: "say 'hi'"), "hi'".count)
    }

    func testALineBreakIsItsOwnUnit() {
        XCTAssertEqual(DeleteRepeat.wordLength(before: "first line\n"), 1)
        XCTAssertEqual(DeleteRepeat.wordLength(before: "first\nsecond"), "second".count)
        XCTAssertEqual(DeleteRepeat.wordLength(before: "first\n  "), 2)
    }

    func testHanIsTakenTwoCharactersAtATime() {
        XCTAssertEqual(DeleteRepeat.wordLength(before: "今天我們開會"), 2)
        XCTAssertEqual(DeleteRepeat.wordLength(before: "我們開會，"), 3)
        XCTAssertEqual(DeleteRepeat.wordLength(before: "好"), 1)
        // A Latin word stops at the Han before it, and the other way round.
        XCTAssertEqual(DeleteRepeat.wordLength(before: "用Parley"), "Parley".count)
        XCTAssertEqual(DeleteRepeat.wordLength(before: "Parley好用"), 2)
    }

    func testNoContextStillDeletesOneCharacter() {
        XCTAssertEqual(DeleteRepeat.wordLength(before: nil), 1)
        XCTAssertEqual(DeleteRepeat.wordLength(before: ""), 1)
        XCTAssertEqual(DeleteRepeat.wordLength(before: "   "), 3)
        XCTAssertEqual(DeleteRepeat.wordLength(before: "🙂🙂"), 2)
    }
}
