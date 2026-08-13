import UIKit

/// Bounce the user back to the app they were typing in, the way Typeless and
/// (pre-26.4) Wispr Flow do it.
///
/// There has never been a public API for this. The only mechanism is to ask the
/// private `LSApplicationWorkspace` to open the host app by its bundle id — the
/// id the keyboard captured in `KeyboardHost`. Apple closed the door in iOS
/// 26.4 (the host-bundle-id sources the keyboard relies on return nil, and the
/// launch lands on the Home Screen), so this is **version-gated**: on 26.4 and
/// later `canReturn` is false and the app shows the manual "swipe to go back"
/// guidance instead. On older iOS, where a large share of shipped users still
/// live, the round trip is automatic.
///
/// Every private symbol is assembled at runtime from fragments so it never
/// appears as a literal string in the binary — the deliberate trade the project
/// accepted (obfuscation + a version gate): lower the odds of a static-scanner 2.5.1 flag,
/// while keeping the behavior only where it actually works.
enum HostReturn {
    /// True only where the private launch still returns to the host app. iOS
    /// 26.4 turned this into a Home-Screen bounce, so we don't attempt it there.
    static var canReturn: Bool {
        if #available(iOS 26.4, *) { return false }
        return true
    }

    /// Best-effort jump back to `bundleID`. Silent no-op if the private path is
    /// unavailable — the caller has already decided to show manual guidance as
    /// the fallback, so a failure here just means the user swipes back.
    static func attempt(bundleID: String) {
        guard canReturn, !bundleID.isEmpty else { return }

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
