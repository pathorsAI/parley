import Foundation

/// What the system lends a keyboard about the user's words, sorted into the two
/// things Parley does with it.
///
/// `UIInputViewController.requestSupplementaryLexicon` hands a keyboard a list
/// of `(userInput, documentText)` entries: the names in the user's contacts,
/// and their Text Replacement list from Settings › General › Keyboard. They
/// arrive mixed, and the shape of an entry is what tells them apart:
///
/// - **`userInput == documentText`** is a word to know — a contact's name, or a
///   Text Replacement phrase saved without a shortcut. These become the
///   dictionary's *system terms* (`Lexicon.systemTerms`) and bias recognition,
///   after the user's own words.
/// - **`userInput != documentText`** is a shortcut and what it stands for —
///   "omw" for "On my way!". These stay in the keyboard's memory and are
///   offered as an expansion on the English suggestion bar
///   (`TextReplacements`). They are not recognition terms: nobody *says*
///   "omw", and the expansion is often a sentence or an address rather than a
///   word.
///
/// Foundation only, with `UILexiconEntry` mapped to `Entry` at the call site,
/// so the sorting runs under `swift test`.
public enum SystemLexicon {
    public struct Entry: Equatable, Sendable {
        public let userInput: String
        public let documentText: String

        public init(userInput: String, documentText: String) {
            self.userInput = userInput
            self.documentText = documentText
        }
    }

    /// Terms in the order the system listed them, trimmed, de-duplicated and
    /// capped at `Lexicon.maxSystemTerms`; shortcuts as a `TextReplacements`.
    public static func partition(_ entries: [Entry]) -> (
        terms: [String], replacements: TextReplacements
    ) {
        var terms: [String] = []
        var seen = Set<String>()
        var shortcuts: [(shortcut: String, expansion: String)] = []
        for entry in entries {
            let input = entry.userInput.trimmingCharacters(in: .whitespacesAndNewlines)
            let text = entry.documentText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !input.isEmpty, !text.isEmpty else { continue }
            if input == text {
                guard terms.count < Lexicon.maxSystemTerms, seen.insert(text).inserted else {
                    continue
                }
                terms.append(text)
            } else {
                // The expansion keeps its inner whitespace — an address is
                // several lines on purpose — and loses only the outer.
                shortcuts.append((input, text))
            }
        }
        return (terms, TextReplacements(shortcuts))
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
