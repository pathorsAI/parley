import AuthenticationServices
import Foundation
import ParleyKit
import SwiftUI

/// App-wide state: auth session, settings, and the shared cloud client.
/// Settings mirror the desktop's shapes (theme, default save destination);
/// the token lives in the Keychain, never UserDefaults.
@MainActor
final class AppState: NSObject, ObservableObject {
    nonisolated static let tokenKey = "cloud-session-token"

    @Published var user: CloudUser?
    @Published var quota: HostedQuota?
    @Published var orgs: [CloudOrg] = []
    @Published var signingIn = false
    @Published var signInError: String?
    @Published var pendingUploadCount = MeetingUploader.pendingCount

    /// False only until the stored session has been read out of the Keychain —
    /// which is synchronous, so this is true within the first frame. The root
    /// view waits on it so a returning user never sees the sign-in wall flash by
    /// before the app decides. It deliberately does NOT wait on the network.
    @Published var bootstrapped = false

    /// Whether this device holds a session token at all. Distinct from
    /// `signedIn`, which additionally requires a successful `me()`: on a flaky
    /// network `me()` fails but the session is deliberately kept (see
    /// `refreshSession()`), and gating the UI on `signedIn` alone would show the
    /// sign-in wall to someone who is already signed in and merely offline.
    @Published private(set) var hasStoredSession = KeychainStore.get(AppState.tokenKey) != nil

    @AppStorage("theme") var themeRaw: String = AppTheme.system.rawValue
    /// JSON-encoded `SaveDestination` (mirror of desktop `defaultSaveLocation`).
    @AppStorage("defaultSaveLocation") private var defaultSaveRaw: String = ""

    var theme: AppTheme { AppTheme(rawValue: themeRaw) ?? .system }

    var defaultSave: SaveDestination {
        get {
            guard let data = defaultSaveRaw.data(using: .utf8),
                let loc = try? JSONDecoder().decode(SaveDestination.self, from: data)
            else { return .personalRoot }
            return loc
        }
        set {
            defaultSaveRaw =
                String(data: (try? JSONEncoder().encode(newValue)) ?? Data(), encoding: .utf8) ?? ""
            objectWillChange.send()
        }
    }
    /// Identity is confirmed — cloud reads and uploads can be attempted.
    var signedIn: Bool { user != nil }

    /// This device has an account. The gate and the record button use this, not
    /// `signedIn`, so being offline is never mistaken for being signed out.
    var hasAccount: Bool { user != nil || hasStoredSession }

    /// Tell the keyboard whether tapping its mic could transcribe anything.
    ///
    /// The keyboard cannot read the Keychain or ask about the microphone, so
    /// without this it could only find out by starting a session and reading
    /// back the failure — which is why it used to offer a mic button that could
    /// not record. Both facts outlive this process, so the keyboard reads them
    /// with no staleness rule; see `DictationChannel.KeyboardReadiness`.
    ///
    /// `static` because the microphone prompt resolves inside
    /// `DictationCoordinator`, which has no `AppState` to ask. The Keychain is
    /// the same source `hasStoredSession` mirrors, and `user != nil` always
    /// implies a stored token, so the two readings cannot disagree.
    static func publishKeyboardReadiness() {
        DictationChannel.writeReadiness(
            .init(
                signedIn: KeychainStore.get(tokenKey) != nil,
                micGranted: AudioCapture.permission == .granted))
    }

    private(set) lazy var cloud = CloudClient {
        KeychainStore.get(AppState.tokenKey)
    }

    private var webAuth: ASWebAuthenticationSession?

    /// Pull the remote feature flags into the App Group cache.
    ///
    /// Nothing waits on this and nothing fails because of it: a network error,
    /// an expired session, or a server with no flag document all leave the last
    /// good answer in place, and a device that has never succeeded here runs on
    /// the compiled defaults. See `FeatureFlags`.
    ///
    /// Called at launch *and* on every foregrounding rather than on a timer.
    /// The one flag it carries today is a kill switch for a private-API path,
    /// and a kill switch that lands a day late is not a kill switch.
    func refreshFeatureFlags() async {
        guard let flags = try? await cloud.featureFlags() else { return }
        FeatureFlagStore.shared.save(flags)
    }

    /// Startup revalidation, same tolerance as the desktop `refreshSession()`:
    /// `user: null` → session is dead, clear it; a network error keeps the
    /// session so flaky connectivity never signs the user out.
    func refreshSession() async {
        pendingUploadCount = MeetingUploader.pendingCount

        #if DEBUG
            if ScreenshotDemo.isActive {
                hasStoredSession = ScreenshotDemo.startsSignedIn
                if ScreenshotDemo.startsSignedIn {
                    user = ScreenshotDemo.user
                    quota = ScreenshotDemo.quota
                    orgs = ScreenshotDemo.orgs
                }
                pendingUploadCount = 0
                bootstrapped = true
                return
            }
        #endif

        // Decide the gate from the Keychain alone, before any await: it is
        // instant and always right about whether this device has an account.
        // Waiting on `me()` first would park a returning user behind a spinner
        // for as long as URLSession's timeout whenever the network is bad —
        // exactly the condition where they most want to just hit record.
        let token = KeychainStore.get(Self.tokenKey)
        hasStoredSession = token != nil
        bootstrapped = true
        // Launch is the one beat that has to republish unconditionally: iOS
        // restarts the app when microphone permission is changed in Settings,
        // so the grant may have flipped while nothing was running to notice.
        Self.publishKeyboardReadiness()
        guard token != nil else { return }

        do {
            user = try await cloud.me()
            if user == nil { clearStoredToken() }
            await loadAccountExtras()
            await syncPendingUploads()
        } catch let err as CloudError where err.isAuthExpired {
            clearStoredToken()
            user = nil
        } catch {
            // Offline or the server is unreachable: keep the session. The token
            // is still good, so `hasAccount` stays true and the app stays usable.
        }
    }

    func loadAccountExtras() async {
        guard signedIn else { return }
        quota = try? await cloud.usage()
        orgs = (try? await cloud.myOrgs()) ?? []
    }

    /// Sign in via the hosted `/sign-in` page in an auth browser session —
    /// email+password, Google, and Apple all live there; the page redirects
    /// back to `parley://` with the session token. Credentials never pass
    /// through the app.
    func signIn() {
        signInError = nil
        signingIn = true
        let url = cloud.signInURL(callback: "parley://auth/cb")
        let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "parley") {
            [weak self] callbackURL, error in
            Task { @MainActor in
                guard let self else { return }
                self.signingIn = false
                if let error {
                    if (error as? ASWebAuthenticationSessionError)?.code != .canceledLogin {
                        self.signInError = error.localizedDescription
                    }
                    return
                }
                guard let callbackURL else { return }
                await self.completeSignIn(callbackURL: callbackURL)
            }
        }
        session.presentationContextProvider = self
        session.prefersEphemeralWebBrowserSession = false
        webAuth = session
        session.start()
    }

    /// Turn the `parley://auth/cb?token=…` handoff into a live session.
    ///
    /// The three failure modes are deliberately not collapsed: a malformed
    /// callback never had a token to keep, an expired one must be discarded (it
    /// would leave the app looking signed in while every call 401s), and a
    /// network error right after a good handoff must NOT discard it — the
    /// session is real and `refreshSession()` will confirm it later.
    private func completeSignIn(callbackURL: URL) async {
        let token: String
        do {
            token = try CloudClient.token(fromCallback: callbackURL)
        } catch {
            signInError = signInFailureMessage(error)
            return
        }
        storeToken(token)

        do {
            user = try await cloud.me()
        } catch let err as CloudError where err.isAuthExpired {
            clearStoredToken()
            signInError = String(localized: "Sign-in didn't finish. Please try again.")
            return
        } catch {
            signInError = signInFailureMessage(error)
            return
        }
        guard user != nil else {
            clearStoredToken()
            signInError = String(localized: "Sign-in didn't finish. Please try again.")
            return
        }
        await loadAccountExtras()
        await syncPendingUploads()
    }

    /// Sign-in copy a person can act on. `localizedDescription` on a
    /// `CloudError` is the raw response body, which is not something to show.
    private func signInFailureMessage(_ error: Error) -> String {
        if let cloudError = error as? CloudError {
            // status 0 = the callback itself was malformed (no token / an
            // ?error= from the page), not an HTTP status worth showing.
            if cloudError.status == 0 {
                return String(localized: "Sign-in didn't finish. Please try again.")
            }
            return String(
                localized: "Sign-in failed (server said \(cloudError.status)). Try again shortly.")
        }
        return String(
            localized: "The connection dropped before sign-in finished. Check your network and try again."
        )
    }

    func signOut() async {
        try? await cloud.signOut()
        clearLocalSession()
    }

    func syncPendingUploads() async {
        guard signedIn else {
            pendingUploadCount = MeetingUploader.pendingCount
            return
        }
        let result = await MeetingUploader.syncPending(cloud: cloud, orgs: orgs)
        pendingUploadCount = result.remaining
    }

    func deleteAccount() async throws {
        try await cloud.deleteAccount()
        clearLocalSession()
    }

    private func clearLocalSession() {
        clearStoredToken()
        user = nil
        quota = nil
        orgs = []
    }

    // The Keychain is the source of truth for the token; `hasStoredSession`
    // mirrors it for SwiftUI. Every write goes through these two so the mirror
    // cannot drift out of sync with the Keychain and strand the UI.

    private func storeToken(_ token: String) {
        KeychainStore.set(token, for: Self.tokenKey)
        hasStoredSession = true
        Self.publishKeyboardReadiness()
    }

    private func clearStoredToken() {
        KeychainStore.delete(Self.tokenKey)
        hasStoredSession = false
        Self.publishKeyboardReadiness()
    }

    #if DEBUG
        /// Dev-only shortcut for testing a session minted by the desktop build.
        func adoptToken(_ token: String) async {
            storeToken(token.trimmingCharacters(in: .whitespacesAndNewlines))
            await refreshSession()
        }
    #endif
}

extension AppState: ASWebAuthenticationPresentationContextProviding {
    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession)
        -> ASPresentationAnchor
    {
        MainActor.assumeIsolated {
            UIApplication.shared.connectedScenes
                .compactMap { ($0 as? UIWindowScene)?.keyWindow }
                .first ?? ASPresentationAnchor()
        }
    }
}
