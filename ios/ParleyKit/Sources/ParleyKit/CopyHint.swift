import Foundation

/// Whether the voice keyboard's strip says "Tap text to copy" in place of its
/// wordmark while a finished dictation can be copied (`DictationCopy`).
///
/// Tapping the words to copy them is invisible until someone is told: the
/// slot carries no glyph at rest, on purpose, so the only way to learn it is
/// the hint. It is a first-run hint, not a label — shown for the first
/// `sessionLimit` dictations that end as a copy target, and never again once
/// the user has copied even once, because by then they know.
///
/// **A session counts when the hint is actually drawn, and only once.** The
/// strip is tight on the narrowest phones and the hint is skipped there when
/// the room is not free (see the keyboard's `StripHome`), so a session whose
/// hint never appeared must not use up one of the three. The same session is
/// republished on every downlink note and the keyboard is rebuilt on every
/// appearance, so the session's id is remembered with the count: seeing it
/// again changes nothing. And the session that reaches the limit keeps its
/// hint for as long as it is a copy target — the third dictation's hint does
/// not vanish the moment it is counted.
///
/// Pure, so the counting is tested here; `CopyHintLedger` is what persists it.
public enum CopyHint {
    /// How many dictations show the hint.
    public static let sessionLimit = 3

    /// What the keyboard remembers about the hint.
    public struct State: Equatable, Sendable {
        /// Sessions that have shown the hint, `0...sessionLimit`.
        public var countedSessions: Int
        /// The last session counted, so a republish of it does not count again.
        public var lastCountedSession: String?
        /// The user has copied a dictation at least once.
        public var hasCopied: Bool

        /// Out-of-range counts are clamped rather than trusted: below zero is
        /// read as none, and anything past the limit as the limit.
        public init(countedSessions: Int = 0, lastCountedSession: String? = nil, hasCopied: Bool = false) {
            self.countedSessions = min(max(countedSessions, 0), CopyHint.sessionLimit)
            self.lastCountedSession = lastCountedSession
            self.hasCopied = hasCopied
        }
    }

    /// Whether `session`, now a copy target, may show the hint.
    public static func offers(in session: String, _ state: State) -> Bool {
        guard !state.hasCopied, !session.isEmpty else { return false }
        return state.countedSessions < sessionLimit || state.lastCountedSession == session
    }

    /// The hint was drawn for `session`: count it, unless it already was or the
    /// hint is not on offer for it.
    public static func shown(in session: String, _ state: State) -> State {
        guard offers(in: session, state), state.lastCountedSession != session else { return state }
        return State(
            countedSessions: state.countedSessions + 1, lastCountedSession: session,
            hasCopied: state.hasCopied)
    }

    /// A copy succeeded: the hint has done its job.
    public static func copied(_ state: State) -> State {
        var next = state
        next.hasCopied = true
        return next
    }
}

/// `CopyHint.State`, kept in the App Group's `UserDefaults` beside the
/// keyboard's other small values (`HostReturnLedger`, `TypingKeyboards`).
///
/// The App Group rather than the extension's own defaults so the app can reset
/// it for the DEBUG keyboard harness. The keyboard only writes it while a
/// dictation is a copy target, which needs Full Access — the same condition
/// under which an extension may write to the group at all.
///
/// Every value read is validated: a count that is not a whole number reads as
/// none, one outside `0...sessionLimit` is clamped, a session id that is not a
/// short string is dropped, and a flag that is not a Boolean reads as false.
/// `@unchecked` for `UserDefaults` alone, as `HostReturnLedger` is.
public struct CopyHintLedger: @unchecked Sendable {
    private let defaults: UserDefaults?

    static let countKey = "keyboard.copyHint.sessions"
    static let lastSessionKey = "keyboard.copyHint.lastSession"
    static let copiedKey = "keyboard.copyHint.copied"
    /// Session ids are UUID strings; anything much longer is not one.
    static let maxSessionLength = 128

    public init(defaults: UserDefaults?) {
        self.defaults = defaults
    }

    public static let shared = CopyHintLedger(
        defaults: UserDefaults(suiteName: DictationChannel.appGroup))

    public func read() -> CopyHint.State {
        guard let defaults else { return CopyHint.State() }
        let count: Int
        // `as? Int` on an `NSNumber` only succeeds when the value is exactly a
        // whole number (2.5 and NaN fail); a Boolean would bridge as 0 or 1,
        // so it is ruled out first.
        if let number = defaults.object(forKey: Self.countKey) as? NSNumber,
            CFGetTypeID(number) != CFBooleanGetTypeID(),
            let whole = number as? Int
        {
            count = whole
        } else {
            count = 0
        }
        let last = (defaults.object(forKey: Self.lastSessionKey) as? String)
            .flatMap { $0.isEmpty || $0.count > Self.maxSessionLength ? nil : $0 }
        let copied: Bool
        if let flag = defaults.object(forKey: Self.copiedKey) as? NSNumber,
            CFGetTypeID(flag) == CFBooleanGetTypeID()
        {
            copied = flag.boolValue
        } else {
            copied = false
        }
        return CopyHint.State(countedSessions: count, lastCountedSession: last, hasCopied: copied)
    }

    public func write(_ state: CopyHint.State) {
        defaults?.set(state.countedSessions, forKey: Self.countKey)
        defaults?.set(state.lastCountedSession, forKey: Self.lastSessionKey)
        defaults?.set(state.hasCopied, forKey: Self.copiedKey)
    }

    /// Back to a keyboard that has never shown the hint — for the DEBUG harness.
    public func reset() {
        defaults?.removeObject(forKey: Self.countKey)
        defaults?.removeObject(forKey: Self.lastSessionKey)
        defaults?.removeObject(forKey: Self.copiedKey)
    }
}
