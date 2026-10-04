import Combine
import ParleyKit
import UIKit

/// The app's side of the keyboard's clipboard features: capturing into the
/// shared history when Parley comes to the front, and telling the keyboard
/// which pasteboard writes were Parley's own.
///
/// The history and its rules live in ParleyKit (`ClipboardHistoryStore`,
/// `ClipboardRules`); the keyboard's half is `KeyboardClipboard`. See the
/// keyboard's design doc, "The strip slot and the clipboard".
enum AppClipboard {
    /// 「自動收錄剪貼簿」 is on and Parley just became active: keep what is on
    /// the pasteboard, once per copy.
    ///
    /// Reading the pasteboard from the app shows iOS's paste banner, or its
    /// 「允許貼上」 prompt when 「從其他 App 貼上」 is set to ask — which is why
    /// it only happens with the setting on, and why Settings says to set that
    /// switch to 允許 next to it. A concealed pasteboard (a password manager's)
    /// is never read at all; everything else goes through the same exclusions
    /// the keyboard applies, including the user's own sensitive 常用資訊.
    static func captureIfEnabled() {
        guard ClipboardSettings.autoCapture() else { return }
        let board = UIPasteboard.general
        let count = board.changeCount
        guard ClipboardSettings.lastCapturedChangeCount() != count else { return }
        ClipboardSettings.setLastCapturedChangeCount(count)
        guard board.hasStrings || board.hasURLs else { return }
        let types = board.types
        guard !ClipboardRules.isConcealed(types: types),
            let text = board.string ?? board.url?.absoluteString
        else { return }
        let blocked = SnippetStore.sensitiveValues(in: SnippetStore.shared()?.load() ?? [])
        ClipboardHistoryStore.shared()?.capture(text, types: types, blocked: blocked)
    }

    /// Parley wrote the pasteboard. The keyboard's paste chip is for things
    /// copied elsewhere, so this generation is marked as already seen.
    static func noteOwnWrite() {
        ClipboardSettings.noteOwnWrite(changeCount: UIPasteboard.general.changeCount)
    }
}

/// Holds a `parley://settings/…` request — the keyboard's 📋 panel linking to
/// Settings › 剪貼簿 or 常用資訊 — until Settings is there to act on it, the
/// way `QuickRecordInbox` holds a lock-screen record request for the Record tab.
@MainActor
final class SettingsLinkInbox: ObservableObject {
    static let shared = SettingsLinkInbox()

    @Published private(set) var request: SettingsLink?

    func post(_ link: SettingsLink) {
        request = link
    }

    /// The pending request, cleared so it is acted on once.
    func take() -> SettingsLink? {
        defer { request = nil }
        return request
    }
}
