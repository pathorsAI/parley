import Combine
import Foundation
import ParleyKit
import SwiftUI
import UIKit

/// Which announcements this phone is done with, persisted.
///
/// A thin shell over `AnnouncementGate` (ParleyKit, where the rules are
/// unit-tested), in the shape of `GettingStartedStore`: the state is read out of
/// `UserDefaults.standard` once and written back on every change. No App Group
/// — neither extension has anything to say about it.
///
/// The announcements themselves are the repository's `announcements/` folder,
/// bundled as a folder reference (see `project.yml`) and read once per launch.
///
/// ## Who never sees one
///
/// A fresh install. The first launch of a build that has no stored state asks
/// the Keychain whether a session token is *already* there: if so, the user
/// signed in under an earlier build and is updating; if not, every bundled
/// announcement is marked seen before anything else happens. `ParleyApp.init`
/// touches `shared` before anything can sign in — the same constraint, for the
/// same reason, as `GettingStartedStore` — so a new user's first sign-in can
/// never be mistaken for an old one.
///
/// Unlike the checklist there is no second, library-based check: a Mac user
/// signing in on a new phone is new *to this app*, and "what's new in 1.22" is
/// a sentence about the phone app they have never seen.
@MainActor
final class AnnouncementStore {
    static let shared = AnnouncementStore()

    private static let stateKey = "announcements.v1"

    /// Everything the bundle carries, in file-name order.
    let bundled: [Announcement]
    private(set) var state: AnnouncementState
    /// DEBUG `-ParleyResetAnnouncements YES`: every audience counts as met, so
    /// the keyboard announcement can be forced on a simulator that has never
    /// run the keyboard. Always false in a shipped build.
    let forced: Bool

    private let defaults: UserDefaults

    init(
        defaults: UserDefaults = .standard,
        bundled: [Announcement] = AnnouncementStore.loadBundled(),
        hadStoredSession: @autoclosure () -> Bool = KeychainStore.get(AppState.tokenKey) != nil
    ) {
        self.defaults = defaults
        self.bundled = bundled
        #if DEBUG
            // Checked before the stored state so it wins over it, every launch
            // it is passed: nothing seen, the user treated as existing.
            if defaults.bool(forKey: "ParleyResetAnnouncements") {
                forced = true
                state = AnnouncementState()
                save()
                return
            }
        #endif
        forced = false
        if let data = defaults.data(forKey: Self.stateKey),
            let saved = try? JSONDecoder().decode(AnnouncementState.self, from: data)
        {
            state = saved
        } else {
            state = AnnouncementGate.initial(bundled: bundled, hadStoredSession: hadStoredSession())
            // Written at once, so the migration runs exactly once: the next
            // launch finds a stored state and never asks the Keychain again.
            save()
        }
    }

    /// The bundled `announcements/` folder. Empty if the folder is missing,
    /// which is a build without announcements rather than an error.
    nonisolated static func loadBundled() -> [Announcement] {
        guard let folder = Bundle.main.url(forResource: "announcements", withExtension: nil)
        else { return [] }
        return AnnouncementCatalog.load(directory: folder)
    }

    /// What to show right now, if anything. See `AnnouncementGate.decide`.
    func decide(keyboardUsed: Bool) -> AnnouncementGate.Decision {
        AnnouncementGate.decide(
            announcements: bundled, state: state, appVersion: Self.appVersion,
            keyboardUsed: forced || keyboardUsed)
    }

    func markSeen(_ ids: Set<String>) {
        guard !ids.isSubset(of: state.seen) else { return }
        state.seen.formUnion(ids)
        save()
    }

    static var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(state) else { return }
        defaults.set(data, forKey: Self.stateKey)
    }
}

/// *When* the What's New sheet may come up — the store and the gate decide
/// *whether* and *which*.
///
/// The sheet is the app talking about itself, so it waits for a moment when
/// nobody is in the middle of anything. It is presented only when all of these
/// hold, checked at the moment of presenting rather than when the attempt was
/// scheduled:
///
/// - **The signed-in home is on screen.** `MainTabs` reports its own
///   appearance, which is only ever drawn with an account; `LaunchView` and
///   `OnboardingView` never are.
/// - **The app is active**, not being launched into the background by an
///   intent or waking for a Live Activity button.
/// - **No meeting is holding the microphone** (`MeetingRecorder.holdsTheMicrophone`)
///   and **no keyboard dictation is running** (`DictationCoordinator.active`).
/// - **This foreground was not opened by a URL.** Every `parley://` URL that
///   reaches `onOpenURL` comes from somewhere the user was doing something
///   else: the keyboard's `parley://dictate` (they are mid-sentence in another
///   app and about to be sent back to it), the Live Activity's card
///   (`widgetURL`, bare `parley://`), or the keyboard's "open Parley to set up"
///   (same bare URL). Such a foreground is skipped entirely and the sheet waits
///   for the next one that starts without a URL. Sign-in callbacks do not come
///   through here — they arrive through `ASWebAuthenticationSession`.
/// - **Not already shown in this foreground.**
///
/// The attempt runs `settleDelay` after the home appears or the scene becomes
/// active, so it lands after the launch transition rather than on top of it —
/// and so a URL delivered a beat after activation has time to arrive and veto
/// it. If dictation starts while the sheet is up (the Action Button, a URL that
/// arrived late), the sheet is retracted *without* being marked seen: the
/// dictation cover has to be the one on screen, and the user never got to read
/// it.
@MainActor
final class WhatsNewPresenter: ObservableObject {
    static let shared = WhatsNewPresenter()

    /// Drives `.sheet(item:)` on `MainTabs`.
    @Published var presented: Announcement?

    /// How long after the home appears (or the scene becomes active) before
    /// the sheet may present.
    static let settleDelay: Duration = .milliseconds(600)

    private let store: AnnouncementStore
    /// What to mark seen when the presented sheet is dismissed.
    private var retiring: Set<String> = []
    /// Set when the sheet is taken down by the app rather than the user, so
    /// its dismissal is not mistaken for having read it.
    private var retracted = false
    /// The sheet actually drew. `presented` alone cannot say: SwiftUI declines
    /// a sheet while another presentation is up, silently, and a `presented`
    /// left set by that would block every later attempt.
    private var sheetAppeared = false

    private var homeVisible = false
    private var openedByURL = false
    private var shownThisForeground = false
    private var attempt: Task<Void, Never>?
    private var dictationWatch: AnyCancellable?

    init(store: AnnouncementStore = .shared) {
        self.store = store
        dictationWatch = DictationCoordinator.shared.$active
            .removeDuplicates()
            .filter { $0 }
            .sink { [weak self] _ in
                Task { @MainActor in self?.retract() }
            }
    }

    // MARK: events

    func homeAppeared() {
        homeVisible = true
        schedule()
    }

    func homeDisappeared() {
        homeVisible = false
        attempt?.cancel()
    }

    func scenePhaseChanged(to phase: ScenePhase) {
        switch phase {
        case .active:
            schedule()
        case .background:
            // The foreground is over: the next one starts with a clean slate.
            openedByURL = false
            shownThisForeground = false
            attempt?.cancel()
            // A sheet SwiftUI declined to draw is forgotten, so it can be
            // offered again next time.
            if presented != nil, !sheetAppeared { retract() }
        default:
            attempt?.cancel()
        }
    }

    /// Called from `ParleyApp.onOpenURL`, for every URL — see the type doc.
    func noteOpenedByURL() {
        openedByURL = true
        attempt?.cancel()
        retract()
    }

    func sheetDidAppear() {
        sheetAppeared = true
    }

    /// The sheet's one button. Closes it, then follows the announcement's
    /// `cta.ios` link if it has one.
    func finish(openURL: OpenURLAction) {
        let link = presented?.cta?.ios.flatMap(URL.init(string:))
        presented = nil
        if let link { openURL(link) }
    }

    /// `.sheet(onDismiss:)` — every way the sheet goes away: the button, a
    /// swipe, or a retraction.
    func sheetDismissed() {
        sheetAppeared = false
        if retracted {
            retracted = false
            retiring = []
            return
        }
        store.markSeen(retiring)
        retiring = []
    }

    // MARK: presenting

    private func schedule() {
        attempt?.cancel()
        attempt = Task { [weak self] in
            try? await Task.sleep(for: Self.settleDelay)
            guard !Task.isCancelled else { return }
            self?.presentIfAppropriate()
        }
    }

    private func presentIfAppropriate() {
        guard homeVisible, !openedByURL, !shownThisForeground, presented == nil,
            UIApplication.shared.applicationState == .active,
            !MeetingRecorder.holdsTheMicrophone,
            !DictationCoordinator.shared.active
        else { return }
        #if DEBUG
            // Store screenshots are taken on a signed-in demo; a sheet over
            // them would ruin every frame. Forcing still works.
            if ScreenshotDemo.isActive, !store.forced { return }
        #endif
        let decision = store.decide(keyboardUsed: Self.keyboardUsed())
        guard let show = decision.show else { return }
        retiring = decision.retire
        retracted = false
        sheetAppeared = false
        shownThisForeground = true
        presented = show
    }

    private func retract() {
        guard presented != nil else { return }
        retracted = true
        presented = nil
    }

    /// Whether the Parley keyboard has been used on this phone: it has written
    /// its uplink mailbox in the App Group (it does on every session it
    /// starts), or the app has kept a dictation in its history. Either is
    /// enough — the history can be switched off, and the mailbox can be
    /// cleared.
    static func keyboardUsed() -> Bool {
        DictationChannel.readUplink() != nil || !DictationHistory.shared.entries.isEmpty
    }
}

extension View {
    /// Wires a view — the signed-in home — up to present the What's New sheet.
    func whatsNewSheet() -> some View {
        modifier(WhatsNewHost())
    }
}

private struct WhatsNewHost: ViewModifier {
    @ObservedObject private var presenter = WhatsNewPresenter.shared
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL

    func body(content: Content) -> some View {
        content
            .onAppear { presenter.homeAppeared() }
            .onDisappear { presenter.homeDisappeared() }
            .onChange(of: scenePhase) { _, phase in presenter.scenePhaseChanged(to: phase) }
            .sheet(item: $presenter.presented, onDismiss: presenter.sheetDismissed) { announcement in
                WhatsNewSheet(announcement: announcement) {
                    presenter.finish(openURL: openURL)
                }
                .onAppear { presenter.sheetDidAppear() }
            }
    }
}
