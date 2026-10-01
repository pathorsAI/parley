import XCTest

@testable import ParleyKit

/// When the voice keyboard's strip says "Tap text to copy", and how the
/// sessions that showed it are counted and kept.
final class CopyHintTests: XCTestCase {
    func testAFreshKeyboardOffersTheHint() {
        XCTAssertTrue(CopyHint.offers(in: "a", CopyHint.State()))
    }

    func testNoSessionIdIsNoHint() {
        XCTAssertFalse(CopyHint.offers(in: "", CopyHint.State()))
        XCTAssertEqual(CopyHint.shown(in: "", CopyHint.State()), CopyHint.State())
    }

    func testASessionCountsOnceHoweverOftenItIsShown() {
        var state = CopyHint.State()
        for _ in 0..<5 { state = CopyHint.shown(in: "a", state) }
        XCTAssertEqual(state.countedSessions, 1)
        XCTAssertEqual(state.lastCountedSession, "a")
    }

    func testTheHintStopsAfterThreeSessions() {
        var state = CopyHint.State()
        for session in ["a", "b", "c"] {
            XCTAssertTrue(CopyHint.offers(in: session, state))
            state = CopyHint.shown(in: session, state)
        }
        XCTAssertEqual(state.countedSessions, CopyHint.sessionLimit)
        XCTAssertFalse(CopyHint.offers(in: "d", state))
        // And a fourth session that is shown anyway does not count.
        XCTAssertEqual(CopyHint.shown(in: "d", state), state)
    }

    func testTheSessionThatReachesTheLimitKeepsItsHint() {
        var state = CopyHint.State()
        for session in ["a", "b", "c"] { state = CopyHint.shown(in: session, state) }
        // A republish of the third session, or the keyboard rebuilt on the
        // next appearance, must not take the hint away mid-session.
        XCTAssertTrue(CopyHint.offers(in: "c", state))
        XCTAssertEqual(CopyHint.shown(in: "c", state), state)
    }

    func testASessionWhoseHintNeverShowedDoesNotCount() {
        // The narrow-phone case: the keyboard only calls `shown` when the hint
        // was drawn, so offering alone changes nothing.
        let state = CopyHint.State()
        _ = CopyHint.offers(in: "a", state)
        XCTAssertEqual(state.countedSessions, 0)
    }

    func testOneCopyRetiresTheHint() {
        let state = CopyHint.copied(CopyHint.shown(in: "a", CopyHint.State()))
        XCTAssertTrue(state.hasCopied)
        XCTAssertFalse(CopyHint.offers(in: "a", state))
        XCTAssertFalse(CopyHint.offers(in: "b", state))
        XCTAssertEqual(CopyHint.shown(in: "b", state), state)
    }

    func testACopyBeforeTheHintWasEverShownRetiresItToo() {
        XCTAssertFalse(CopyHint.offers(in: "a", CopyHint.copied(CopyHint.State())))
    }

    func testOutOfRangeCountsAreClamped() {
        XCTAssertEqual(CopyHint.State(countedSessions: -4).countedSessions, 0)
        XCTAssertEqual(CopyHint.State(countedSessions: 99).countedSessions, CopyHint.sessionLimit)
    }
}

/// `CopyHintLedger` against a scratch `UserDefaults` suite.
final class CopyHintLedgerTests: XCTestCase {
    private var suiteName = ""
    private var defaults: UserDefaults!
    private var ledger: CopyHintLedger!

    override func setUp() {
        super.setUp()
        suiteName = "CopyHintLedgerTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        ledger = CopyHintLedger(defaults: defaults)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    func testAnEmptyStoreReadsAsFresh() {
        XCTAssertEqual(ledger.read(), CopyHint.State())
    }

    func testNoStoreReadsAsFresh() {
        XCTAssertEqual(CopyHintLedger(defaults: nil).read(), CopyHint.State())
    }

    func testWhatIsWrittenIsReadBack() {
        let state = CopyHint.State(countedSessions: 2, lastCountedSession: "b", hasCopied: true)
        ledger.write(state)
        XCTAssertEqual(ledger.read(), state)
    }

    func testANegativeCountReadsAsNone() {
        defaults.set(-7, forKey: CopyHintLedger.countKey)
        XCTAssertEqual(ledger.read().countedSessions, 0)
    }

    func testAnOversizedCountReadsAsTheLimit() {
        defaults.set(Int.max, forKey: CopyHintLedger.countKey)
        XCTAssertEqual(ledger.read().countedSessions, CopyHint.sessionLimit)
    }

    func testACountThatIsNotAWholeNumberReadsAsNone() {
        for junk: Any in ["3", 2.5, true, Double.nan, ["x"], Data([1])] {
            defaults.set(junk, forKey: CopyHintLedger.countKey)
            XCTAssertEqual(ledger.read().countedSessions, 0, "\(junk)")
        }
    }

    func testAFlagThatIsNotABooleanReadsAsFalse() {
        for junk: Any in [1, "true", ["x"]] {
            defaults.set(junk, forKey: CopyHintLedger.copiedKey)
            XCTAssertFalse(ledger.read().hasCopied, "\(junk)")
        }
    }

    func testASessionIdThatIsNotAShortStringIsDropped() {
        defaults.set(42, forKey: CopyHintLedger.lastSessionKey)
        XCTAssertNil(ledger.read().lastCountedSession)
        defaults.set("", forKey: CopyHintLedger.lastSessionKey)
        XCTAssertNil(ledger.read().lastCountedSession)
        defaults.set(String(repeating: "x", count: 500), forKey: CopyHintLedger.lastSessionKey)
        XCTAssertNil(ledger.read().lastCountedSession)
    }

    func testResetForgetsEverything() {
        ledger.write(CopyHint.State(countedSessions: 3, lastCountedSession: "c", hasCopied: true))
        ledger.reset()
        XCTAssertEqual(ledger.read(), CopyHint.State())
    }

    /// The whole life of the hint through the store, as the keyboard drives it:
    /// a fresh controller reads the ledger on every appearance.
    func testThreeSessionsThroughTheStore() {
        for session in ["a", "a", "b", "c", "c", "d"] {
            let state = ledger.read()
            if CopyHint.offers(in: session, state) {
                ledger.write(CopyHint.shown(in: session, state))
            }
        }
        XCTAssertEqual(ledger.read().countedSessions, 3)
        XCTAssertEqual(ledger.read().lastCountedSession, "c")
        XCTAssertFalse(CopyHint.offers(in: "d", ledger.read()))
    }
}
