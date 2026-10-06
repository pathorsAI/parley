import XCTest

@testable import ParleyKit

/// The pass as the cloud sees it: once per recording, written down the moment
/// it exists, and written against a fresh copy of the meta.
final class FilingPassTests: XCTestCase {

    override func tearDown() {
        FilingStubProtocol.handler = nil
        FilingStubProtocol.requests = []
        super.tearDown()
    }

    private func stubbedCloud() -> CloudClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FilingStubProtocol.self]
        return CloudClient(
            baseURL: URL(string: "https://example.test")!,
            session: URLSession(configuration: config),
            tokenProvider: { "token" })
    }

    private func json(_ obj: Any) -> Data {
        try! JSONSerialization.data(withJSONObject: obj)
    }

    private func meta(title: String = "Meeting Sep 7, 3:20 PM", extra: [String: Any] = [:])
        -> [String: Any]
    {
        var raw: [String: Any] = [
            "id": "r-1", "title": title, "source": "live", "createdAt": 1_000.0,
            "durationMs": 60_000.0, "audio": "audio.ogg", "folderId": NSNull(),
            "speakerNames": ["mix-1": "Mei"], "meetingContext": "Acme renewal",
            "segments": [
                [
                    "id": "s1", "source": "mix", "speaker": 1, "text": "Let's talk renewal.",
                    "isFinal": true, "startMs": 0.0, "endMs": 1_000.0,
                ]
            ],
        ]
        for (k, v) in extra { raw[k] = v }
        return raw
    }

    private func chatReply(_ content: String) -> Data {
        json(["choices": [["message": ["content": content]]]])
    }

    /// Another device already spent the pass: nothing is asked of the model,
    /// and the suggestion it left pending is what comes back.
    func testARecordingAlreadySuggestedIsNotAskedAgain() async {
        let pending: [String: Any] = [
            "title": "Acme renewal terms",
            "folders": [["folderId": NSNull(), "name": "Acme", "reason": "customer"]],
        ]
        FilingStubProtocol.handler = { [self] request in
            let path = request.url!.path
            if path.hasSuffix("/meta") {
                return (200, json(meta(extra: ["filingSuggested": true, "filingSuggestion": pending])))
            }
            XCTFail("unexpected request \(request.httpMethod ?? "") \(path)")
            return (500, Data())
        }
        let result = await FilingPass().run(id: "r-1", cloud: stubbedCloud(), language: .english)
        XCTAssertEqual(result?.title, "Acme renewal terms")
        XCTAssertEqual(result?.folders.map(\.name), ["Acme"])
    }

    /// A fresh pass reads the meta (speaker names, meeting context), asks once,
    /// re-reads the meta and pushes the suggestion into THAT copy — so a rename
    /// that landed meanwhile survives, and the summary carries it too.
    func testAFreshPassIsPersistedIntoAFreshReadOfTheMeta() async throws {
        var metaReads = 0
        FilingStubProtocol.handler = { [self] request in
            let path = request.url!.path
            switch (request.httpMethod ?? "GET", path) {
            case ("GET", "/recordings/r-1/meta"):
                metaReads += 1
                // The second read sees a rename that landed while the model ran.
                return (200, json(meta(title: metaReads == 1 ? "Meeting Sep 7, 3:20 PM" : "Renamed on Mac")))
            case ("GET", "/folders"):
                return (
                    200,
                    json([
                        "folders": [
                            ["id": "f-acme", "name": "Acme Corp", "orgId": NSNull()],
                            ["id": "f-org", "name": "Shared", "orgId": "org-1"],
                        ]
                    ]))
            case ("POST", "/v1/chat/completions"):
                return (
                    200,
                    chatReply(
                        #"{"title":"Acme renewal terms","folders":[{"name":"acme corp","isNew":false,"reason":"customer"}]}"#
                    ))
            case ("POST", "/recordings/r-1"):
                return (200, json(["ok": true]))
            default:
                XCTFail("unexpected request \(request.httpMethod ?? "") \(path)")
                return (500, Data())
            }
        }

        let result = await FilingPass().run(id: "r-1", cloud: stubbedCloud(), language: .traditionalChinese)
        XCTAssertEqual(result?.title, "Acme renewal terms")
        XCTAssertEqual(result?.folders, [FilingFolderSuggestion(folderId: "f-acme", name: "Acme Corp", reason: "customer")])

        // The model was given the meta's context, names and the shared prompt.
        let chat = try XCTUnwrap(FilingStubProtocol.requests.first { $0.url!.path == "/v1/chat/completions" })
        let chatBody = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: chat.body) as? [String: Any])
        let messages = try XCTUnwrap(chatBody["messages"] as? [[String: Any]])
        XCTAssertEqual(
            messages[0]["content"] as? String,
            FilingSuggester.systemPrompt(language: .traditionalChinese))
        let user = try XCTUnwrap(messages[1]["content"] as? String)
        XCTAssertTrue(user.hasPrefix(FilingPrompt.meetingContextPrefix + "Acme renewal\n\n"))
        XCTAssertTrue(user.contains("- Acme Corp"))
        XCTAssertFalse(user.contains("Shared"), "org folders are not filing targets")
        XCTAssertTrue(user.hasSuffix("[0:00] [Mei] Let's talk renewal."))

        // Persisted into the second read, title and all.
        let push = try XCTUnwrap(FilingStubProtocol.requests.first { $0.httpMethod == "POST" && $0.url!.path == "/recordings/r-1" })
        let pushBody = try XCTUnwrap(try JSONSerialization.jsonObject(with: push.body) as? [String: Any])
        let pushedMeta = try XCTUnwrap(pushBody["meta"] as? [String: Any])
        let pushedSummary = try XCTUnwrap(pushBody["summary"] as? [String: Any])
        XCTAssertEqual(pushedMeta["title"] as? String, "Renamed on Mac")
        XCTAssertEqual(pushedSummary["title"] as? String, "Renamed on Mac")
        XCTAssertEqual(pushedMeta["filingSuggested"] as? Bool, true)
        let suggestion = try XCTUnwrap(pushedMeta["filingSuggestion"] as? [String: Any])
        XCTAssertEqual(suggestion["title"] as? String, "Acme renewal terms")
        let folders = try XCTUnwrap(suggestion["folders"] as? [[String: Any]])
        XCTAssertEqual(folders.first?["folderId"] as? String, "f-acme")
        XCTAssertEqual(folders.first?["name"] as? String, "Acme Corp")
        XCTAssertEqual(folders.first?["reason"] as? String, "customer")
        XCTAssertEqual(metaReads, 2)
    }

    /// Another device finished first while the model was thinking: its answer
    /// is the synced one, so nothing is pushed over it.
    func testAPassThatLosesTheRaceDoesNotPush() async {
        var metaReads = 0
        FilingStubProtocol.handler = { [self] request in
            switch (request.httpMethod ?? "GET", request.url!.path) {
            case ("GET", "/recordings/r-1/meta"):
                metaReads += 1
                if metaReads == 1 { return (200, json(meta())) }
                return (
                    200,
                    json(meta(extra: [
                        "filingSuggested": true,
                        "filingSuggestion": ["title": "From the Mac", "folders": []],
                    ])))
            case ("GET", "/folders"):
                return (200, json(["folders": []]))
            case ("POST", "/v1/chat/completions"):
                return (200, chatReply(#"{"title":"From the phone","folders":[]}"#))
            default:
                XCTFail("unexpected request \(request.httpMethod ?? "") \(request.url!.path)")
                return (500, Data())
            }
        }
        let result = await FilingPass().run(id: "r-1", cloud: stubbedCloud(), language: .english)
        XCTAssertEqual(result?.title, "From the Mac")
    }

    // MARK: the summary pushed beside a meta

    func testTheSummaryIsProjectedFromTheMeta() {
        let meta = RecordingMeta(raw: meta(
            title: "Acme renewal terms",
            extra: ["folderId": "f-acme", "findings": [["title": "x"]], "actionItems": [[:], [:]]]))
        let stale = CloudRecordingSummary(
            id: "r-1", title: "Meeting Sep 7, 3:20 PM", source: "live", createdAt: 1_000,
            durationMs: 10, speakerCount: 1, findingsCount: 0, actionItemsCount: 0,
            hasAudio: true, snippet: "", folderId: nil, updatedAt: 5)
        let summary = CloudRecordingSummary(projecting: meta, fallback: stale)
        XCTAssertEqual(summary.title, "Acme renewal terms", "the meta's title, never the stale row's")
        XCTAssertEqual(summary.folderId, "f-acme")
        XCTAssertEqual(summary.findingsCount, 1)
        XCTAssertEqual(summary.actionItemsCount, 2)
        XCTAssertEqual(summary.speakerCount, 1)
        XCTAssertEqual(summary.snippet, "Let's talk renewal.")
        XCTAssertTrue(summary.hasAudio)
        XCTAssertEqual(summary.durationMs, 60_000)
        XCTAssertNil(summary.updatedAt)

        // A meta with no folder files at the root even if the row said otherwise.
        var unfiled = meta
        unfiled.folderId = nil
        var filedRow = stale
        filedRow.folderId = "f-old"
        XCTAssertNil(CloudRecordingSummary(projecting: unfiled, fallback: filedRow).folderId)
    }
}

/// Records every request (with its body, which `URLProtocol` only exposes as a
/// stream) and answers it with `handler`.
private final class FilingStubProtocol: URLProtocol {
    struct Seen {
        let url: URL?
        let httpMethod: String?
        let body: Data
    }

    nonisolated(unsafe) static var handler: ((URLRequest) -> (Int, Data))?
    nonisolated(unsafe) static var requests: [Seen] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                body.append(buffer, count: n)
            }
            stream.close()
        }
        Self.requests.append(Seen(url: request.url, httpMethod: request.httpMethod, body: body))
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.unknown))
            return
        }
        let (status, data) = handler(request)
        let response = HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
