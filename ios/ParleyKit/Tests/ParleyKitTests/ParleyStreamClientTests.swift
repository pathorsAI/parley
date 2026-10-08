import XCTest

@testable import ParleyKit

final class ParleyStreamClientTests: XCTestCase {
    private let unroutableStream = URL(string: "wss://127.0.0.1:9/stt/v2/stream")!

    func testACancelledClientRefusesToStart() async {
        let client = ParleyStreamClient(
            options: .init(streamURL: unroutableStream, bearerToken: "t")
        ) { _ in }
        client.cancel()
        do {
            try await client.start()
            XCTFail("started a socket after cancel()")
        } catch {
            XCTAssertTrue(error is ParleyStreamClient.Spent, "threw \(error) instead of Spent")
        }
    }

    func testTheStreamURLIsTheCloudHostOverWebSocket() {
        XCTAssertEqual(
            ParleyStreamClient.streamURL().absoluteString, "wss://api.parley.tw/stt/v2/stream")
        XCTAssertEqual(
            ParleyStreamClient.streamURL(base: URL(string: "http://localhost:8787")!)
                .absoluteString,
            "ws://localhost:8787/stt/v2/stream")
    }

    func testOptionsDescribeTheStartFrame() throws {
        let options = ParleyStreamClient.Options(
            bearerToken: "t", languages: ["zh", "en"], vocabulary: [" Parley ", "派斯", ""])
        let object = try JSONSerialization.jsonObject(
            with: Data(try options.startFrame.encoded().utf8)) as? [String: Any]
        XCTAssertEqual(object?["type"] as? String, "start")
        XCTAssertEqual(object?["languages"] as? [String], ["zh", "en"])
        XCTAssertEqual(object?["diarization"] as? Bool, true)
        XCTAssertEqual(object?["endpointing"] as? Bool, true)
        XCTAssertEqual((object?["hints"] as? [String: Any])?["terms"] as? [String], ["Parley", "派斯"])
    }

    func testOnlyA402RejectionIsTheQuota() {
        XCTAssertTrue(ParleyStreamClient.Rejected(status: 402).isQuotaExceeded)
        for status in [401, 426, 429, 500] {
            XCTAssertFalse(ParleyStreamClient.Rejected(status: status).isQuotaExceeded)
        }
    }

    func testBatchTermsRideAsRepeatedQueryItems() {
        let items = CloudClient.batchTermsQuery([" Parley ", "派斯", "Parley", "a,b", ""])
        XCTAssertEqual(items.map(\.name), ["terms", "terms"])
        XCTAssertEqual(items.map(\.value), ["Parley", "派斯"])
        XCTAssertTrue(CloudClient.batchTermsQuery([]).isEmpty)
    }

    func testTheBatchTranscriptIsAskedForInParleysShape() {
        XCTAssertEqual(BatchTranscriptResponse.format, "parley")
    }
}
