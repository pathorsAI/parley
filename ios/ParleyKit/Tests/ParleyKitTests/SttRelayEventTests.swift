import XCTest

@testable import ParleyKit

/// Which failures are worth redialling. Everything the relay can say is a
/// reconnect except the refusal that would simply be repeated.
final class SttRelayEventTests: XCTestCase {
    func testQuotaRefusalIsNotWorthRedialling() {
        let event = SttRelayEvent.error("relay error 402: out of quota", code: 402)
        XCTAssertTrue(event.isQuotaExceeded)
    }

    func testOtherFailuresAreOrdinaryDrops() {
        XCTAssertFalse(SttRelayEvent.error("relay error 500: upstream", code: 500).isQuotaExceeded)
        XCTAssertFalse(SttRelayEvent.error("socket died").isQuotaExceeded)
        XCTAssertFalse(SttRelayEvent.closed(reason: "close code=1006 ").isQuotaExceeded)
    }

    /// The parser's in-band error frame is where the code comes from, so the
    /// two have to agree on the number.
    func testStreamErrorCarriesTheCodeTheEventChecksFor() {
        let parser = SonioxStreamParser { _ in }
        XCTAssertThrowsError(
            try parser.process(#"{"error_code":402,"error_message":"out of quota"}"#)
        ) { error in
            XCTAssertEqual(
                (error as? SonioxStreamError)?.code, SttRelayEvent.quotaExceededCode)
        }
    }
}
