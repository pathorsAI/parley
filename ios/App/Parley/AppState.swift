import AuthenticationServices
import Foundation
import ParleyKit
import SwiftUI

/// App-wide state: auth session, settings, and the shared cloud client.
/// Settings mirror the desktop's shapes (theme, default save destination);
/// the token lives in the Keychain, never UserDefaults.
@MainActor
final class AppState: NSObject, ObservableObject {
    static let tokenKey = "cloud-session-token"

    @Published var user: CloudUser?
    @Published var quota: HostedQuota?
    @Published var orgs: [CloudOrg] = []
    @Published var signingIn = false
    @Published var authError: String?

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
    var signedIn: Bool { user != nil }

    private(set) lazy var cloud = CloudClient {
        KeychainStore.get(AppState.tokenKey)
    }

    private var webAuth: ASWebAuthenticationSession?

    /// Startup revalidation, same tolerance as the desktop `refreshSession()`:
    /// `user: null` → session is dead, clear it; a network error keeps the
    /// session so flaky connectivity never signs the user out.
    func refreshSession() async {
        guard KeychainStore.get(Self.tokenKey) != nil else { return }
        do {
            user = try await cloud.me()
            if user == nil { KeychainStore.delete(Self.tokenKey) }
            await loadAccountExtras()
        } catch let err as CloudError where err.isAuthExpired {
            KeychainStore.delete(Self.tokenKey)
            user = nil
        } catch {
            // offline — keep the session
        }
    }

    func loadAccountExtras() async {
        guard signedIn else { return }
        quota = try? await cloud.usage()
        orgs = (try? await cloud.myOrgs()) ?? []
    }

    /// Google sign-in through the cloud's `/desktop/sign-in` route — the whole
    /// OAuth flow (incl. the state cookie) runs in the auth browser session,
    /// and its redirect allowlist admits `parley://` callbacks.
    func signIn() {
        authError = nil
        signingIn = true
        let url = cloud.signInURL(callback: "parley://auth/cb")
        let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "parley") {
            [weak self] callbackURL, error in
            Task { @MainActor in
                guard let self else { return }
                self.signingIn = false
                if let error {
                    if (error as? ASWebAuthenticationSessionError)?.code != .canceledLogin {
                        self.authError = error.localizedDescription
                    }
                    return
                }
                guard let callbackURL else { return }
                do {
                    let token = try CloudClient.token(fromCallback: callbackURL)
                    KeychainStore.set(token, for: Self.tokenKey)
                    self.user = try await self.cloud.me()
                    await self.loadAccountExtras()
                } catch {
                    self.authError = "登入失敗：\(error.localizedDescription)"
                }
            }
        }
        session.presentationContextProvider = self
        session.prefersEphemeralWebBrowserSession = false
        webAuth = session
        session.start()
    }

    func signOut() async {
        try? await cloud.signOut()
        KeychainStore.delete(Self.tokenKey)
        user = nil
        quota = nil
        orgs = []
    }

    #if DEBUG
        /// Dev shortcut while Sign in with Apple / mobile OAuth UX is pending:
        /// paste a session token lent by the desktop build.
        func adoptToken(_ token: String) async {
            KeychainStore.set(token.trimmingCharacters(in: .whitespacesAndNewlines), for: Self.tokenKey)
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
