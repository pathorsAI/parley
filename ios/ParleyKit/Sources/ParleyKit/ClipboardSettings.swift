import Foundation

/// Settings › 剪貼簿, shared with the keyboard.
///
/// In the App Group's `UserDefaults`, like `TypingKeyboards`: these are
/// settings, not a live hand-off, and the keyboard re-reads them when it next
/// appears. Every reader takes the defaults as a parameter so the tests can
/// hand it a private suite.
public enum ClipboardSettings {
    public static let autoCaptureKey = "clipboard.autoCapture"
    public static let retentionKey = "clipboard.retention"
    public static let previewKey = "clipboard.previewInStrip"
    /// The paste chip's memory — see `PasteOffer`.
    public static let pasteOfferKey = "clipboard.pasteOffer"
    /// The pasteboard `changeCount` whose contents were last captured into the
    /// history, by either process. What stops an appearance from reading the
    /// pasteboard again for text it already kept.
    public static let lastCapturedKey = "clipboard.lastCapturedChangeCount"

    public static var shared: UserDefaults? {
        UserDefaults(suiteName: DictationChannel.appGroup)
    }

    /// 自動收錄剪貼簿. **Off by default.** Reading the pasteboard without the
    /// user asking is the one thing about a clipboard feature that has to be
    /// opted into: it shows iOS's paste banner (or prompt) every time, and it
    /// is a keyboard reading what someone copied in another app.
    public static func autoCapture(in defaults: UserDefaults? = shared) -> Bool {
        defaults?.object(forKey: autoCaptureKey) as? Bool ?? false
    }

    public static func setAutoCapture(_ on: Bool, in defaults: UserDefaults? = shared) {
        defaults?.set(on, forKey: autoCaptureKey)
    }

    /// 保留時間. A day when never set, and when the stored value is one this
    /// build does not know.
    public static func retention(in defaults: UserDefaults? = shared) -> ClipboardRetention {
        defaults?.string(forKey: retentionKey).flatMap(ClipboardRetention.init(rawValue:))
            ?? .default
    }

    public static func setRetention(_ value: ClipboardRetention, in defaults: UserDefaults? = shared) {
        defaults?.set(value.rawValue, forKey: retentionKey)
    }

    /// 在狀態列預覽剪貼簿內容. **Off by default**, and turning it on is the
    /// user saying they have set iOS's 「從其他 App 貼上」 to 允許 — without
    /// that, every appearance of the keyboard with something new on the
    /// pasteboard would ask them.
    public static func previewInStrip(in defaults: UserDefaults? = shared) -> Bool {
        defaults?.object(forKey: previewKey) as? Bool ?? false
    }

    public static func setPreviewInStrip(_ on: Bool, in defaults: UserDefaults? = shared) {
        defaults?.set(on, forKey: previewKey)
    }

    public static func pasteOffer(in defaults: UserDefaults? = shared) -> PasteOffer? {
        guard let data = defaults?.data(forKey: pasteOfferKey) else { return nil }
        return try? JSONDecoder().decode(PasteOffer.self, from: data)
    }

    public static func setPasteOffer(_ offer: PasteOffer, in defaults: UserDefaults? = shared) {
        guard let data = try? JSONEncoder().encode(offer) else { return }
        defaults?.set(data, forKey: pasteOfferKey)
    }

    /// Parley itself just wrote the pasteboard — the keyboard's tap-to-copy,
    /// or a copy anywhere in the app. Call with the `changeCount` read right
    /// after the write: the paste chip is for things copied *elsewhere*, and
    /// offering to paste what the user just copied out of Parley would be a
    /// chip about itself.
    public static func noteOwnWrite(changeCount: Int, now: Date = Date(), in defaults: UserDefaults? = shared) {
        setPasteOffer(.ownWrite(changeCount: changeCount, at: now), in: defaults)
    }

    public static func lastCapturedChangeCount(in defaults: UserDefaults? = shared) -> Int? {
        defaults?.object(forKey: lastCapturedKey) as? Int
    }

    public static func setLastCapturedChangeCount(_ value: Int, in defaults: UserDefaults? = shared) {
        defaults?.set(value, forKey: lastCapturedKey)
    }
}

/// The paste chip's memory, kept in the App Group so it survives the keyboard
/// process being torn down between appearances (it is, constantly).
///
/// The keyboard never reads the pasteboard to decide whether to offer a paste.
/// It compares `UIPasteboard.changeCount` — a counter that moves on every write
/// and costs nothing to read, with no banner and no prompt — against the one it
/// last saw. A new count is a new copy somewhere; the chip is offered for it
/// once, for `lifetime`, until it is used or the user types past it.
public struct PasteOffer: Codable, Equatable, Sendable {
    /// The pasteboard generation this is about.
    public var changeCount: Int
    /// When the keyboard first noticed it.
    public var noticedAt: Date
    /// Used, typed past, or Parley's own write: not offered again for this
    /// generation.
    public var closed: Bool

    /// How long a new copy is offered after it was first noticed.
    public static let lifetime: TimeInterval = 3 * 60

    public init(changeCount: Int, noticedAt: Date, closed: Bool) {
        self.changeCount = changeCount
        self.noticedAt = noticedAt
        self.closed = closed
    }

    /// A generation Parley wrote itself: closed from the start.
    public static func ownWrite(changeCount: Int, at now: Date) -> PasteOffer {
        PasteOffer(changeCount: changeCount, noticedAt: now, closed: true)
    }

    /// When an open offer stops being shown.
    public var expiresAt: Date { noticedAt.addingTimeInterval(Self.lifetime) }

    public func isShowing(at now: Date) -> Bool {
        !closed && now < expiresAt
    }

    public var closing: PasteOffer {
        var next = self
        next.closed = true
        return next
    }

    /// What the keyboard does with the pasteboard as it finds it.
    ///
    /// - With nothing remembered — the first appearance after install — the
    ///   current generation becomes the baseline and is not offered: whatever
    ///   is on the pasteboard then was copied before this feature existed, and
    ///   could be days old.
    /// - A generation that has moved is new: noticed now, and offered when the
    ///   pasteboard holds text or a URL (an image is not something this
    ///   keyboard pastes).
    /// - The same generation keeps whatever it was: shown until it expires or
    ///   is closed.
    ///
    /// Returns the offer to remember and whether the chip shows.
    public static func evaluate(
        changeCount: Int, hasText: Bool, remembered: PasteOffer?, now: Date
    ) -> (offer: PasteOffer, shows: Bool) {
        guard let remembered else {
            return (PasteOffer(changeCount: changeCount, noticedAt: now, closed: true), false)
        }
        guard remembered.changeCount == changeCount else {
            let fresh = PasteOffer(changeCount: changeCount, noticedAt: now, closed: !hasText)
            return (fresh, fresh.isShowing(at: now))
        }
        return (remembered, hasText && remembered.isShowing(at: now))
    }
}

/// What the paste chip says.
public enum PasteChipLabel: Equatable, Sendable {
    /// 📋 貼上網址
    case url
    /// 📋 貼上文字
    case text
    /// 📋 貼上 <the first few characters>
    case preview(String)

    /// The label for a pasteboard with these facts. `previewText` is the
    /// pasteboard's string, read only when the user turned the preview on and
    /// the pasteboard is not concealed; a string that looks like a secret is
    /// still not shown, so the label falls back to the type.
    public static func make(hasURL: Bool, previewText: String?) -> PasteChipLabel {
        if let previewText, !ClipboardRules.looksSecret(previewText),
            case let snippet = ClipboardPreview.snippet(previewText), !snippet.isEmpty
        {
            return .preview(snippet)
        }
        return hasURL ? .url : .text
    }
}

/// The strip's short look at copied text.
public enum ClipboardPreview {
    /// How many characters the paste chip previews.
    public static let previewLength = 12

    /// The first `limit` characters of `text` on one line — runs of whitespace
    /// and line breaks folded to a single space — with an ellipsis when that
    /// cut anything.
    public static func snippet(_ text: String, limit: Int = previewLength) -> String {
        let folded = text.split(whereSeparator: { $0.isWhitespace || $0.isNewline })
            .joined(separator: " ")
        guard folded.count > limit else { return folded }
        return String(folded.prefix(limit)) + "…"
    }
}

/// `parley://settings/…` — the keyboard's links into the app's Settings, from
/// the 📋 panel's empty states.
public enum SettingsLink: String, CaseIterable, Sendable {
    /// Settings › 剪貼簿.
    case clipboard
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
