import XCTest

@testable import ParleyKit

/// The folder calls the Library's chip row makes — create, rename, delete, in
/// both scopes — as the cloud sees them: the method, the path, and the body the
/// server reads. And a refusal has to reach the caller as a 403, because the
/// Library words "you may not" differently from "it failed".
final class FolderManagementTests: XCTestCase {

    override func tearDown() {
        FolderStubProtocol.handler = nil
        FolderStubProtocol.requests = []
        super.tearDown()
    }

    private func stubbedCloud() -> CloudClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FolderStubProtocol.self]
        return CloudClient(
            baseURL: URL(string: "https://example.test")!,
            session: URLSession(configuration: config),
            tokenProvider: { "token" })
    }

    private func json(_ obj: Any) -> Data {
        try! JSONSerialization.data(withJSONObject: obj)
    }

    private func body(_ seen: FolderStubProtocol.Seen) -> [String: Any]? {
        try? JSONSerialization.jsonObject(with: seen.body) as? [String: Any]
    }

    private func answerOK() {
        FolderStubProtocol.handler = { [self] _ in (200, json(["ok": true])) }
    }

    // MARK: personal

    func testRenamingAPersonalFolderPatchesItsName() async throws {
        answerOK()
        try await stubbedCloud().renameFolder(id: "f-1", name: "Acme")
        let seen = try XCTUnwrap(FolderStubProtocol.requests.only)
        XCTAssertEqual(seen.httpMethod, "PATCH")
        XCTAssertEqual(seen.url?.path, "/folders/f-1")
        XCTAssertEqual(seen.contentType, "application/json")
        XCTAssertEqual(body(seen)?["name"] as? String, "Acme")
        XCTAssertEqual(body(seen)?.count, 1, "only the name: the id is in the path")
    }

    func testDeletingAPersonalFolderSendsNoBody() async throws {
        answerOK()
        try await stubbedCloud().deleteFolder(id: "f-1")
        let seen = try XCTUnwrap(FolderStubProtocol.requests.only)
        XCTAssertEqual(seen.httpMethod, "DELETE")
        XCTAssertEqual(seen.url?.path, "/folders/f-1")
        XCTAssertTrue(seen.body.isEmpty)
    }

    // MARK: organization

    /// The server mints an org folder's id, so the request carries the name alone
    /// and the folder handed back is the one in the response.
    func testCreatingAnOrgFolderReturnsTheServersFolder() async throws {
        FolderStubProtocol.handler = { [self] _ in
            (
                200,
                json([
                    "folder": [
                        "id": "srv-1", "name": "Renewals", "orgId": "o-1",
                        "createdAt": 1_000.0, "updatedAt": 1_000.0,
                    ]
                ])
            )
        }
        let folder = try await stubbedCloud().createOrgFolder(orgId: "o-1", name: "Renewals")
        let seen = try XCTUnwrap(FolderStubProtocol.requests.only)
        XCTAssertEqual(seen.httpMethod, "POST")
        XCTAssertEqual(seen.url?.path, "/orgs/o-1/folders")
        XCTAssertEqual(seen.contentType, "application/json")
        XCTAssertEqual(body(seen)?["name"] as? String, "Renewals")
        XCTAssertNil(body(seen)?["id"], "an org folder's id is the server's to mint")
        XCTAssertEqual(folder.id, "srv-1")
        XCTAssertEqual(folder.name, "Renewals")
        XCTAssertEqual(folder.orgId, "o-1")
    }

    func testRenamingAnOrgFolderPatchesItsName() async throws {
        answerOK()
        try await stubbedCloud().renameOrgFolder(orgId: "o-1", id: "f-9", name: "Q4")
        let seen = try XCTUnwrap(FolderStubProtocol.requests.only)
        XCTAssertEqual(seen.httpMethod, "PATCH")
        XCTAssertEqual(seen.url?.path, "/orgs/o-1/folders/f-9")
        XCTAssertEqual(body(seen)?["name"] as? String, "Q4")
    }

    func testDeletingAnOrgFolderSendsNoBody() async throws {
        answerOK()
        try await stubbedCloud().deleteOrgFolder(orgId: "o-1", id: "f-9")
        let seen = try XCTUnwrap(FolderStubProtocol.requests.only)
        XCTAssertEqual(seen.httpMethod, "DELETE")
        XCTAssertEqual(seen.url?.path, "/orgs/o-1/folders/f-9")
        XCTAssertTrue(seen.body.isEmpty)
    }

    /// A member who neither created the folder nor administers the org is
    /// refused, and the refusal arrives as a 403 — not as a generic failure, and
    /// not as the 401 that would sign the user out.
    func testARefusedOrgFolderChangeIsA403() async {
        FolderStubProtocol.handler = { [self] _ in (403, json(["error": "forbidden"])) }
        do {
            try await stubbedCloud().deleteOrgFolder(orgId: "o-1", id: "f-9")
            XCTFail("a 403 must throw")
        } catch let e as CloudError {
            XCTAssertEqual(e.status, 403)
            XCTAssertFalse(e.isAuthExpired)
        } catch {
            XCTFail("expected a CloudError, got \(error)")
        }
    }
}

extension Array {
    /// The element when there is exactly one.
    fileprivate var only: Element? { count == 1 ? first : nil }
}

/// Records every request (with its body, which `URLProtocol` only exposes as a
/// stream) and answers it with `handler`.
private final class FolderStubProtocol: URLProtocol {
    struct Seen {
        let url: URL?
        let httpMethod: String?
        let contentType: String?
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
        Self.requests.append(
            Seen(
                url: request.url, httpMethod: request.httpMethod,
                contentType: request.value(forHTTPHeaderField: "Content-Type"), body: body))
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
