import XCTest

@testable import ParleyKit

final class QuickRecordTests: XCTestCase {
    func testRecognizesItsOwnURL() {
        XCTAssertTrue(QuickRecord.isRequest(QuickRecord.url))
    }

    func testDoesNotClaimTheOtherParleyURLs() {
        // The keyboard's start request, the Live Activity's bare open and the
        // auth callback all share the scheme and must fall through to their
        // own handlers.
        XCTAssertFalse(QuickRecord.isRequest(DictationChannel.startURL(session: "s1")))
        XCTAssertFalse(QuickRecord.isRequest(DictationChannel.appURL))
        XCTAssertFalse(QuickRecord.isRequest(URL(string: "parley://auth/cb?token=x")!))
        XCTAssertFalse(QuickRecord.isRequest(URL(string: "https://record")!))
    }

    func testDictationDoesNotClaimIt() {
        XCTAssertNil(DictationChannel.session(fromStart: QuickRecord.url))
    }

    func testFreshnessWindow() {
        let t = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertTrue(QuickRecord.isFresh(requestedAt: t, now: t))
        XCTAssertTrue(QuickRecord.isFresh(requestedAt: t, now: t.addingTimeInterval(QuickRecord.freshness)))
        XCTAssertFalse(QuickRecord.isFresh(requestedAt: t, now: t.addingTimeInterval(QuickRecord.freshness + 1)))
        // A clock that went backwards is not a fresh request.
        XCTAssertFalse(QuickRecord.isFresh(requestedAt: t, now: t.addingTimeInterval(-1)))
    }
}
