import Foundation

/// Which build of which app is talking: `X-Parley-Client: ios/1.24 (41)`.
///
/// ## Why every request carries it
///
/// The cloud could only guess a platform from the User-Agent of the browser the
/// user signed in with, and could not tell versions apart at all. That is how
/// Android 1.13 shipped a recorder that produced no transcript for almost every
/// new user and nobody could see it for ten days: the rows were all in D1, but
/// nothing on them said *which build* made them. With this header on every
/// request the server stamps recordings and transcription sessions with the
/// version that produced them, and a broken release shows up as a broken
/// release rather than as a vague dip.
///
/// ## Why it is built here and nowhere else
///
/// There are exactly two places in this package that build a request to
/// `api.parley.tw` — `CloudClient.makeRequest` and the relay's WebSocket
/// handshake in `SttRelayClient.start` — and both get their `URLRequest` from
/// `request(url:)`. A third call site added later that builds its own
/// `URLRequest(url:)` would silently ship requests the server cannot attribute,
/// so the rule for this package is: requests to the cloud start here.
///
/// The WebSocket handshake can carry headers (`URLSessionWebSocketTask` sends
/// the request's header fields on the upgrade), so the `?client=` query
/// fallback the contract allows for is not needed on iOS and is not sent.
///
/// It identifies a build, not a person: no device id, no install id, nothing
/// that survives a reinstall or distinguishes one phone from another running
/// the same version.
public enum ParleyClientIdentity {
    public static let headerName = "X-Parley-Client"

    /// The platform token. The package is also built for macOS so the core can
    /// be tested without a simulator; a macOS build of this package is not an
    /// app that talks to the cloud, but it is honest about what it is.
    public static var platform: String {
        #if os(iOS)
            return "ios"
        #elseif os(macOS)
            return "macos"
        #else
            return "unknown"
        #endif
    }

    /// `<platform>/<version> (<build>)`, shaped so that it always parses under
    /// the server's rule
    /// `^(ios|android|macos|windows|linux)\/([^\s()]{1,32})(?:\s\((\d{1,10})\))?$`.
    ///
    /// The server treats a malformed value as absent rather than refusing the
    /// request, which means a malformed value is *silently* useless. So the
    /// cleaning happens here: whitespace and parentheses are dropped from the
    /// version (they are the only characters the rule excludes), the version is
    /// capped at 32 characters, and a build number that is not plain digits —
    /// a CI suffix, say — is left off rather than sent in a form the server
    /// would discard along with the version in front of it.
    public static func headerValue(platform: String, version: String, build: String?) -> String {
        let cleanedVersion = String(
            version.unicodeScalars
                .filter { !CharacterSet.whitespacesAndNewlines.contains($0) && $0 != "(" && $0 != ")" }
                .prefix(32)
                .map(Character.init))
        let versionPart = cleanedVersion.isEmpty ? "0" : cleanedVersion
        guard let build, !build.isEmpty, build.count <= 10,
            build.unicodeScalars.allSatisfy({ ("0"..."9").contains($0) })
        else { return "\(platform)/\(versionPart)" }
        return "\(platform)/\(versionPart) (\(build))"
    }

    /// This process's value, read once from the main bundle. The keyboard and
    /// widget extensions carry the same version and build as the app (see
    /// `project.yml`), so their value would be the same — not that either of
    /// them makes network calls.
    public static let current: String = headerValue(
        platform: platform,
        version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
            ?? "0",
        build: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String)

    /// The version and build on their own, for the diagnostics a report carries
    /// (`diagnostics.app`). Same source as `current`.
    public static var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }

    public static var appBuild: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
    }

    /// The one way this package starts a request to the cloud. See the type doc.
    public static func request(url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        request.setValue(current, forHTTPHeaderField: headerName)
        return request
    }
}
