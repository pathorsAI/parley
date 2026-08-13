import ParleyKit
import SwiftUI
import UIKit

/// The Parley dictation keyboard.
///
/// A keyboard extension is forbidden from opening the microphone, so this
/// keyboard doesn't try. Its mic button opens `parley://dictate`; the container
/// app records and streams the transcript back through the App Group; this
/// keyboard inserts the settled text with `textDocumentProxy.insertText`. The
/// design and its constraints are written up in
/// `docs/design/ios-voice-keyboard.md`.
///
/// Everything expensive (audio, the relay, any model) stays in the app. This
/// process only shuttles text, which keeps it well under the tight jetsam limit
/// keyboard extensions run against.
final class KeyboardViewController: UIInputViewController {
    private let bridge = KeyboardBridge()
    private var down: DarwinObserver?

    /// The keyboard's view of the current session. It mints the id, so it owns
    /// the truth about which downlink is "ours"; a downlink for any other
    /// session is a leftover from a previous dictation and is ignored.
    private var session = ""
    private var insertedCount = 0
    private var host: UIHostingController<KeyboardRootView>?

    /// A keyboard has no intrinsic height — without this it collapses to the
    /// system minimum and the layout looks broken. The taller variant makes
    /// room for the globe row that only exists on devices where the system
    /// doesn't draw its own input switcher next to the home indicator.
    private var preferredHeight: CGFloat {
        needsInputModeSwitchKey ? 252 : 216
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        bridge.controller = self

        let root = UIHostingController(rootView: makeRoot())
        root.view.backgroundColor = .clear
        addChild(root)
        view.addSubview(root.view)
        root.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            root.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            root.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            root.view.topAnchor.constraint(equalTo: view.topAnchor),
            root.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        root.didMove(toParent: self)
        self.host = root

        // Priority just below required: the system still gets to shrink the
        // keyboard in a compact-height (landscape) layout rather than fighting
        // an unsatisfiable constraint.
        let height = view.heightAnchor.constraint(equalToConstant: preferredHeight)
        height.priority = .defaultHigh
        height.isActive = true

        // The app fires this when the transcript grows; we also drain on every
        // appearance in case the keyboard was suspended through the notification.
        if hasFullAccess {
            down = DarwinObserver(DictationChannel.downNote) { [weak self] in
                DispatchQueue.main.async { self?.drainDownlink() }
            }
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        bridge.hasFullAccess = hasFullAccess
        // Only devices where the system doesn't draw its own switcher beside
        // the home indicator need a globe inside the keyboard (4.4.1 — the
        // user must always have a way out of this keyboard).
        bridge.needsGlobe = needsInputModeSwitchKey
        refreshAppearance()
        drainDownlink()
    }

    /// A keyboard follows the appearance of the *field* it is typing into, not
    /// the system's: a dark-themed host app asks for a dark keyboard even while
    /// iOS is in light mode. `textInputMode` changes as the user moves between
    /// fields, so this is re-read whenever the keyboard comes back.
    override func textDidChange(_ textInput: UITextInput?) {
        super.textDidChange(textInput)
        refreshAppearance()
    }

    private func refreshAppearance() {
        let dark = textDocumentProxy.keyboardAppearance == .dark
        if host?.rootView.dark != dark {
            host?.rootView = makeRoot(dark: dark)
        }
    }

    private func makeRoot(dark: Bool? = nil) -> KeyboardRootView {
        KeyboardRootView(
            bridge: bridge,
            dark: dark ?? (textDocumentProxy.keyboardAppearance == .dark))
    }

    // MARK: dictation control (called from SwiftUI)

    /// How long the keyboard waits for the app to acknowledge a start request
    /// before falling back to opening the app. An awake app publishes the
    /// `starting` downlink within milliseconds of the Darwin note; a suspended
    /// or dead app never will, and the only thing that can wake it is the URL.
    private static let startAckWindow: Duration = .milliseconds(700)

    /// Start a session, preferring the path with no app switch: publish the
    /// request to the App Group (which posts the uplink note) and wait briefly
    /// for the app to acknowledge by publishing our session's downlink. The
    /// app hears the note whenever it is awake — foreground, or lingering in
    /// the background right after a previous dictation — and starts the mic
    /// there, so the user never leaves the app they're typing in. Only when
    /// the ack never comes does `completion` hand back the `parley://dictate`
    /// URL for the visible round trip.
    func startDictation(completion: @escaping (URL?) -> Void) {
        guard hasFullAccess else { return }
        session = UUID().uuidString
        insertedCount = 0
        DictationChannel.writeUplink(
            .init(
                session: session,
                hostBundleID: KeyboardHost.bundleID(of: self),
                stopRequested: false,
                insertedCount: 0))
        bridge.listening = true
        bridge.partial = ""
        bridge.errorText = nil

        let target = session
        Task { @MainActor [weak self] in
            let deadline = ContinuousClock.now + Self.startAckWindow
            while ContinuousClock.now < deadline {
                try? await Task.sleep(for: .milliseconds(80))
                guard let self, self.session == target else { return }
                if DictationChannel.readDownlink()?.session == target {
                    return  // acked — the app is recording, nobody moved
                }
            }
            guard let self, self.session == target else { return }
            completion(DictationChannel.startURL(session: target))
        }
    }

    /// Ask the app to stop and flush the tail. The app is running during
    /// dictation, so the Darwin note reaches it.
    func stopDictation() {
        guard !session.isEmpty else { return }
        var up = DictationChannel.readUplink() ?? .init(session: session)
        up.session = session
        up.stopRequested = true
        up.insertedCount = insertedCount
        DictationChannel.writeUplink(up)
        bridge.listening = false
    }

    /// How old a downlink may be and still get adopted by a keyboard that
    /// didn't mint its session. Sessions are hard-capped at 120 s (the app's
    /// `maxSeconds`), and every segment and state change re-stamps the file, so
    /// anything older is a leftover — a crashed app's frozen `listening` file
    /// or a long-finished transcript that would land in the wrong field.
    private static let adoptionWindow: TimeInterval = 150

    /// Read the transcript the app has published and insert whatever is new.
    /// Idempotent: `insertedCount` is the high-water mark, so a keyboard that
    /// was killed and relaunched mid-session never re-inserts settled text.
    private func drainDownlink() {
        guard hasFullAccess, let d = DictationChannel.readDownlink() else { return }

        // Adopt a session this process didn't mint. iOS kills the keyboard
        // almost every time the user bounces to the app, so on the way back the
        // downlink belongs to a session the (relaunched) keyboard has never
        // heard of — refusing it is what made returning feel dead. (This also
        // covers Action Button sessions, which no keyboard minted.)
        //
        // A foreign downlink is adopted only when it answers the *standing*
        // uplink request and is fresh. The uplink match is what makes this
        // safe: it proves the high-water mark in that uplink belongs to this
        // very session, so nothing already inserted can re-insert — and a
        // keyboard that just minted a new session (its uplink carries the new
        // id) can never resurrect the previous transcript. Errors are never
        // adopted; the message belongs on the app's screen, not in a field.
        if d.session != session {
            guard d.state != .error,
                let at = d.updatedAt,
                Date().timeIntervalSince(at) < Self.adoptionWindow,
                DictationChannel.readUplink()?.session == d.session
            else { return }
            session = d.session
            insertedCount = 0
        }

        // A relaunched keyboard restores its position from the uplink it wrote.
        if insertedCount == 0, let up = DictationChannel.readUplink(), up.session == session {
            insertedCount = up.insertedCount
        }

        let committed = Array(d.committed)
        if committed.count > insertedCount {
            let delta = String(committed[insertedCount...])
            textDocumentProxy.insertText(delta)
            insertedCount = committed.count
            var up = DictationChannel.readUplink() ?? .init(session: session)
            up.insertedCount = insertedCount
            DictationChannel.writeUplink(up)
        }

        bridge.partial = d.partial
        switch d.state {
        case .starting, .listening: bridge.listening = true
        case .finishing: bridge.listening = true
        case .done:
            bridge.listening = false
            bridge.partial = ""
        case .error:
            bridge.listening = false
            bridge.partial = ""
            // Surface the app's failure where the user actually is. Swallowing
            // it (the old behavior) read as "the mic button does nothing".
            bridge.errorText = d.errorMessage ?? String(localized: "Couldn't start. Try again.")
        }
    }

    /// Open the container app from the extension. The classic responder-chain
    /// `openURL:` walk was disabled for keyboards in iOS 18; SwiftUI's `openURL`
    /// environment action is the public path that still works, so the mic
    /// button in `KeyboardRootView` uses that. This UIKit fallback covers older
    /// systems where the responder walk still succeeds.
    func openContainerApp(_ url: URL) {
        var responder: UIResponder? = self
        let sel = NSSelectorFromString("openURL:")
        while let r = responder {
            if r.responds(to: sel) {
                r.perform(sel, with: url)
                return
            }
            responder = r.next
        }
    }

    // MARK: minimal keys (called from SwiftUI)

    func deleteBackward() { textDocumentProxy.deleteBackward() }
    func switchKeyboard() { advanceToNextInputMode() }
}

/// Bridges the UIKit input controller to the SwiftUI view: published state the
/// view renders, and actions it invokes. Kept tiny — no transcript history, no
/// audio, nothing that grows.
final class KeyboardBridge: ObservableObject {
    weak var controller: KeyboardViewController?

    @Published var hasFullAccess = false
    @Published var listening = false
    @Published var partial = ""
    /// The app's failure for the last session (sign-in, mic permission,
    /// connection), shown in the caption slot until the next start.
    @Published var errorText: String?
    /// Whether this device needs a globe inside the keyboard (no system
    /// switcher next to the home indicator).
    @Published var needsGlobe = false

    /// Start a session. `completion` fires only when the app has to be opened
    /// (the no-jump Darwin start wasn't acknowledged) with the URL for the
    /// SwiftUI `openURL` action.
    func start(completion: @escaping (URL?) -> Void) {
        controller?.startDictation(completion: completion)
    }
    /// Older-iOS fallback when `openURL` reports the app didn't open.
    func fallbackOpen(_ url: URL) { controller?.openContainerApp(url) }
    func stop() { controller?.stopDictation() }
    func backspace() { controller?.deleteBackward() }
    func nextKeyboard() { controller?.switchKeyboard() }
}

/// Best-effort resolution of the app the keyboard is typing into, for the app's
/// pre-iOS-26.4 auto-return. There is no public API; the host bundle id lives on
/// private getters that Apple nulled out in iOS 26.4. Each candidate getter is
/// assembled at runtime and reached through `responds(to:)`/`perform` so no
/// literal private symbol sits in the binary and a missing getter is a `nil`,
/// never a crash. On 26.4+ every candidate returns nil and the app falls back to
/// the manual swipe.
enum KeyboardHost {
    static func bundleID(of vc: UIInputViewController) -> String? {
        let getters = [
            ["_host", "BundleID"].joined(),
            ["_host", "Application", "BundleIdentifier"].joined(),
        ]
        for name in getters {
            let sel = NSSelectorFromString(name)
            guard vc.responds(to: sel),
                let value = vc.perform(sel)?.takeUnretainedValue() as? String,
                !value.isEmpty
            else { continue }
            return value
        }
        return nil
    }
}
