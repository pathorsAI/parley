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
    /// system minimum and the layout looks broken. 258 leaves room for the
    /// status line, the preview well, the mic control, and the key row without
    /// crowding, and sits in the same band as the system keyboard.
    private static let preferredHeight: CGFloat = 258

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
        let height = view.heightAnchor.constraint(equalToConstant: Self.preferredHeight)
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

    /// Prepare a session: mint an id, capture the host app for the app's
    /// auto-return, and publish the request. Returns the URL the SwiftUI view
    /// should open (its `openURL` action is the path that still works on iOS
    /// 18+); `openContainerApp` is the older-system fallback.
    func prepareDictation() -> URL? {
        guard hasFullAccess else { return nil }
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
        return DictationChannel.startURL(session: session)
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

    /// Read the transcript the app has published and insert whatever is new.
    /// Idempotent: `insertedCount` is the high-water mark, so a keyboard that
    /// was killed and relaunched mid-session never re-inserts settled text.
    private func drainDownlink() {
        guard hasFullAccess, let d = DictationChannel.readDownlink(), d.session == session
        else { return }

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
        case .done, .error:
            bridge.listening = false
            bridge.partial = ""
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

    func insertSpace() { textDocumentProxy.insertText(" ") }
    func insertNewline() { textDocumentProxy.insertText("\n") }
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

    /// Mint the session and return the URL for the SwiftUI `openURL` action.
    func prepare() -> URL? { controller?.prepareDictation() }
    /// Older-iOS fallback when `openURL` reports the app didn't open.
    func fallbackOpen(_ url: URL) { controller?.openContainerApp(url) }
    func stop() { controller?.stopDictation() }
    func space() { controller?.insertSpace() }
    func newline() { controller?.insertNewline() }
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
