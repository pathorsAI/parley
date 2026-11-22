import XCTest

@testable import ParleyKit

/// The organization calls the onboarding's 組織 step makes — list my
/// invitations, accept one, create an org — as the cloud sees them, plus the
/// slug rule the create call depends on. Mirrors the desktop's
/// `src/lib/cloud/orgs.ts`.
final class OrgOnboardingTests: XCTestCase {

    override func tearDown() {
        OrgStubProtocol.handler = nil
        OrgStubProtocol.requests = []
        super.tearDown()
    }

    private func stubbedCloud() -> CloudClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [OrgStubProtocol.self]
        return CloudClient(
            baseURL: URL(string: "https://example.test")!,
            session: URLSession(configuration: config),
            tokenProvider: { "token" })
    }

    private func json(_ obj: Any) -> Data {
        try! JSONSerialization.data(withJSONObject: obj)
    }

    private func body(_ seen: OrgStubProtocol.Seen) -> [String: Any]? {
        try? JSONSerialization.jsonObject(with: seen.body) as? [String: Any]
    }

    // MARK: slug

    func testSlugJoinsAsciiWordsAndAppendsTheSuffix() {
        XCTAssertEqual(OrgSlug.make(name: "Pathors AI Taiwan", suffix: "abc123"), "pathors-ai-taiwan-abc123")
    }

    func testSlugOfANameWithNoAsciiFallsBackToOrg() {
        XCTAssertEqual(OrgSlug.make(name: "派斯科技", suffix: "abc123"), "org-abc123")
    }

    func testSlugKeepsTheAsciiPartOfAMixedName() {
        XCTAssertEqual(OrgSlug.make(name: "派斯 Pathors 2026", suffix: "x"), "pathors-2026-x")
    }

    func testSlugBaseIsCappedAt32Characters() {
        let slug = OrgSlug.make(name: String(repeating: "a", count: 50), suffix: "s")
        XCTAssertEqual(slug, String(repeating: "a", count: 32) + "-s")
    }

    func testRandomSuffixIsSixCharacters() {
        XCTAssertEqual(OrgSlug.randomSuffix().count, 6)
    }

    // MARK: create

    func testCreatingAnOrgPostsTheTrimmedNameAndASlug() async throws {
        OrgStubProtocol.handler = { [self] _ in
            (200, json(["id": "o-1", "name": "Pathors", "slug": "pathors-abc123"]))
        }
        let org = try await stubbedCloud().createOrg(name: "  Pathors  ")
        let seen = try XCTUnwrap(OrgStubProtocol.requests.first)
        XCTAssertEqual(seen.httpMethod, "POST")
        XCTAssertEqual(seen.url?.path, "/auth/organization/create")
        XCTAssertEqual(seen.contentType, "application/json")
        XCTAssertEqual(body(seen)?["name"] as? String, "Pathors")
        XCTAssertTrue((body(seen)?["slug"] as? String)?.hasPrefix("pathors-") == true)
        XCTAssertEqual(org.id, "o-1")
        XCTAssertEqual(org.name, "Pathors")
    }

    // MARK: invitations

    func testInvitationsReadABareArrayAndDropTheDeadOnes() async throws {
        OrgStubProtocol.handler = { [self] _ in
            (
                200,
                json([
                    [
                        "id": "i-live", "organizationId": "o-1", "organizationName": "Acme",
                        "role": "member", "status": "pending",
                        "expiresAt": "2030-01-01T00:00:00.000Z",
                    ],
                    [
                        "id": "i-expired", "organizationId": "o-2", "status": "pending",
                        "expiresAt": "2020-01-01T00:00:00Z",
                    ],
                    ["id": "i-accepted", "organizationId": "o-3", "status": "accepted"],
                ])
            )
        }
        let now = ISO8601DateFormatter().date(from: "2026-11-18T00:00:00Z")!
        let invitations = try await stubbedCloud().myInvitations(now: now)
        XCTAssertEqual(invitations.map(\.id), ["i-live"])
        XCTAssertEqual(invitations.first?.organizationName, "Acme")
        XCTAssertEqual(OrgStubProtocol.requests.first?.url?.path, "/auth/organization/list-user-invitations")
    }

    func testInvitationsReadTheWrappedShapeAndEpochMilliseconds() async throws {
        OrgStubProtocol.handler = { [self] _ in
            (
                200,
                json([
                    "invitations": [
                        [
                            "id": "i-1", "organizationId": "o-1", "status": "pending",
                            "expiresAt": 1_900_000_000_000.0,
                        ]
                    ]
                ])
            )
        }
        let invitations = try await stubbedCloud().myInvitations(
            now: Date(timeIntervalSince1970: 1_800_000_000))
        XCTAssertEqual(invitations.map(\.id), ["i-1"])
    }

    func testAcceptingAnInvitationPostsItsId() async throws {
        OrgStubProtocol.handler = { [self] _ in (200, json(["ok": true])) }
        try await stubbedCloud().acceptInvitation(id: "i-1")
        let seen = try XCTUnwrap(OrgStubProtocol.requests.first)
        XCTAssertEqual(seen.httpMethod, "POST")
        XCTAssertEqual(seen.url?.path, "/auth/organization/accept-invitation")
        XCTAssertEqual(body(seen)?["invitationId"] as? String, "i-1")
    }
}

private final class OrgStubProtocol: URLProtocol {
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
