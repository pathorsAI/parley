import Foundation

/// A typing pane the Parley keyboard can show, beside the voice pane that is
/// always there.
public enum TypingKeyboard: String, CaseIterable, Codable, Sendable, Identifiable {
    case english
    case zhuyin

    public var id: String { rawValue }
}

/// Which typing keyboards the pane track carries, shared between the app (which
/// owns the toggles) and the extension (which reads them on every appearance).
///
/// It lives in the App Group's `UserDefaults` rather than in `DictationChannel`'s
/// files because it is a *setting*, not a live hand-off: nobody has to be
/// notified, the keyboard re-reads it when it next appears, and `UserDefaults`
/// is the one shared store an extension can read with no Full Access. (The
/// dictation mailboxes need Full Access; the pane list must not — App Review
/// 4.4.1 judges the keyboard with it switched off.)
public enum TypingKeyboards {
    public static let defaultsKey = "keyboard.enabledTypingPanes"

    private static var store: UserDefaults? {
        UserDefaults(suiteName: DictationChannel.appGroup)
    }

    /// The enabled keyboards, in track order. Never empty: a keyboard with no
    /// typing pane would leave a user with no way to type at all with Full
    /// Access off, so English is the floor.
    public static func enabled() -> [TypingKeyboard] {
        guard let raw = store?.stringArray(forKey: defaultsKey) else {
            return defaultEnabled()
        }
        let panes = normalize(raw.compactMap(TypingKeyboard.init(rawValue:)))
        return panes.isEmpty ? defaultEnabled() : panes
    }

    public static func setEnabled(_ panes: [TypingKeyboard]) {
        let panes = normalize(panes)
        guard !panes.isEmpty else { return }
        store?.set(panes.map(\.rawValue), forKey: defaultsKey)
    }

    /// Deduplicated and put back in canonical order, so the track can't come out
    /// of the store in an order the Settings toggles never offered.
    private static func normalize(_ panes: [TypingKeyboard]) -> [TypingKeyboard] {
        TypingKeyboard.allCases.filter(panes.contains)
    }

    /// What someone gets before they have ever opened the Keyboards setting.
    ///
    /// 注音 is on for a phone whose language list includes Traditional Chinese
    /// and off otherwise. The asymmetry is deliberate: for a Taiwanese user the
    /// 注音 pane is the reason this keyboard is worth installing, and for an
    /// English-only user it is a pane of unfamiliar symbols one swipe from the
    /// mic button.
    public static func defaultEnabled(
        preferredLanguages: [String] = Locale.preferredLanguages
    ) -> [TypingKeyboard] {
        wantsTraditionalChinese(preferredLanguages) ? [.english, .zhuyin] : [.english]
    }

    /// Traditional Chinese by script or by region — `zh-Hant`, `zh-Hant-TW`,
    /// `zh-TW`, `zh-HK`, `zh-MO`. Matching on the raw prefix rather than asking
    /// `Locale` to canonicalize keeps this a pure function the tests can drive.
    static func wantsTraditionalChinese(_ languages: [String]) -> Bool {
        languages.contains { language in
            let tags = language.split(separator: "-").map(String.init)
            guard tags.first?.lowercased() == "zh" else { return false }
            let rest = Set(tags.dropFirst().map { $0.lowercased() })
            return !rest.intersection(["hant", "tw", "hk", "mo"]).isEmpty
        }
    }
}
