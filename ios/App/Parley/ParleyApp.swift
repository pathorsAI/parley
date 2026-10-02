import ParleyKit
import SwiftUI

@main
struct ParleyApp: App {
    @StateObject private var app = AppState()
    @StateObject private var dictation = DictationCoordinator.shared
    /// One per app, so the library row, its context menu and the recording's own
    /// toolbar are three doors onto the same download rather than three
    /// downloads. See `AudioDownloadModel`.
    @StateObject private var downloads = AudioDownloadModel()
    @Environment(\.scenePhase) private var scenePhase

    /// The navigation and tab bars are drawn by UIKit and never see a SwiftUI
    /// `.font()`, so their appearance proxies are configured once here, before
    /// the first scene is built. See `ParleyAppearance.swift`.
    init() {
        ParleyAppearance.apply()
        // Before anything can sign in: the checklist's first-launch migration
        // reads whether a session token is *already* in the Keychain, and it
        // has to ask before this launch could have put one there.
        _ = GettingStartedStore.shared
        // Same reason, for What's New: a fresh install marks every bundled
        // announcement seen on its first launch, and it can only tell a fresh
        // install from an update before this launch could have signed in.
        _ = AnnouncementStore.shared
        // As early as the app has: MetricKit hands the previous run's crash to
        // a subscriber as soon as it is added. See `FeedbackCenter.start`.
        FeedbackCenter.shared.start()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(app)
                .environmentObject(downloads)
                // Blue is a signal, and this is the one place it is declared:
                // every link, button, selected tab and control inherits it from
                // here, so a view only names `Theme.primary` when it is
                // colouring something that is not already a tinted control.
                .tint(Theme.primary)
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
                    // Any URL — the keyboard's dictate, the Live Activity's
                    // card — means the user came here in the middle of
                    // something, so What's New waits for another foreground.
                    WhatsNewPresenter.shared.noteOpenedByURL()
                    if let session = DictationChannel.session(fromStart: url) {
                        Task { await dictation.begin(session: session) }
                    } else if let link = SettingsLink(url: url) {
                        // The keyboard's 📋 panel, linking to Settings ›
                        // 剪貼簿 or 常用資訊. See `SettingsLinkInbox`.
                        SettingsLinkInbox.shared.post(link)
                    } else if QuickRecord.isRequest(url) {
                        // The lock-screen control, the lock-screen widget or
                        // the Siri shortcut. The Record tab picks it up; see
                        // `QuickRecordInbox`.
                        QuickRecordInbox.shared.post()
                    }
                }
                // Presented for both entry points: the keyboard URL and the
                // Action Button intent (which starts a session while the app is
                // in the background — the cover is ready when it next appears).
                .fullScreenCover(isPresented: dictationPresented) {
                    DictationView(coordinator: dictation)
                }
                #if DEBUG
                    .modifier(KeyboardHarnessPresenter())
                #endif
                // Every foregrounding, not only launch: a trip to Settings to
                // grant the microphone brings the app back here rather than
                // through `init`, and the keyboard's pane is only honest for as
                // long as this file is.
                .onChange(of: scenePhase) { _, phase in
                    guard phase == .active else { return }
                    AppState.publishKeyboardReadiness()
                    // The crash banner needs a scene to draw in, and this is
                    // the first moment there reliably is one.
                    FeedbackCenter.shared.sceneBecameActive()
                    // A Live Activity can only be *started* from the foreground,
                    // so a refusal is remembered rather than retried at the rate
                    // the transcript moves. This is the only event that can make
                    // the next attempt different.
                    MicActivityController.shared.appBecameActive()
                    // 「自動收錄剪貼簿」, when the user turned it on: the
                    // app's one moment to keep what was copied elsewhere.
                    AppClipboard.captureIfEnabled()
                    Task { await app.refreshFeatureFlags() }
                    // The line that turns "dead until force-quit" into
                    // "recovers by itself". `UIBackgroundModes` here is `audio`
                    // only, so a re-transcription — minutes of work on an hour
                    // of audio — is killed the moment the phone is locked or
                    // the user switches apps. Nothing else re-drove the queue
                    // between cold launches: Settings' "Retry sync now" is only
                    // rendered for pending *uploads*, and backfills do not
                    // count towards those. So a job that died on a lock screen
                    // left the detail screen saying "Re-transcribing…" forever,
                    // with the menu item that would retry it greyed out,
                    // because both were reading a manifest nobody was running.
                    // Coming back to the app is the obvious moment to try
                    // again, and passes are serialized, so this cannot pile up
                    // behind a drain already in flight.
                    Task { await app.syncPendingBackfills() }
                }
        }
    }

    private var dictationPresented: Binding<Bool> {
        Binding(
            get: {
                #if DEBUG
                    // The keyboard harness is the screen to watch; a cover
                    // over it would take the keyboard away with the focus.
                    if ScreenshotDemo.shared.keyboardHarness { return false }
                #endif
                return dictation.active
            },
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
        Group {
            if !app.bootstrapped {
                LaunchView()
            } else if app.hasAccount {
                MainTabs()
            } else {
                OnboardingView()
            }
        }
        // The sign-in page's edge glow lives here rather than in
        // `OnboardingView` so that it can outlast it: a successful sign-in
        // swaps the page out in one frame, and the glow fades over the app that
        // replaces it. It removes itself once faded. See `AuroraEdgeGlow`.
        .overlay { AuroraEdgeGlow() }
    }
}

struct MainTabs: View {
    /// The selection, lifted out of this view so Settings can send the user to
    /// the Library — see `TabRouter`.
    @StateObject private var router = TabRouter()

    var body: some View {
        TabView(selection: $router.tab) {
            LiveView()
                .tabItem { Label("Record", systemImage: "record.circle") }
                .tag(AppTab.record)
            LibraryView()
                .tabItem { Label("Library", systemImage: "rectangle.stack") }
                .tag(AppTab.library)
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(AppTab.settings)
        }
        .environmentObject(router)
        // A lock-screen "start recording" lands on the Record tab whatever tab
        // was up when the app was last left.
        .onReceive(QuickRecordInbox.shared.$requestedAt) { if $0 != nil { router.tab = .record } }
        // The keyboard's 📋 panel linking into Settings; the section itself is
        // found by `SettingsView`, which takes the request.
        .onReceive(SettingsLinkInbox.shared.$request) { if $0 != nil { router.tab = .settings } }
        // Once, after an update, when nothing else is going on — see
        // `WhatsNewPresenter` for what "nothing" has to mean.
        .whatsNewSheet()
        #if DEBUG
            // The DEBUG screenshot routes land on a tab without a tap.
            .onReceive(ScreenshotDemo.shared.$tab) { router.tab = $0 }
        #endif
    }
}
