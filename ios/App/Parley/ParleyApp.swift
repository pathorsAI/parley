import SwiftUI

@main
struct ParleyApp: App {
    @StateObject private var app = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(app)
                .preferredColorScheme(app.theme.colorScheme)
                .task { await app.refreshSession() }
        }
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
