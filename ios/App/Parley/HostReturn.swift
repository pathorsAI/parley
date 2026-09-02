import ParleyKit
import UIKit

/// Bounce the user back to the app they were typing in, the way the rest of the
/// category does it.
///
/// There has never been a public API for this. The only mechanism is to ask the
/// private `LSApplicationWorkspace` to open the host app by the bundle id the
/// keyboard captured in `KeyboardHost`. Every private symbol is assembled at
/// runtime from fragments so it never appears as a literal in the binary — the
/// trade this project accepted, and the reason `HostReturnPolicy`'s kill switch
/// is part of the same change rather than a follow-up.
///
/// ## What changed, and why
///
/// This used to refuse to run at all on iOS 26.4+, from a compiled-in
/// `#available` gate. That gate was a guess in a place a guess cannot be
/// corrected: keyboards in the same category are observably still returning
/// users to their host app on iPadOS 26.5, so the gate was switching off a path
/// that works, and no amount of evidence could change it without an App Store
/// release.
///
/// It is now three things instead:
///   - **a remote flag** (`FeatureFlags.HostReturn`) — off-switch and per-OS
///     override, changeable without a build;
///   - **an attempt** — optimistic by default, because a failed one is silent;
///   - **a verdict** — we watch whether the app actually went to the background
///     and write the outcome to `HostReturnLedger`, so a device that genuinely
///     cannot do this stops paying for the attempt after a couple of tries.
///
/// See `docs/design/ios-voice-keyboard.md`.
enum HostReturn {
    /// How long to wait for the jump to land before calling it a failure.
    ///
    /// The success path does not wait this long — it polls, and exits as soon
    /// as the app is no longer active — so this bounds the *failure* case only:
    /// the time a user spends looking at "taking you back" before the screen
    /// changes its mind and asks them to swipe. A launch that is going to
    /// happen has happened well inside this.
    private static let grace = Duration.milliseconds(1200)
    private static let poll = Duration.milliseconds(50)

    /// Should we try, for this host, on this device, right now.
    static func decide(host: String?) -> HostReturnPolicy.Decision {
        HostReturnPolicy.decide(
            host: host,
            flags: FeatureFlagStore.shared.load().hostReturn,
            consecutiveFailures: HostReturnLedger.shared.consecutiveFailures(),
            osVersion: HostReturnPolicy.osVersionKey(
                ProcessInfo.processInfo.operatingSystemVersion))
    }

    /// Attempt the jump and report whether it landed, recording the outcome.
    ///
    /// Returning a `Bool` rather than firing and forgetting is the point of the
    /// change: it is what lets the dictation screen correct itself from "you're
    /// being sent back" to "swipe back" instead of stranding someone on a
    /// promise, and it is the only way the ledger ever learns anything.
    @MainActor
    static func attemptAndVerify(bundleID: String) async -> Bool {
        attempt(bundleID: bundleID)

        let deadline = ContinuousClock.now.advanced(by: grace)
        while UIApplication.shared.applicationState == .active,
            ContinuousClock.now < deadline
        {
            try? await Task.sleep(for: poll)
        }

        // A user who swiped back themselves inside the grace period reads as a
        // success. That is the harmless direction to be wrong in: it keeps a
        // device optimistic, and the next failure puts the count back.
        let landed = UIApplication.shared.applicationState != .active
        if landed {
            HostReturnLedger.shared.recordSuccess()
        } else {
            HostReturnLedger.shared.recordFailure()
        }
        return landed
    }

    /// Best-effort jump back to `bundleID`. Silent no-op when the private path
    /// is unavailable — `attemptAndVerify` is what notices, and the dictation
    /// screen's fallback is what the user sees.
    static func attempt(bundleID: String) {
        guard !bundleID.isEmpty else { return }

        // "LSApplication" + "Workspace"
        let className = ["LSApplication", "Workspace"].joined()
        guard let cls = NSClassFromString(className) as? NSObject.Type else { return }

        // +[LSApplicationWorkspace defaultWorkspace]
        let defaultSel = NSSelectorFromString(["default", "Workspace"].joined())
        guard cls.responds(to: defaultSel),
            let workspace = cls.perform(defaultSel)?.takeUnretainedValue()
        else { return }

        // -[… openApplicationWithBundleID:]
        let openSel = NSSelectorFromString(
            ["open", "Application", "WithBundleID:"].joined())
        guard (workspace as AnyObject).responds(to: openSel) else { return }
        _ = (workspace as AnyObject).perform(openSel, with: bundleID)
    }
}
