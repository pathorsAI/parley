import Foundation

/// What Parley takes from the lexicon the system lends a keyboard: the Text
/// Replacement shortcuts, and nothing else.
///
/// `UIInputViewController.requestSupplementaryLexicon` hands a keyboard a list
/// of `(userInput, documentText)` entries: the names in the user's contacts,
/// and their Text Replacement list from Settings › General › Keyboard. They
/// arrive mixed, and the shape of an entry is what tells them apart:
///
/// - **`userInput != documentText`** is a shortcut and what it stands for —
///   "omw" for "On my way!". These are kept, in the keyboard's memory only, and
///   offered as an expansion on the English suggestion bar
///   (`TextReplacements`).
/// - **`userInput == documentText`** is a contact's name (or a Text
///   Replacement phrase saved without a shortcut — the two cannot be told
///   apart). These are **dropped, unread**. Anything the dictionary holds
///   leaves the phone — recognition terms go to the relay and Soniox, and into
///   the polish prompt — and contact names do not leave the phone. Not kept in
///   memory either: there is no use for them that stays on the device and is
///   worth holding a list of people in a keyboard for.
///
/// Foundation only, with `UILexiconEntry` mapped to `Entry` at the call site,
/// so the filtering runs under `swift test`.
public enum SystemLexicon {
    public struct Entry: Equatable, Sendable {
        public let userInput: String
        public let documentText: String

        public init(userInput: String, documentText: String) {
            self.userInput = userInput
            self.documentText = documentText
        }
    }

    /// Whether an entry is a shortcut rather than a name — the only kind kept.
    /// Separate so the call site can filter before copying anything out of
    /// `UILexicon`: a name never becomes one of our strings at all.
    public static func isShortcut(userInput: String, documentText: String) -> Bool {
        userInput != documentText
    }

    /// The Text Replacement shortcuts among `entries`, as the bar offers them.
    /// Every entry whose two sides match — a contact's name — is ignored.
    public static func replacements(from entries: [Entry]) -> TextReplacements {
        var shortcuts: [(shortcut: String, expansion: String)] = []
        for entry in entries
        where isShortcut(userInput: entry.userInput, documentText: entry.documentText) {
            let input = entry.userInput.trimmingCharacters(in: .whitespacesAndNewlines)
            // The expansion keeps its inner whitespace — an address is several
            // lines on purpose — and loses only the outer.
            let text = entry.documentText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !input.isEmpty, !text.isEmpty, input != text else { continue }
            shortcuts.append((input, text))
        }
        return TextReplacements(shortcuts)
    }
}

/// The user's Text Replacement shortcuts, as the keyboard offers them.
///
/// Apple's keyboard expands a shortcut on the space after it. A third-party
/// keyboard is handed the list and left to decide; this one offers the
/// expansion as the **first** suggestion on the English bar while the word
/// before the cursor is a shortcut, and replaces the shortcut only when that
/// suggestion is tapped. Nothing expands on its own: a keyboard that rewrites
/// what someone typed without being asked is the thing this codebase avoids
/// everywhere else too (`WordSuggestions` is offers only).
///
/// Matching is case-insensitive — "OMW" at the start of a sentence is still
/// the shortcut — and on the whole word before the cursor, so "omwx" is not.
public struct TextReplacements: Equatable, Sendable {
    /// One shortcut found in front of the cursor.
    public struct Match: Equatable, Sendable {
        /// The characters actually in the document, in the case they were
        /// typed — what a tap has to delete.
        public let typed: String
        /// What replaces them.
        public let expansion: String
    }

    /// More than anyone keeps; the bound is for the keyboard's memory, not for
    /// a real list.
    public static let maxEntries = 1000

    public static let none = TextReplacements([])

    /// Lowercased shortcut → expansion. First one wins when two shortcuts
    /// differ only in case, which is the order Settings lists them in.
    private let expansions: [String: String]
    /// The longest shortcut, in characters, so a lookup never walks further
    /// back through the document than a shortcut could reach.
    private let longest: Int

    public init(_ pairs: [(shortcut: String, expansion: String)]) {
        var expansions: [String: String] = [:]
        var longest = 0
        for (shortcut, expansion) in pairs {
            guard expansions.count < Self.maxEntries else { break }
            let key = shortcut.lowercased()
            guard !key.isEmpty, !expansion.isEmpty, expansions[key] == nil else { continue }
            expansions[key] = expansion
            longest = max(longest, shortcut.count)
        }
        self.expansions = expansions
        self.longest = longest
    }

    public var isEmpty: Bool { expansions.isEmpty }
    public var count: Int { expansions.count }

    /// The shortcut the cursor sits right after, if any.
    ///
    /// "The word before the cursor" is tried two ways: the whole run of
    /// non-space characters ("@@", "c/o"), then — when that is not a shortcut —
    /// its trailing run of letters, so a shortcut typed straight after an
    /// opening bracket or a quote ("(omw") still counts. Cheap enough for
    /// every keystroke: one walk back of at most `longest + 1` characters and
    /// two dictionary lookups.
    public func match(before context: String?) -> Match? {
        guard longest > 0, let context, let last = context.last, !last.isWhitespace else {
            return nil
        }
        var start = context.endIndex
        var walked = 0
        while start > context.startIndex, walked <= longest {
            let previous = context.index(before: start)
            if context[previous].isWhitespace { break }
            start = previous
            walked += 1
        }
        // Past `longest`, the run as a whole cannot be a shortcut; its
        // trailing letters still can.
        if walked <= longest {
            let run = String(context[start...])
            if let expansion = expansions[run.lowercased()] {
                return Match(typed: run, expansion: expansion)
            }
        }
        let letters = WordSuggestions.partialWord(before: context)
        guard !letters.isEmpty, letters.count <= longest,
            let expansion = expansions[letters.lowercased()]
        else { return nil }
        return Match(typed: letters, expansion: expansion)
    }

    /// The bar's words with an expansion put in front: first, once, and
    /// without growing the bar past `limit`.
    public static func leading(
        _ match: Match?, before suggestions: [String], limit: Int = EnglishWords.suggestionLimit
    ) -> [String] {
        guard let match else { return suggestions }
        let rest = suggestions.filter { $0 != match.expansion }
        return Array(([match.expansion] + rest).prefix(max(limit, 1)))
    }
}
