import Foundation
import ParleyKit
import SwiftUI

/// The Library's getting-started checklist, persisted.
///
/// A thin shell over `GettingStartedState` (ParleyKit, where the rules are
/// unit-tested): it reads the state out of `UserDefaults.standard` once, writes
/// it back on every change, and publishes so the Library redraws. No App Group
/// — neither extension has anything to say about it.
///
/// ## Who never sees it
///
/// Existing users. Two signals, both cheap:
///
/// 1. **The Keychain, at the first launch of this build.** When the stored
///    state is absent, the store is being created for the first time on this
///    phone; if a session token is *already* in the Keychain at that moment,
///    the user signed in under an earlier build and the list starts dismissed.
///    `ParleyApp.init` touches `shared` before anything can sign in, so a new
///    user's first sign-in can never be mistaken for an old one.
/// 2. **The library, the first time it loads.** A Mac user signing in on a new
///    phone has no token yet, so the Keychain calls them new. The first
///    successful personal-library load settles it — recordings already there
///    with nothing on the list done means they were made elsewhere — and is
///    checked once per install (`GettingStartedState.shouldDismissForExistingLibrary`).
@MainActor
final class GettingStartedStore: ObservableObject {
    static let shared = GettingStartedStore()

    private static let stateKey = "gettingStarted.v1"
    private static let libraryCheckedKey = "gettingStarted.libraryChecked"

    @Published private(set) var state: GettingStartedState

    private let defaults: UserDefaults

    init(
        defaults: UserDefaults = .standard,
        hadStoredSession: @autoclosure () -> Bool = KeychainStore.get(AppState.tokenKey) != nil
    ) {
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.stateKey),
            let saved = try? JSONDecoder().decode(GettingStartedState.self, from: data)
        {
            state = saved
        } else {
            state = .initial(hadStoredSession: hadStoredSession())
            // Written at once, so the migration runs exactly once: the next
            // launch finds a stored state and never asks the Keychain again.
            save()
        }
    }

    var recorded: Bool { state.recorded }
    var filed: Bool { state.filed }
    var replayed: Bool { state.replayed }
    var sharedToAI: Bool { state.sharedToAI }
    var dismissedAt: Date? { state.dismissedAt }

    /// Shown until dismissed or all four are done.
    var isVisible: Bool { state.isVisible }
    /// done / 4.
    var progress: Double { state.progress }
    var done: Int { state.done }

    /// Tick an item from the code path where the event actually succeeded.
    /// Idempotent: a second call writes nothing and publishes nothing.
    func mark(_ step: GettingStartedStep) {
        var next = state
        guard next.mark(step) else { return }
        state = next
        save()
    }

    /// For callers off the main actor — the upload queue, which saves a
    /// recording from wherever its task happens to run.
    nonisolated static func markSoon(_ step: GettingStartedStep) {
        Task { @MainActor in shared.mark(step) }
    }

    /// "Not now". The list stays closed until Settings brings it back.
    func dismiss() {
        state.dismiss()
        save()
    }

    /// Settings → "Show the getting-started list again": everything unticked,
    /// nothing dismissed.
    func reset() {
        state = GettingStartedState()
        save()
    }

    /// The second existing-user check — see the type doc. `recordingCount`
    /// must exclude the sample. Runs once per install; later loads are no-ops.
    func noteLibraryLoaded(recordingCount: Int) {
        guard !defaults.bool(forKey: Self.libraryCheckedKey) else { return }
        defaults.set(true, forKey: Self.libraryCheckedKey)
        if state.shouldDismissForExistingLibrary(recordingCount: recordingCount) {
            dismiss()
        }
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(state) else { return }
        defaults.set(data, forKey: Self.stateKey)
    }
}
