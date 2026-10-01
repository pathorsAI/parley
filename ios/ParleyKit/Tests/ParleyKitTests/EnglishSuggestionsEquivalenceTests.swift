import XCTest

@testable import ParleyKit

/// The English suggestion bar was rebuilt for speed — short prefixes answered
/// from a table built at load, followers indexed by their lowercase form, the
/// lexicon lowercased once — and none of that is allowed to change a single
/// answer. This file holds the implementation it replaced, verbatim, and
/// checks the two against each other over every one-, two- and three-letter
/// prefix and a few thousand real partial words, then times both.
///
/// The reference is deliberately a copy rather than a call into history: it is
/// the oracle, so it must not move when the real thing does. If a future change
/// *means* to alter what the bar offers, delete the affected comparison rather
/// than editing the reference to agree.
final class EnglishSuggestionsEquivalenceTests: XCTestCase {
    private static let new = EnglishWords(
        wordsURL: EnglishWords.bundledWordsURL, followersURL: EnglishWords.bundledFollowersURL)
    private static let old = ReferenceEnglishWords(
        wordsURL: EnglishWords.bundledWordsURL, followersURL: EnglishWords.bundledFollowersURL)

    /// A lexicon with the shapes that matter to the rules: mixed case, a term
    /// that is also a list word, one with a typographic apostrophe, one that is
    /// a run-together pair, and non-ASCII letters.
    private static let lexicon = [
        "Kubernetes", "Parley", "PostgreSQL", "iPhone", "Tomorrow", "don\u{2019}t",
        "thankyou", "Ünicode", "café", "Isaac", "ioctl", "Zoë",
    ]

    private static let alphabet = Array("abcdefghijklmnopqrstuvwxyz").map(String.init)

    /// Every one-, two- and three-letter lowercase prefix.
    private static let shortPrefixes: [String] = {
        var out = alphabet
        for a in alphabet {
            for b in alphabet {
                out.append(a + b)
                for c in alphabet { out.append(a + b + c) }
            }
        }
        return out
    }()

    /// Apostrophes, both kinds, in the positions a user can put them; case
    /// variants; and a handful of inputs outside the list's alphabet.
    private static let oddInputs: [String] = {
        var out = ["'", "\u{2019}", "i", "I", "i'", "i\u{2019}", "I'", "im", "iam", "Iam", "IAM"]
        for a in alphabet {
            out += [a + "'", "'" + a, a + "\u{2019}", a.uppercased(), a.uppercased() + "'"]
            for b in ["s", "t", "d", "l", "v"] {
                out += [a + "'" + b, a + "\u{2019}" + b, a.uppercased() + b.uppercased()]
            }
        }
        out += [
            "don\u{2019}", "don\u{2019}t", "Don't", "DON'T", "café", "cafe\u{301}", "naïve",
            "Ünt", "ß", "İs", "e\u{301}", "Zo", "ZO", "Kub", "kub", "KUB", "po", "Po", "PO",
            "thankyou", "Thankyou", "THANKYOU", "unitedstates", "UnitedStates", "newyork",
            "iwant", "ofthe", "usin", "stayin", "iphone", "idont", "occured", "into", "maybe",
            String(repeating: "a", count: 41), String(repeating: "ab", count: 20),
            "areallylongrunoflettersthatisnotenglish",
        ]
        return out
    }()

    /// Real partial words: every prefix of every 37th list word, in three
    /// cases, plus every prefix of a few hundred run-together pairs from the
    /// follower table — the inputs `split` exists for.
    private static let realPartials: [String] = {
        let words = ReferenceEnglishWords.lines(of: EnglishWords.bundledWordsURL).map(String.init)
        var out: [String] = []
        for word in stride(from: 0, to: words.count, by: 37).map({ words[$0] }) {
            var prefix = ""
            for character in word {
                prefix.append(character)
                out += [prefix, prefix.capitalized, prefix.uppercased()]
            }
        }
        let pairLines = ReferenceEnglishWords.lines(of: EnglishWords.bundledFollowersURL)
        for line in stride(from: 0, to: pairLines.count, by: 3).map({ pairLines[$0] }) {
            let fields = line.split(separator: " ")
            guard fields.count > 2 else { continue }
            let joined = String(fields[0]) + String(fields[1]) + String(fields[2])
            for end in joined.indices.dropFirst() { out.append(String(joined[..<end])) }
            out.append(joined)
        }
        return out
    }()

    private static var allInputs: [String] { shortPrefixes + oddInputs + realPartials }

    func testTheInputSetIsBroad() {
        XCTAssertEqual(Self.shortPrefixes.count, 26 + 26 * 26 + 26 * 26 * 26)
        XCTAssertGreaterThan(Self.realPartials.count, 2_000)
        XCTAssertNotNil(EnglishWords.bundledWordsURL)
        XCTAssertNotNil(EnglishWords.bundledFollowersURL)
    }

    func testCompletionsMatchTheOldWalkForEveryInput() {
        for input in Self.allInputs {
            for limit in [1, 3, EnglishWords.suggestionLimit, 7] {
                XCTAssertEqual(
                    Self.new.completions(for: input, limit: limit),
                    Self.old.completions(for: input, limit: limit), "\(input) limit \(limit)")
            }
        }
    }

    func testRanksAndFollowersMatchTheOldTable() {
        for input in Self.oddInputs + Self.realPartials {
            XCTAssertEqual(Self.new.rank(of: input), Self.old.rank(of: input), input)
            XCTAssertEqual(
                Self.new.nextWords(after: input), Self.old.nextWords(after: input), input)
            XCTAssertEqual(
                Self.new.nextWords(after: input, limit: .max),
                Self.old.nextWords(after: input, limit: .max), input)
        }
    }

    func testSplitsMatchTheOldSplitForEveryInput() {
        for input in Self.allInputs {
            XCTAssertEqual(
                WordSuggestions.split(input, in: Self.new),
                ReferenceSuggestions.split(input, in: Self.old), input)
        }
    }

    func testTheBarMatchesTheOldBarForEveryInput() {
        let lexicon = WordSuggestions.LexiconTerms(Self.lexicon)
        for input in Self.allInputs {
            XCTAssertEqual(
                WordSuggestions.suggestions(for: input, in: Self.new, lexicon: lexicon),
                ReferenceSuggestions.suggestions(
                    for: input, in: Self.old, lexiconTerms: Self.lexicon), input)
            XCTAssertEqual(
                WordSuggestions.suggestions(for: input, in: Self.new),
                ReferenceSuggestions.suggestions(for: input, in: Self.old), input)
        }
    }

    func testPredictionsMatchTheOldPredictions() {
        var contexts = ["", " ", "i ", "I ", "and ", "thank ", "new ", "so i ", "the  ", "x. "]
        for line in ReferenceEnglishWords.lines(of: EnglishWords.bundledFollowersURL) {
            guard let first = line.split(separator: " ").first else { continue }
            contexts += [String(first) + " ", first.uppercased() + " "]
        }
        for context in contexts {
            XCTAssertEqual(
                WordSuggestions.predictions(after: context, in: Self.new),
                ReferenceSuggestions.predictions(after: context, in: Self.old), context)
        }
    }

    func testCasingMatchesTheOldCasing() {
        let words = ["i", "i'm", "i\u{2019}ll", "is", "it", "I am", "i am", "hi i", "Kubernetes"]
        for word in words {
            for partial in ["", "k", "K", "KU", "i", "I", "Ka", "ab", "AB", "1", "é", "É"] {
                XCTAssertEqual(
                    WordSuggestions.matchingCase(of: word, like: partial),
                    ReferenceSuggestions.matchingCase(of: word, like: partial), "\(word) \(partial)")
            }
        }
    }

    // MARK: timing

    /// One keystroke's worth of lookups for each input a typist actually
    /// produces: every prefix of every 37th word, as `refreshSuggestions` asks.
    private static let typedPartials: [String] = {
        let words = ReferenceEnglishWords.lines(of: EnglishWords.bundledWordsURL).map(String.init)
        var out: [String] = []
        for word in stride(from: 0, to: words.count, by: 37).map({ words[$0] }) {
            var prefix = ""
            for character in word {
                prefix.append(character)
                out.append(prefix)
            }
        }
        return out
    }()

    func testMeasureTheBarNow() {
        let words = Self.new
        let lexicon = WordSuggestions.LexiconTerms(Self.lexicon)
        _ = WordSuggestions.suggestions(for: "a", in: words)
        measure {
            for partial in Self.typedPartials {
                _ = WordSuggestions.suggestions(for: partial, in: words, lexicon: lexicon)
            }
        }
    }

    func testMeasureTheBarBefore() {
        let words = Self.old
        _ = ReferenceSuggestions.suggestions(for: "a", in: words)
        measure {
            for partial in Self.typedPartials {
                _ = ReferenceSuggestions.suggestions(
                    for: partial, in: words, lexiconTerms: Self.lexicon)
            }
        }
    }

    /// The worst case the table exists for: a one-letter prefix, which used to
    /// walk every word starting with that letter.
    func testMeasureOneLetterPrefixesNow() {
        let words = Self.new
        _ = words.completions(for: "a")
        measure {
            for _ in 0..<20 { for letter in Self.alphabet { _ = words.completions(for: letter) } }
        }
    }

    func testMeasureOneLetterPrefixesBefore() {
        let words = Self.old
        _ = words.completions(for: "a")
        measure {
            for _ in 0..<20 { for letter in Self.alphabet { _ = words.completions(for: letter) } }
        }
    }

    /// What the table costs at load, on the warm's background thread.
    func testMeasureTheLoad() {
        measure {
            let words = EnglishWords(
                wordsURL: EnglishWords.bundledWordsURL,
                followersURL: EnglishWords.bundledFollowersURL)
            _ = words.completions(for: "a")
        }
    }

    func testMeasureTheLoadBefore() {
        measure {
            let words = ReferenceEnglishWords(
                wordsURL: EnglishWords.bundledWordsURL,
                followersURL: EnglishWords.bundledFollowersURL)
            _ = words.completions(for: "a")
        }
    }
}

// MARK: - the implementation this replaced, verbatim

/// `EnglishWords` as it was before the short-prefix table and the follower
/// index: the lookups only, loaded eagerly.
private final class ReferenceEnglishWords {
    private let words: [String]
    private let ranks: [Int32]
    private let followers: [String: [String]]

    init(wordsURL: URL?, followersURL: URL?) {
        var words: [String] = []
        for line in Self.lines(of: wordsURL) { words.append(String(line)) }
        var followers: [String: [String]] = [:]
        for line in Self.lines(of: followersURL) {
            let fields = line.split(separator: " ").map(String.init)
            guard let previous = fields.first, fields.count > 1 else { continue }
            followers[previous] = Array(fields.dropFirst())
        }
        let ranked = words.enumerated().map { (word: $0.element, rank: Int32($0.offset)) }
            .sorted { $0.word < $1.word }
        self.words = ranked.map(\.word)
        self.ranks = ranked.map(\.rank)
        self.followers = Dictionary(
            followers.map { (Self.normalized($0.key), $0.value) }, uniquingKeysWith: { first, _ in first })
    }

    func completions(for prefix: String, limit: Int = EnglishWords.suggestionLimit) -> [String] {
        let needle = Self.normalized(prefix)
        guard !needle.isEmpty, limit > 0 else { return [] }
        var best: [(rank: Int32, word: String)] = []
        var index = Self.lowerBound(of: needle, in: words)
        while index < words.count, words[index].hasPrefix(needle) {
            Self.offer(rank: ranks[index], word: words[index], to: &best, limit: limit)
            index += 1
        }
        return best.map(\.word)
    }

    func rank(of word: String) -> Int? {
        let needle = Self.normalized(word)
        guard !needle.isEmpty else { return nil }
        let index = Self.lowerBound(of: needle, in: words)
        guard index < words.count, words[index] == needle else { return nil }
        return Int(ranks[index])
    }

    func nextWords(after word: String, limit: Int = EnglishWords.suggestionLimit) -> [String] {
        guard limit > 0 else { return [] }
        return Array(followers[Self.normalized(word)]?.prefix(limit) ?? [])
    }

    private static func offer(
        rank: Int32, word: String, to best: inout [(rank: Int32, word: String)], limit: Int
    ) {
        if best.count == limit, let last = best.last, rank >= last.rank { return }
        let at = best.firstIndex { $0.rank > rank } ?? best.count
        best.insert((rank, word), at: at)
        if best.count > limit { best.removeLast() }
    }

    private static func lowerBound(of needle: String, in words: [String]) -> Int {
        var low = 0
        var high = words.count
        while low < high {
            let mid = low + (high - low) / 2
            if words[mid] < needle { low = mid + 1 } else { high = mid }
        }
        return low
    }

    static func normalized(_ prefix: String) -> String {
        prefix.lowercased().replacingOccurrences(of: "\u{2019}", with: "'")
    }

    static func lines(of url: URL?) -> [Substring] {
        guard let url, let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        return text.split(separator: "\n", omittingEmptySubsequences: true)
            .filter { !$0.hasPrefix("#") }
    }
}

/// `WordSuggestions` as it was: per-keystroke lowercasing of the lexicon, the
/// copy-and-lowercase follower scan in `split`, and `capitalizingPronounI`
/// splitting every suggestion.
private enum ReferenceSuggestions {
    static func matchingCase(of word: String, like partial: String) -> String {
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

    static func suggestions(
        for partial: String,
        in words: ReferenceEnglishWords,
        lexiconTerms: [String] = [],
        limit: Int = EnglishWords.suggestionLimit
    ) -> [String] {
        guard !partial.isEmpty, limit > 0 else { return [] }
        let needle = partial.lowercased()

        var fromList = words.completions(for: partial, limit: limit)
        if let split = split(partial, in: words) {
            let beginsCommonWord =
                fromList.first.flatMap(words.rank(of:)).map { $0 < WordSuggestions.commonWordRank }
                ?? false
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

    private static let longestSplit = 40
    private static let unlistedRank = 1_000_000

    static func split(_ partial: String, in words: ReferenceEnglishWords) -> String? {
        let whole = ReferenceEnglishWords.normalized(partial)
        guard whole.count <= longestSplit, words.rank(of: whole) == nil else { return nil }
        var best: (cost: Int, text: String)?
        for cut in whole.indices.dropFirst() {
            let left = String(whole[..<cut])
            let rest = whole[cut...]
            guard
                let right = words.nextWords(after: left, limit: .max)
                    .first(where: { $0.lowercased() == rest })
            else { continue }
            let cost = max(
                words.rank(of: left) ?? unlistedRank, words.rank(of: right) ?? unlistedRank)
            if cost < best?.cost ?? .max { best = (cost, left + " " + right) }
        }
        return best?.text
    }

    static func predictions(
        after context: String?,
        in words: ReferenceEnglishWords,
        limit: Int = EnglishWords.suggestionLimit
    ) -> [String] {
        guard let context, context.hasSuffix(" ") else { return [] }
        let previous = WordSuggestions.partialWord(before: String(context.dropLast()))
        guard !previous.isEmpty else { return [] }
        return words.nextWords(after: previous, limit: limit).map(capitalizingPronounI)
    }
}
