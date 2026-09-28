import SwiftUI
import UIKit

/// The two floating surfaces the feedback module draws over the app: a toast at
/// the bottom (the screenshot offer, the post-delete offer, "Sent. Thank you.")
/// and a banner at the top (the crash question).
///
/// ## Why windows of their own, and why they are only as big as what they show
///
/// A toast has to appear over whatever is on screen, and what is on screen is
/// often a sheet — the folder picker, What's New, the report sheet itself
/// having just closed. SwiftUI cannot draw over a sheet from the view that
/// presented it, so each surface lives in a `UIWindow` above the app's.
///
/// The screenshot toast must also **not block anything**: someone who took a
/// screenshot to share a transcript should be able to carry on tapping as if it
/// were not there. A full-screen pass-through window cannot promise that with
/// SwiftUI inside it — a `UIHostingController`'s view answers hit tests for
/// the empty space around its content as readily as for a button, so there is
/// no reliable way to tell "tap on the toast" from "tap beside it". So each
/// window is sized to its content and nothing more. A tap that is not on the
/// toast is not in the window, and goes to the app underneath unaided.
@MainActor
final class FeedbackOverlay {
    static let shared = FeedbackOverlay()

    enum Edge { case top, bottom }

    private var windows: [Edge: UIWindow] = [:]
    private var timers: [Edge: Task<Void, Never>] = [:]
    /// What to do if the toast on an edge goes away without being used — timed
    /// out, or replaced by the next one. Cleared by `dismiss(_:used:)` with
    /// `used: true`.
    private var onIgnored: [Edge: () -> Void] = [:]

    /// Put `content` on `edge`, replacing whatever was there. `duration` nil
    /// means it stays until dismissed.
    func show<Content: View>(
        _ content: Content, on edge: Edge, duration: TimeInterval?,
        onIgnored: (() -> Void)? = nil
    ) {
        dismiss(edge, used: false, animated: false)
        guard let scene = Self.activeScene() else {
            // No scene to draw in — launch, or the app is going away. Nothing
            // was shown, so nothing was ignored either.
            return
        }
        let host = UIHostingController(
            rootView: AnyView(
                content
                    .tint(Theme.primary)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)))
        host.view.backgroundColor = .clear
        // The window is sized to the content and placed by hand, so the safe
        // area is already accounted for in *where* it sits. Left on, the
        // hosting view pads the content by the screen's insets a second time
        // — which draws the toast below its own window, where it can be seen
        // but not tapped.
        host.safeAreaRegions = []
        let window = OverlayWindow(windowScene: scene)
        // Above the app's window and every sheet it presents; below the
        // system's own alerts.
        window.windowLevel = UIWindow.Level(rawValue: UIWindow.Level.normal.rawValue + 10)
        window.backgroundColor = .clear
        window.overrideUserInterfaceStyle = Self.interfaceStyle()
        window.rootViewController = host
        window.frame = Self.frame(for: host, edge: edge, in: scene)
        window.alpha = 0
        window.isHidden = false
        windows[edge] = window
        self.onIgnored[edge] = onIgnored
        UIView.animate(withDuration: 0.2) { window.alpha = 1 }
        UIAccessibility.post(notification: .layoutChanged, argument: host.view)

        if let duration {
            timers[edge] = Task { [weak self] in
                try? await Task.sleep(for: .seconds(duration))
                guard !Task.isCancelled else { return }
                self?.dismiss(edge, used: false)
            }
        }
    }

    /// Take the surface on `edge` down. `used` says whether the user acted on
    /// it; if not, its `onIgnored` runs — which is how a toast that timed out
    /// counts as a dismissal for the frequency limits.
    func dismiss(_ edge: Edge, used: Bool, animated: Bool = true) {
        timers[edge]?.cancel()
        timers[edge] = nil
        let ignored = onIgnored.removeValue(forKey: edge)
        if !used { ignored?() }
        guard let window = windows.removeValue(forKey: edge) else { return }
        guard animated else {
            window.isHidden = true
            return
        }
        UIView.animate(withDuration: 0.2) {
            window.alpha = 0
        } completion: { _ in
            window.isHidden = true
        }
    }

    func isShowing(_ edge: Edge) -> Bool { windows[edge] != nil }

    private static func frame(
        for host: UIHostingController<AnyView>, edge: Edge, in scene: UIWindowScene
    )
        -> CGRect
    {
        let bounds = scene.screen.bounds
        let insets = scene.keyWindow?.safeAreaInsets ?? .zero
        let fitting = host.sizeThatFits(
            in: CGSize(width: min(bounds.width, 520), height: bounds.height / 2))
        let width = min(fitting.width, bounds.width)
        let x = (bounds.width - width) / 2
        switch edge {
        case .top:
            return CGRect(x: x, y: insets.top + 4, width: width, height: fitting.height)
        case .bottom:
            // Clear of the tab bar: its 49pt plus the home indicator's inset,
            // so the toast never sits on the controls people are reaching for.
            let y = bounds.height - insets.bottom - 49 - 8 - fitting.height
            return CGRect(x: x, y: y, width: width, height: fitting.height)
        }
    }

    /// The foreground scene, or failing that any window scene the app has.
    static func activeScene() -> UIWindowScene? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
    }

    /// The app's key window — never one of these overlays, which are never
    /// made key.
    static func appWindow() -> UIWindow? {
        guard let scene = activeScene() else { return nil }
        if let key = scene.keyWindow, !(key is OverlayWindow) { return key }
        return scene.windows.first { !($0 is OverlayWindow) && $0.windowLevel == .normal }
    }

    /// The overlay windows are not under the app's SwiftUI root, so they do
    /// not inherit its `preferredColorScheme`; the stored theme is read the same
    /// way `AppState.theme` reads it.
    static func interfaceStyle() -> UIUserInterfaceStyle {
        switch AppTheme(rawValue: UserDefaults.standard.string(forKey: "theme") ?? "") {
        case .light?: return .light
        case .dark?: return .dark
        default: return .unspecified
        }
    }

    /// The view controller a sheet should be presented from: the top of
    /// whatever the app's window is already presenting.
    static func topViewController() -> UIViewController? {
        var top = appWindow()?.rootViewController
        while let presented = top?.presentedViewController, !presented.isBeingDismissed {
            top = presented
        }
        return top
    }
}


/// A window that is never key.
///
/// Since iOS 15 a window the user taps becomes the key window. For a toast
/// that is exactly wrong: the tap on "Report" made the toast's window key, the
/// report sheet was then presented from "the key window's top controller" —
/// the toast — and the toast's window was hidden a moment later, taking the
/// sheet with it. It would also pull the keyboard's focus out of a text field
/// the user was typing in. Refusing key status keeps the app's own window key
/// throughout.
private final class OverlayWindow: UIWindow {
    override var canBecomeKey: Bool { false }
}
