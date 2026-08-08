import ParleyKit
import SwiftUI

@main
struct ParleyApp: App {
    @StateObject private var app = AppState()
    @StateObject private var dictation = DictationCoordinator.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(app)
                .preferredColorScheme(app.theme.colorScheme)
                .task { await app.refreshSession() }
                // The keyboard extension can't record, so its mic button opens
                // `parley://dictate`; the app records and hands the transcript
                // back through the App Group. (Auth callbacks use the same
                // scheme but arrive through ASWebAuthenticationSession, not here.)
                .onOpenURL { url in
                    if let session = DictationChannel.session(fromStart: url) {
                        Task { await dictation.begin(session: session) }
                    }
                }
                // Presented for both entry points: the keyboard URL and the
                // Action Button intent (which starts a session while the app is
                // in the background — the cover is ready when it next appears).
                .fullScreenCover(isPresented: dictationPresented) {
                    DictationView(coordinator: dictation)
                }
        }
    }

    private var dictationPresented: Binding<Bool> {
        Binding(
            get: { dictation.active },
            set: { if !$0 { Task { await dictation.dismiss() } } })
    }
}

/// Three states, one decision: still checking the stored session, no account
/// yet, or in. Everything behind the tab bar needs an account to do anything —
/// recording streams through the account's hosted transcription relay, and the
/// library *is* that account's cloud recordings — so the sign-in gate is the
/// app's entrance rather than a prompt buried in Settings.
struct RootView: View {
    @EnvironmentObject private var app: AppState

    var body: some View {
        if !app.bootstrapped {
            LaunchView()
        } else if app.hasAccount {
            MainTabs()
        } else {
            OnboardingView()
        }
    }
}

struct MainTabs: View {
    var body: some View {
        TabView {
            LiveView()
                .tabItem { Label("錄音", systemImage: "record.circle") }
            LibraryView()
                .tabItem { Label("錄音庫", systemImage: "rectangle.stack") }
            SettingsView()
                .tabItem { Label("設定", systemImage: "gearshape") }
        }
    }
}
