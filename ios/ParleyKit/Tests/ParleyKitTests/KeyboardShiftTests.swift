import ParleyKit
import XCTest

final class AutoCapitalizationTests: XCTestCase {
    private func caps(_ context: String?, _ mode: AutoCapitalization.Mode = .sentences) -> Bool {
        AutoCapitalization.capitalizesNext(after: context, mode: mode)
    }

    func testSentencesCapitaliseTheStartOfAField() {
        XCTAssertTrue(caps(nil))
        XCTAssertTrue(caps(""))
        XCTAssertTrue(caps("   "))
    }

    func testSentencesCapitaliseAfterAnEnderAndASpace() {
        XCTAssertTrue(caps("Hi. "))
        XCTAssertTrue(caps("Really? "))
        XCTAssertTrue(caps("Wow!  "))
        XCTAssertTrue(caps("He said \"hi.\" "))
        XCTAssertTrue(caps("(Done.) "))
        // Like the system keyboard, no list of abbreviations.
        XCTAssertTrue(caps("e.g. "))
    }

    func testSentencesDoNotCapitaliseWithoutTheSpace() {
        XCTAssertFalse(caps("Hi."))
        XCTAssertFalse(caps("3.14"))
        XCTAssertFalse(caps("parley.app"))
    }

    func testSentencesDoNotCapitaliseMidSentence() {
        XCTAssertFalse(caps("hi "))
        XCTAssertFalse(caps("Hi"))
        XCTAssertFalse(caps("one, "))
        XCTAssertFalse(caps("well \"quoted\" "))
    }

    func testALineBreakStartsASentence() {
        XCTAssertTrue(caps("Hi\n"))
        XCTAssertTrue(caps("Hi\n  "))
        XCTAssertTrue(caps("no full stop\n"))
    }

    func testFullWidthEndersNeedNoSpace() {
        XCTAssertTrue(caps("好。"))
        XCTAssertTrue(caps("真的？"))
        XCTAssertTrue(caps("好。 "))
        XCTAssertFalse(caps("好，"))
    }

    func testWordsCapitaliseAfterAnyWhitespace() {
        XCTAssertTrue(caps("", .words))
        XCTAssertTrue(caps("Hi ", .words))
        XCTAssertTrue(caps("Hi\n", .words))
        XCTAssertFalse(caps("Hi", .words))
        XCTAssertFalse(caps("Hi.", .words))
    }

    func testNoneNeverAndAllCharactersAlways() {
        for context in ["", "Hi. ", "hi", "Hi\n"] {
            XCTAssertFalse(caps(context, .none))
            XCTAssertTrue(caps(context, .allCharacters))
        }
    }
}

final class ShiftLatchTests: XCTestCase {
    private let t0 = Date(timeIntervalSinceReferenceDate: 1000)

    func testATapTogglesOneShot() {
        var shift = ShiftLatch()
        shift.tap(at: t0)
        XCTAssertEqual(shift.state, .oneShot)
        shift.tap(at: t0 + 1)
        XCTAssertEqual(shift.state, .off)
    }

    func testTwoQuickTapsLockAndATapUnlocks() {
        var shift = ShiftLatch()
        shift.tap(at: t0)
        shift.tap(at: t0 + 0.2)
        XCTAssertEqual(shift.state, .locked)
        // A third quick tap is not another double: it turns the lock off.
        shift.tap(at: t0 + 0.35)
        XCTAssertEqual(shift.state, .off)
    }

    func testAQuickDoubleTapOnAnAutoArmedShiftStillLocks() {
        var shift = ShiftLatch()
        shift.settle(capitalize: true)
        shift.tap(at: t0)
        XCTAssertEqual(shift.state, .off)
        shift.tap(at: t0 + 0.2)
        XCTAssertEqual(shift.state, .locked)
    }

    func testSettleFollowsTheRuleButNeverTouchesALock() {
        var shift = ShiftLatch()
        shift.settle(capitalize: true)
        XCTAssertEqual(shift.state, .oneShot)
        // The letter it capitalised was typed: the rule now says no.
        shift.settle(capitalize: false)
        XCTAssertEqual(shift.state, .off)

        var locked = ShiftLatch(state: .locked)
        locked.settle(capitalize: false)
        XCTAssertEqual(locked.state, .locked)
    }

    func testOpeningTheSymbolsDropsOnlyAOneShot() {
        var shift = ShiftLatch(state: .oneShot)
        shift.dropOneShot()
        XCTAssertEqual(shift.state, .off)
        var locked = ShiftLatch(state: .locked)
        locked.dropOneShot()
        XCTAssertEqual(locked.state, .locked)
    }
}
