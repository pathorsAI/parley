import XCTest

@testable import ParleyKit

/// Which failures are worth redialling. Everything the service can say is a
/// reconnect except the refusal that would simply be repeated.
final class SttRelayEventTests: XCTestCase {
    func testQuotaRefusalIsNotWorthRedialling() {
        let event = SttRelayEvent.error("stream error quota_exceeded", code: "quota_exceeded")
        XCTAssertTrue(event.isQuotaExceeded)
    }

    func testOtherFailuresAreOrdinaryDrops() {
        XCTAssertFalse(
            SttRelayEvent.error("stream error upstream_unavailable", code: "upstream_unavailable")
                .isQuotaExceeded)
        XCTAssertFalse(SttRelayEvent.error("socket died").isQuotaExceeded)
        XCTAssertFalse(SttRelayEvent.closed(reason: "close code=1006 ").isQuotaExceeded)
    }

    /// The parser's `error` frame is where the code comes from, so the two
    /// have to agree on the string.
    func testStreamErrorCarriesTheCodeTheEventChecksFor() {
        let parser = ParleyStreamParser { _ in }
        XCTAssertThrowsError(
            try parser.process(
                #"{"type":"error","code":"quota_exceeded","message":"Transcription quota exceeded."}"#)
        ) { error in
            XCTAssertEqual(
                (error as? ParleyStreamError)?.code, SttRelayEvent.quotaExceededCode)
        }
    }

    /// A close in the protocol's range is the same refusal without the frame.
    func testQuotaCloseCodeMapsToTheQuotaError() {
        XCTAssertEqual(
            ParleyStreamProtocol.errorCode(forClose: 4402), SttRelayEvent.quotaExceededCode)
        XCTAssertEqual(ParleyStreamProtocol.errorCode(forClose: 4400), "bad_request")
        XCTAssertEqual(ParleyStreamProtocol.errorCode(forClose: 4408), "idle_timeout")
        XCTAssertNil(ParleyStreamProtocol.errorCode(forClose: 1000))
        XCTAssertNil(ParleyStreamProtocol.errorCode(forClose: 1011))
    }
}
