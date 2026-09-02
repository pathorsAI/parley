import ParleyKit
import SwiftUI

@main
struct ParleyApp: App {
    @StateObject private var app = AppState()
    @StateObject private var dictation = DictationCoordinator.shared
    @Environment(\.scenePhase) private var scenePhase

    /// The navigation and tab bars are drawn by UIKit and never see a SwiftUI
    /// `.font()`, so their appearance proxies are configured once here, before
    /// the first scene is built. See `ParleyAppearance.swift`.
    init() {
        ParleyAppearance.apply()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(app)
                .preferredColorScheme(app.theme.colorScheme)
                .task { await app.refreshSession() }
                .task { await app.refreshFeatureFlags() }
                // The keyboard extension can't record, so its mic button opens
                // `parley://dictate`; the app records and hands the transcript
                // back through the App Group. (Auth callbacks use the same
                // scheme but arrive through ASWebAuthenticationSession, not here.)
                .onOpenURL { url in
                    #if DEBUG
                        if ScreenshotDemo.shared.handle(url) { return }
                    #endif
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
                // Every foregrounding, not only launch: a trip to Settings to
                // grant the microphone brings the app back here rather than
                // through `init`, and the keyboard's pane is only honest for as
                // long as this file is.
                .onChange(of: scenePhase) { _, phase in
                    guard phase == .active else { return }
                    AppState.publishKeyboardReadiness()
                    Task { await app.refreshFeatureFlags() }
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
    /// Selection is bound rather than implicit only so the DEBUG screenshot
    /// routes can land on a tab without a tap; behaviour is otherwise identical.
    @State private var tab: ScreenshotTab = .record

    var body: some View {
        TabView(selection: $tab) {
            LiveView()
                .tabItem { Label("Record", systemImage: "record.circle") }
                .tag(ScreenshotTab.record)
            LibraryView()
                .tabItem { Label("Library", systemImage: "rectangle.stack") }
                .tag(ScreenshotTab.library)
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(ScreenshotTab.settings)
        }
        #if DEBUG
            .onReceive(ScreenshotDemo.shared.$tab) { tab = $0 }
        #endif
    }
}

#if DEBUG
    typealias ScreenshotTab = ScreenshotDemo.Tab
#else
    enum ScreenshotTab: Hashable { case record, library, settings }
#endif
