import Foundation

public struct CloudError: Error, Equatable {
    public let status: Int
    public let message: String
    public var isAuthExpired: Bool { status == 401 }
}

/// HTTP client for the Parley cloud. Mirrors the desktop's
/// `src/lib/cloud/{client,sync,folders,orgs}.ts` call-for-call; the 401/403
/// discipline is the same — 401 means the session is dead (caller should sign
/// out), 403 is resource-level and must NOT clear auth.
public actor CloudClient {
    public static let defaultBaseURL = URL(string: "https://api.parley.tw")!

    private let baseURL: URL
    private let tokenProvider: @Sendable () -> String?
    private let session: URLSession

    public init(
        baseURL: URL = CloudClient.defaultBaseURL,
        session: URLSession = .shared,
        tokenProvider: @escaping @Sendable () -> String?
    ) {
        self.baseURL = baseURL
        self.session = session
        self.tokenProvider = tokenProvider
    }

    /// The hosted sign-in page (`/sign-in`): email+password, Google, and Apple
    /// all live on our origin; on success the browser redirects to `callback`
    /// (`parley://…`) with `?token=`. The app never touches credentials.
    public nonisolated func signInURL(callback: String) -> URL {
        var comps = URLComponents(
            url: baseURL.appendingPathComponent("sign-in"),
            resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "to", value: callback)]
        return comps.url!
    }

    /// Extract `?token=` from the OAuth callback URL (or throw on `?error=`).
    public static func token(fromCallback url: URL) throws -> String {
        let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
        if let err = comps?.queryItems?.first(where: { $0.name == "error" })?.value {
            throw CloudError(status: 0, message: err)
        }
        guard let token = comps?.queryItems?.first(where: { $0.name == "token" })?.value,
            !token.isEmpty
        else { throw CloudError(status: 0, message: "no_token_in_callback") }
        return token
    }

    // MARK: first-party auth (Better Auth emailAndPassword + bearer plugin)

    /// `POST /auth/sign-in/email`. The bearer plugin returns the session token
    /// in the `set-auth-token` response header — that's the credential every
    /// later call sends as `Authorization: Bearer`.
    public func signIn(email: String, password: String) async throws -> String {
        try await authToken(
            path: "auth/sign-in/email", payload: ["email": email, "password": password])
    }

    /// `POST /auth/sign-up/email` — creates the account and signs in.
    public func signUp(name: String, email: String, password: String) async throws -> String {
        try await authToken(
            path: "auth/sign-up/email",
            payload: ["name": name, "email": email, "password": password])
    }

    /// `POST /auth/sign-in/social` with a native Apple identity token — the
    /// server verifies it against Apple's public keys (audience = the app's
    /// bundle id) and returns a session like any other sign-in.
    public func signInApple(idToken: String) async throws -> String {
        try await authToken(
            path: "auth/sign-in/social",
            payload: ["provider": "apple", "idToken": ["token": idToken]])
    }

    private func authToken(path: String, payload: [String: Any]) async throws -> String {
        let body = try JSONSerialization.data(withJSONObject: payload)
        let (_, response) = try await requestWithResponse(
            path, method: "POST", body: body, contentType: "application/json")
        guard let token = response.value(forHTTPHeaderField: "set-auth-token"), !token.isEmpty
        else { throw CloudError(status: response.statusCode, message: "no_session_token") }
        return token
    }

    // MARK: identity / usage

    public func me() async throws -> CloudUser? {
        struct Me: Codable { let user: CloudUser? }
        return try await get("me", as: Me.self).user
    }

    public func usage() async throws -> HostedQuota {
        try await get("me/usage", as: HostedQuota.self)
    }

    public func signOut() async throws {
        _ = try await request("auth/sign-out", method: "POST")
    }

    /// Permanently removes the first-party account and its personal recordings.
    /// The server returns 409 when the account still owns a shared organization;
    /// that workspace must be transferred or removed explicitly first.
    public func deleteAccount() async throws {
        _ = try await request("me", method: "DELETE")
    }

    // MARK: recordings (personal)

    public func listRecordings() async throws -> [CloudRecordingSummary] {
        struct R: Codable { let recordings: [CloudRecordingSummary] }
        return try await get("recordings", as: R.self).recordings
    }

    public func recordingMeta(id: String) async throws -> RecordingMeta {
        let data = try await request("recordings/\(id)/meta")
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw CloudError(status: 0, message: "bad_meta_json")
        }
        return RecordingMeta(raw: obj)
    }

    /// Idempotent upsert, same two-step order as the desktop: the caller must
    /// upload audio BEFORE pushing a summary claiming `hasAudio`.
    public func pushRecording(id: String, summary: CloudRecordingSummary, meta: RecordingMeta)
        async throws
    {
        let summaryObj = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(summary)) as? [String: Any] ?? [:]
        let body = try JSONSerialization.data(
            withJSONObject: ["summary": summaryObj, "meta": meta.raw])
        _ = try await request("recordings/\(id)", method: "POST", body: body, contentType: "application/json")
    }

    public func uploadAudio(id: String, ogg: Data) async throws {
        _ = try await request("recordings/\(id)/audio", method: "PUT", body: ogg, contentType: "audio/ogg")
    }

    public func deleteRecording(id: String) async throws {
        _ = try await request("recordings/\(id)", method: "DELETE")
    }

    /// Server-side copy into an org (`POST /recordings/:id/share`). "Move" =
    /// share + delete personal, in that order (desktop `moveRecordingToOrg`:
    /// a mid-way failure must leave the original intact).
    public func shareRecording(id: String, orgId: String, folderId: String?) async throws {
        var payload: [String: Any] = ["orgId": orgId]
        if let folderId { payload["folderId"] = folderId }
        let body = try JSONSerialization.data(withJSONObject: payload)
        _ = try await request("recordings/\(id)/share", method: "POST", body: body, contentType: "application/json")
    }

    // MARK: folders (personal)

    public func listFolders() async throws -> [CloudFolder] {
        struct F: Codable { let folders: [CloudFolder] }
        return try await get("folders", as: F.self).folders
    }

    // MARK: orgs

    public func myOrgs() async throws -> [CloudOrg] {
        try await get("orgs/mine", as: [CloudOrg].self)
    }

    public func orgRecordings(orgId: String) async throws -> [CloudRecordingSummary] {
        struct R: Codable { let recordings: [CloudRecordingSummary] }
        return try await get("orgs/\(orgId)/recordings", as: R.self).recordings
    }

    public func orgRecordingMeta(orgId: String, id: String) async throws -> RecordingMeta {
        let data = try await request("orgs/\(orgId)/recordings/\(id)/meta")
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw CloudError(status: 0, message: "bad_meta_json")
        }
        return RecordingMeta(raw: obj)
    }

    public func orgFolders(orgId: String) async throws -> [CloudFolder] {
        struct F: Codable { let folders: [CloudFolder] }
        return try await get("orgs/\(orgId)/folders", as: F.self).folders
    }

    public func deleteOrgRecording(orgId: String, id: String) async throws {
        _ = try await request("orgs/\(orgId)/recordings/\(id)", method: "DELETE")
    }

    public func moveOrgRecordingToFolder(orgId: String, id: String, folderId: String?) async throws {
        let body = try JSONSerialization.data(
            withJSONObject: ["folderId": folderId as Any? ?? NSNull()])
        _ = try await request(
            "orgs/\(orgId)/recordings/\(id)/folder", method: "PATCH",
            body: body, contentType: "application/json")
    }

    // MARK: generic JSON POST

    /// `POST` a JSON body and hand back the raw response body, for callers that
    /// own their own request/response shapes — the OpenAI-compatible
    /// `v1/chat/completions` endpoint the dictation polish pass uses. Same
    /// auth header and same 2xx-or-`CloudError` discipline as every call above.
    public func postJSON(_ path: String, body: Data) async throws -> Data {
        try await request(path, method: "POST", body: body, contentType: "application/json")
    }

    // MARK: plumbing

    private func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        let data = try await request(path)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func request(
        _ path: String, method: String = "GET", body: Data? = nil, contentType: String? = nil
    ) async throws -> Data {
        try await requestWithResponse(path, method: method, body: body, contentType: contentType).0
    }

    private func requestWithResponse(
        _ path: String, method: String = "GET", body: Data? = nil, contentType: String? = nil
    ) async throws -> (Data, HTTPURLResponse) {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = method
        req.httpBody = body
        if let contentType { req.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        if let token = tokenProvider() {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, resp) = try await session.data(for: req)
        let http = (resp as? HTTPURLResponse) ?? HTTPURLResponse()
        guard (200..<300).contains(http.statusCode) else {
            let message = String(data: data, encoding: .utf8) ?? ""
            throw CloudError(status: http.statusCode, message: message)
        }
        return (data, http)
    }
}
