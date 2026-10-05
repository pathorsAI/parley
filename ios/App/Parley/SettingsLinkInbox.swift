import Combine
import ParleyKit

/// Holds a `parley://settings/…` request — the keyboard's saved-info panel
/// linking to Settings › 常用資訊 — until Settings is there to act on it, the
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
