import XCTest

@testable import ParleyKit

final class SttRelayClientTests: XCTestCase {
    private let unroutableRelay = URL(string: "wss://127.0.0.1:9/stt/stream")!

    func testACancelledClientRefusesToStart() async {
        let client = SttRelayClient(
            options: .init(relayURL: unroutableRelay, bearerToken: "t")
        ) { _ in }
        client.cancel()
        do {
            try await client.start()
            XCTFail("started a socket after cancel()")
        } catch {
            XCTAssertTrue(error is SttRelayClient.Spent, "threw \(error) instead of Spent")
        }
    }
}
