import Foundation

/// How hard the AI pass after dictation rewrites what was said — the choice
/// that replaced the old on/off "Polish with AI" switch.
///
/// - `off`: the transcript is inserted as it was recognised.
/// - `tidy`: the rewrite that shipped before this choice existed — filler and
///   false starts out, clauses reordered, lists laid out, nothing dropped
///   (`TranscriptPolisher.systemPrompt`). The default.
/// - `concise`: tidy, and then the verbal tics, hedges and pleasantries go as
///   well, down to the shortest wording that keeps every fact
///   (`TranscriptPolisher.conciseSystemPrompt`), on a larger model.
///
/// **The raw values are stored** — in `UserDefaults` under `storageKey`, and in
/// the on-device dictation history (`DictationHistoryEntry.polishStyle`) — so
/// they are a wire format: never rename one. The desktop stores the same three
/// strings in its own settings (`VoiceTypingPolishStyle`).
public enum PolishStyle: String, Codable, Sendable, CaseIterable {
    case off
    case tidy
    case concise

    /// What someone who never touched the setting gets. Tidy, not concise:
    /// it is the behaviour everyone had before the choice existed, and the one
    /// that never drops a word the speaker said.
    public static let `default`: PolishStyle = .tidy

    /// Where the choice lives (`UserDefaults.standard`). The app's Settings
    /// binds a picker to it; the dictation coordinator reads it raw because a
    /// session can end in the background with no view alive.
    public static let storageKey = "dictationPolishStyle"

    /// The on/off switch this replaced. Read once, by `migrateLegacySetting`,
    /// and otherwise left where it is — a build from before the choice existed
    /// still reads it after a downgrade.
    public static let legacyEnabledKey = "dictationPolishEnabled"

    /// The style a stored value amounts to.
    ///
    /// A recognised `stored` value wins. Without one, the old switch decides:
    /// explicitly off stays off, and on — or never touched, which the old
    /// switch also read as on — becomes tidy, which is exactly what "on" used
    /// to do. Pure, so the migration rule is testable without `UserDefaults`.
    public static func resolve(stored: String?, legacyEnabled: Bool?) -> PolishStyle {
        if let stored, let style = PolishStyle(rawValue: stored) { return style }
        return legacyEnabled == false ? .off : .default
    }

    /// The user's current choice, migrating the old switch on the fly when the
    /// new key has never been written.
    public static func current(in defaults: UserDefaults = .standard) -> PolishStyle {
        resolve(
            stored: defaults.string(forKey: storageKey),
            legacyEnabled: defaults.object(forKey: legacyEnabledKey) as? Bool)
    }

    /// Write the migrated choice under `storageKey` once, so a picker bound to
    /// that key shows what the old switch said rather than the default. A no-op
    /// once the key holds a recognised value, and for someone who never touched
    /// the old switch (the default needs no writing).
    public static func migrateLegacySetting(in defaults: UserDefaults = .standard) {
        if let stored = defaults.string(forKey: storageKey), PolishStyle(rawValue: stored) != nil {
            return
        }
        guard let legacy = defaults.object(forKey: legacyEnabledKey) as? Bool else { return }
        defaults.set(
            resolve(stored: nil, legacyEnabled: legacy).rawValue, forKey: storageKey)
    }

    /// Whether this style sends the transcript to the model at all.
    public var polishes: Bool { self != .off }
}
