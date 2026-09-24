import Foundation

/// The text rules behind the English pane's suggestion bar: which letters count
/// as the word being typed, what the user's own dictionary contributes, and how
/// a lowercase list entry is given the case the user is typing in.
///
/// Pure functions over strings, deliberately: the keyboard extension is not
/// testable — there is no host app, no field, no proxy on a machine running
/// `swift test` — so everything that could be wrong about this lives here, on
/// this side of the `textDocumentProxy`, where it has tests.
///
/// **Nothing here ever rewrites the user's text.** These functions answer "what
/// could this become", and the only thing that acts on the answer is a tap. A
/// keyboard that silently replaces a word it thinks is wrong is worse than one
/// that suggests nothing, which is why there is no autocorrect anywhere in this
/// file and no space-commits-the-suggestion rule.
public enum WordSuggestions {
    /// The word the user is in the middle of typing: the run of letters and
    /// apostrophes immediately before the cursor.
    ///
    /// `context` is `textDocumentProxy.documentContextBeforeInput`, a clipped
    /// run of text ending at the cursor. Empty whenever the character before
    /// the cursor is not part of a word — after a space, after punctuation, at
    /// the start of a field — which is when the bar turns to `predictions`.
    ///
    /// "Letter" is `Character.isLetter`, so it is Unicode's answer rather than
    /// ASCII's: someone typing `café` on this keyboard is typing one word, and
    /// clipping it at the `é` would ask the list about `caf`. Both apostrophes
    /// count, because a field with smart quotes on turns the one the keyboard
    /// typed into the other.
    public static func partialWord(before context: String?) -> String {
        guard let context, !context.isEmpty else { return "" }
        var start = context.endIndex
        while start > context.startIndex {
            let previous = context.index(before: start)
            guard isWordCharacter(context[previous]) else { break }
            start = previous
        }
        return String(context[start...])
    }

    /// Whether a character belongs to the word being typed.
    private static func isWordCharacter(_ character: Character) -> Bool {
        character.isLetter || character == "'" || character == "\u{2019}"
    }

    /// The suggestion written in the case the user is typing in.
    ///
    /// Two rules and no more, both of them things the user has already said out
    /// loud with the shift key: an ALL-CAPS partial of two letters or more asks
    /// for an all-caps word, and a capitalised first letter asks for a
    /// capitalised word. One uppercase letter alone is not evidence of caps
    /// lock — it is the far commoner case of a sentence starting — so it takes
    /// the second rule.
    ///
    /// A word that already carries case of its own (a name out of the user's
    /// lexicon) is left alone by a lowercase partial, which is what makes
    /// `kub` able to offer `Kubernetes`.
    ///
    /// Then one rule of English's own: the pronoun `I` and its contractions are
    /// capitalised wherever they land, so `iam` offers `I am`.
    public static func matchingCase(of word: String, like partial: String) -> String {
        capitalizingPronounI(shiftCase(of: word, like: partial))
    }

    private static func shiftCase(of word: String, like partial: String) -> String {
        let letters = partial.filter(\.isLetter)
        guard let first = letters.first else { return word }
        if letters.count >= 2, letters.allSatisfy(\.isUppercase) { return word.uppercased() }
        guard first.isUppercase, let head = word.first else { return word }
        return head.uppercased() + word.dropFirst()
    }

    private static func capitalizingPronounI(_ text: String) -> String {
        text.split(separator: " ", omittingEmptySubsequences: false).map { word in
            let folded = word.replacingOccurrences(of: "\u{2019}", with: "'")
            guard folded == "i" || folded.hasPrefix("i'") else { return String(word) }
            return "I" + word.dropFirst()
        }.joined(separator: " ")
    }

    /// What to offer for a part-typed word: the user's own terms first, then the
    /// partial read as two words run together (`thankyou` → `thank you`, see
    /// `split`), then the bundled list, cased to match what they typed. The
    /// split goes second instead, behind the best completion, when that
    /// completion is a common word (`usin` offers `using`, then `us in`).
    ///
    /// The lexicon comes first because it is the one source that knows something
    /// the corpus cannot — the names, jargon and product words this particular
    /// person types — and because there are only ever a handful of them, so they
    /// cost the bar almost nothing. It may be **empty**, and that is a supported
    /// state rather than a failure: `LexiconStore` lives in the App Group, which
    /// a keyboard without Full Access cannot open, and the pane has to keep
    /// suggesting in exactly that state (App Review 4.4.1 judges it there).
    ///
    /// Deduplicated case-insensitively, so a term the user typed in themselves
    /// does not appear twice because the word list has it too.
    public static func suggestions(
        for partial: String,
        in words: EnglishWords,
        lexiconTerms: [String] = [],
        limit: Int = EnglishWords.suggestionLimit
    ) -> [String] {
        guard !partial.isEmpty, limit > 0 else { return [] }
        let needle = partial.lowercased()

        var fromList = words.completions(for: partial, limit: limit)
        if let split = split(partial, in: words) {
            let beginsCommonWord =
                fromList.first.flatMap(words.rank(of:)).map { $0 < commonWordRank } ?? false
            fromList.insert(split, at: beginsCommonWord ? 1 : 0)
        }

        var out: [String] = []
        var seen = Set<String>()
        for candidate in lexiconTerms.filter({ $0.lowercased().hasPrefix(needle) }) + fromList {
            guard seen.insert(candidate.lowercased()).inserted else { continue }
            out.append(matchingCase(of: candidate, like: partial))
            if out.count == limit { break }
        }
        return out
    }

    /// A partial that begins a word this common is more likely that word half
    /// typed than two words run together.
    static let commonWordRank = 5_000

    /// The partial as two list words with the space the user missed, or `nil`.
    ///
    /// A partial that is itself a list word is never split: that is what keeps
    /// `into`, `area`, `maybe` and `cannot` whole. Otherwise a cut whose two
    /// halves are a known pair in the next-word table wins, the most common
    /// such pair by the rarer half's rank. A cut that is not a known pair is
    /// only offered when nothing completes the partial at all, so
    /// `meetingtomorrow` still becomes `meeting tomorrow` while `someth`, one
    /// letter short of `something`, never becomes `so meth`.
    static func split(_ partial: String, in words: EnglishWords) -> String? {
        let whole = EnglishWords.normalized(partial)
        guard words.rank(of: whole) == nil else { return nil }
        var known: (cost: Int, text: String)?
        var unknown: (cost: Int, text: String)?
        for cut in whole.indices.dropFirst() {
            let left = String(whole[..<cut])
            let right = String(whole[cut...])
            guard let leftRank = words.rank(of: left), let rightRank = words.rank(of: right)
            else { continue }
            let candidate = (cost: max(leftRank, rightRank), text: left + " " + right)
            if words.nextWords(after: left).contains(where: { $0.lowercased() == right }) {
                if candidate.cost < known?.cost ?? .max { known = candidate }
            } else if candidate.cost < unknown?.cost ?? .max {
                unknown = candidate
            }
        }
        if let known { return known.text }
        guard words.completions(for: whole, limit: 1).isEmpty else { return nil }
        return unknown?.text
    }

    /// What to offer before a letter is typed: the words that most often follow
    /// the one just finished.
    ///
    /// Only right after a word and exactly one space. Two spaces, punctuation,
    /// a new line or an empty field say the sentence moved on, and guessing
    /// across that would be guessing about nothing.
    ///
    /// The data's own case is kept (`new ` offers `York`, `Thank ` offers
    /// `you`, not `You`), except that an ALL-CAPS previous word of two letters
    /// or more asks for all caps, the same rule `matchingCase` reads off a
    /// partial.
    public static func predictions(
        after context: String?,
        in words: EnglishWords,
        limit: Int = EnglishWords.suggestionLimit
    ) -> [String] {
        guard let context, context.hasSuffix(" ") else { return [] }
        let previous = partialWord(before: String(context.dropLast()))
        guard !previous.isEmpty else { return [] }
        let next = words.nextWords(after: previous, limit: limit)
        let letters = previous.filter(\.isLetter)
        guard letters.count >= 2, letters.allSatisfy(\.isUppercase) else { return next }
        return next.map { $0.uppercased() }
    }
}
