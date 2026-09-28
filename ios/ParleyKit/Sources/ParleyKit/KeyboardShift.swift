import Foundation

/// When the next letter should be a capital without anyone touching shift.
///
/// The system keyboard arms shift by itself at the start of a field, after a
/// sentence ends and after a line break, and the host field says how far to go
/// with that (`UITextAutocapitalizationType`). Parley's letter pane used to
/// ignore both, so every message started in lower case unless the user
/// remembered to press shift — one of the first things a system-keyboard user
/// notices.
///
/// Pure, and in ParleyKit rather than the extension, so the rule can be tested
/// against the strings that decide it. The extension maps the host's UIKit
/// value onto `Mode`.
public enum AutoCapitalization {
    /// The host field's `autocapitalizationType`, without UIKit.
    public enum Mode: Equatable, Sendable {
        /// Never arm shift — URLs, e-mail addresses, user names.
        case none
        /// The first letter of every word.
        case words
        /// The first letter of every sentence. What a field gets when it does
        /// not say.
        case sentences
        /// Every letter. The keyboard keeps shift armed after each one, which
        /// looks and types like caps lock while still letting the user tap it
        /// off for a single lower-case letter.
        case allCharacters
    }

    /// Whether the letter typed next, after `context` (the text before the
    /// caret), should be a capital.
    ///
    /// Sentence starts are: an empty field (or nothing but spaces before the
    /// caret), a line break, and `.` `?` `!` followed by a space — with any
    /// closing quotes or brackets in between, so `He said "hi." ` counts. A
    /// full stop with no space after it is not a sentence end (`3.14`,
    /// `parley.app`); the space is what says the sentence is over. Like the
    /// system keyboard this does not know abbreviations: after `e.g. ` shift is
    /// armed too.
    ///
    /// The full-width `。？！` end a sentence on their own, space or not,
    /// because Chinese puts none after them.
    public static func capitalizesNext(after context: String?, mode: Mode) -> Bool {
        switch mode {
        case .none: return false
        case .allCharacters: return true
        case .words:
            guard let last = context?.last else { return true }
            return last.isWhitespace
        case .sentences:
            return startsSentence(after: context ?? "")
        }
    }

    private static let sentenceEnders: Set<Character> = [".", "?", "!"]
    private static let fullWidthEnders: Set<Character> = ["。", "？", "！"]
    private static let closers: Set<Character> = [
        "\"", "'", ")", "]", "}", "\u{201D}", "\u{2019}", "」", "』", "）",
    ]

    private static func startsSentence(after context: String) -> Bool {
        var rest = Substring(context)
        var sawSpace = false
        while let last = rest.last, last.isWhitespace {
            if last.isNewline { return true }
            sawSpace = true
            rest = rest.dropLast()
        }
        guard let last = rest.last else { return true }
        if fullWidthEnders.contains(last) { return true }
        guard sawSpace else { return false }
        while let c = rest.last, closers.contains(c) { rest = rest.dropLast() }
        guard let end = rest.last else { return false }
        return sentenceEnders.contains(end) || fullWidthEnders.contains(end)
    }
}

/// The letter pane's shift key: off, armed for one letter, or locked.
///
/// The rules the user sees, in one value the tests can drive:
///
/// - A tap toggles it between off and armed; two taps within
///   `doubleTapWindow` lock it, and a tap on a locked shift turns it off.
/// - After every edit and every move of the caret the keyboard `settle`s it:
///   a locked shift stays locked, and anything else becomes whatever
///   `AutoCapitalization` says the next letter should be. That one rule is
///   what both spends a one-shot shift on the letter it capitalised and arms
///   it again after `. `, so there is no separate "consume" step to forget.
/// - Leaving the letters for the symbol planes drops a one-shot shift, as on
///   the system keyboard.
public struct ShiftLatch: Equatable, Sendable {
    public enum State: Equatable, Sendable {
        case off
        case oneShot
        case locked

        public var isOn: Bool { self != .off }
    }

    /// Two taps closer together than this lock shift.
    public static let doubleTapWindow: TimeInterval = 0.3

    public private(set) var state: State
    private var lastTap: Date?

    public init(state: State = .off) {
        self.state = state
    }

    /// The shift key went down.
    public mutating func tap(at now: Date) {
        if let lastTap, now.timeIntervalSince(lastTap) < Self.doubleTapWindow {
            state = .locked
            // A third quick tap is a new first tap, not another double.
            self.lastTap = nil
            return
        }
        state = state.isOn ? .off : .oneShot
        lastTap = now
    }

    /// The text or the caret changed: re-decide, unless the user locked it.
    public mutating func settle(capitalize: Bool) {
        guard state != .locked else { return }
        state = capitalize ? .oneShot : .off
    }

    /// The symbol planes are opening.
    public mutating func dropOneShot() {
        if state == .oneShot { state = .off }
    }
}
