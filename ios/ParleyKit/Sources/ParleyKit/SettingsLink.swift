import Foundation

/// `parley://settings/…` — the keyboard's links into the app's Settings, from
/// the saved-info panel's empty state.
///
/// One destination today. 1.30 also had `parley://settings/clipboard`, for the
/// clipboard history that is gone (see `RetiredClipboard`); a link to it from
/// an old keyboard now parses to `nil`, and the app simply opens.
public enum SettingsLink: String, CaseIterable, Sendable {
    /// Settings › 常用資訊.
    case snippets

    public var url: URL {
        URL(string: "parley://settings/\(rawValue)")!
    }

    public init?(url: URL) {
        guard url.scheme == "parley", url.host == "settings" else { return nil }
        let path = url.pathComponents.filter { $0 != "/" }
        guard let first = path.first, let link = SettingsLink(rawValue: first) else { return nil }
        self = link
    }
}
