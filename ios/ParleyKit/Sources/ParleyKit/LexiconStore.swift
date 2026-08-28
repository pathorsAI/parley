import Foundation

/// One correction the user has made: what dictation produced, and what they
/// changed it to.
///
/// `count` is the whole reason this is a pair rather than a rule. A single edit
/// is ambiguous — the user may have been rephrasing, or fixing a name that only
/// mattered in that one sentence — so a pair does nothing until it has been
/// seen twice. See `Lexicon.autoApplyThreshold`.
public struct LexiconPair: Codable, Sendable, Equatable, Identifiable {
    /// What came back from dictation. Unique within a lexicon: one misheard
    /// form has exactly one correction, which is what makes this the id.
    public var original: String
    /// What the user replaced it with.
    public var replacement: String
    /// How many times this exact correction has been seen.
    public var count: Int
    /// The last time it was seen. Also the eviction order when the store is
    /// full.
    public var updatedAt: Date

    public var id: String { original }

    public init(original: String, replacement: String, count: Int = 1, updatedAt: Date = Date()) {
        self.original = original
        self.replacement = replacement
        self.count = count
        self.updatedAt = updatedAt
    }

    /// Tolerant on purpose: the file is shared between two processes and can be
    /// hand-edited. A pair with no `count` or no stamp is still a usable pair —
    /// only a missing side makes it meaningless, and that throws so the lossy
    /// array decode drops just that element.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        original = try c.decode(String.self, forKey: .original)
        replacement = try c.decode(String.self, forKey: .replacement)
        count = try c.decodeIfPresent(Int.self, forKey: .count) ?? 1
        updatedAt = try c.decodeIfPresent(Date.self, forKey: .updatedAt) ?? .distantPast
    }
}

/// A term the user typed in themselves, rather than one Parley worked out.
///
/// These are not substitutions — there is nothing to substitute, because
/// nothing came back wrong yet. They exist to bias recognition toward words the
/// user knows they are going to say. Until the relay carries a recognition
/// context (see `LexiconStore.recognitionTerms`) they are a list the user keeps
/// and Parley cannot yet spend.
public struct LexiconTerm: Codable, Sendable, Equatable, Identifiable {
    public var text: String
    public var updatedAt: Date

    public var id: String { text }

    public init(text: String, updatedAt: Date = Date()) {
        self.text = text
        self.updatedAt = updatedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = try c.decode(String.self, forKey: .text)
        updatedAt = try c.decodeIfPresent(Date.self, forKey: .updatedAt) ?? .distantPast
    }
}

/// The user's personal dictionary, as a value.
///
/// Every rule lives here rather than on the disk-backed `LexiconStore`, so all
/// of it can be tested on a machine with no App Group container — which is
/// every machine that runs `swift test`. `LexiconStore` is the same API with a
/// file behind it.
public struct Lexicon: Codable, Sendable, Equatable {
    public var pairs: [LexiconPair]
    public var terms: [LexiconTerm]

    /// How many times a correction has to be seen before `apply` will act on
    /// it.
    ///
    /// Two, and the second one is the whole point: a single edit is as likely
    /// to be the user rewording their sentence as it is to be a word Parley
    /// gets wrong. Acting on one sighting would mean the first time someone
    /// changed their mind mid-sentence, dictation started silently rewriting
    /// that word forever. Twice is cheap for a real mishearing — it happens
    /// every time the word is said — and expensive for a coincidence.
    public static let autoApplyThreshold = 2

    /// Caps, so a file two processes append to cannot grow without bound. The
    /// keyboard reads it on every appearance under a hard memory limit.
    public static let maxPairs = 500
    public static let maxTerms = 200

    public init(pairs: [LexiconPair] = [], terms: [LexiconTerm] = []) {
        self.pairs = pairs
        self.terms = terms
    }

    /// Decode what is readable and drop what is not, element by element. A
    /// single malformed pair must not cost the user the rest of their
    /// dictionary.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pairs = (try c.decodeIfPresent([Lossy<LexiconPair>].self, forKey: .pairs) ?? [])
            .compactMap(\.value)
        terms = (try c.decodeIfPresent([Lossy<LexiconTerm>].self, forKey: .terms) ?? [])
            .compactMap(\.value)
    }

    // MARK: learning

    /// Record a correction.
    ///
    /// The rule for a second, different correction of the same original is
    /// deliberately blunt: **the newer correction wins unless the standing one
    /// has already been confirmed.** A pair seen twice is a habit and stays; a
    /// pair seen once is a guess, and a fresher guess is a better guess. There
    /// is no arithmetic to reason about and no way for two rival corrections to
    /// trade the slot back and forth.
    ///
    /// What it costs: once a pair reaches the threshold, correcting the same
    /// word a *different* way can no longer displace it. That is what Settings
    /// is for — deleting the row is how the user changes their mind, and it is
    /// a thing they can see, unlike a scoring rule.
    ///
    /// Refused: empty sides, a no-op, and a replacement that contains its own
    /// original. The last one is the loop guard — "api" → "api endpoint" would
    /// grow the text every time it ran — and it is refused here as well as in
    /// `apply` because a row that can never fire is a row that makes the
    /// dictionary screen a lie.
    public mutating func record(original: String, replacement: String, now: Date = Date()) {
        let from = original.trimmingCharacters(in: .whitespacesAndNewlines)
        let to = replacement.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !from.isEmpty, !to.isEmpty, from != to, !Lexicon.loops(from: from, to: to) else {
            return
        }

        if let i = pairs.firstIndex(where: { $0.original == from }) {
            if pairs[i].replacement == to {
                pairs[i].count += 1
                pairs[i].updatedAt = now
            } else if pairs[i].count < Lexicon.autoApplyThreshold {
                pairs[i] = LexiconPair(original: from, replacement: to, count: 1, updatedAt: now)
            }
            return
        }

        pairs.append(LexiconPair(original: from, replacement: to, count: 1, updatedAt: now))
        evict()
    }

    /// A term the user added by hand. Re-adding one that is already there just
    /// freshens its stamp rather than growing a duplicate row.
    public mutating func addTerm(_ text: String, now: Date = Date()) {
        let term = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !term.isEmpty else { return }
        if let i = terms.firstIndex(where: { $0.text == term }) {
            terms[i].updatedAt = now
            return
        }
        terms.append(LexiconTerm(text: term, updatedAt: now))
        evict()
    }

    public mutating func removePair(original: String) {
        pairs.removeAll { $0.original == original }
    }

    public mutating func removeTerm(_ text: String) {
        terms.removeAll { $0.text == text }
    }

    public mutating func removeAll() {
        pairs = []
        terms = []
    }

    /// Oldest-updated first, which is the closest thing to "least useful" that
    /// costs nothing to track: a pair the user keeps re-confirming keeps its
    /// stamp fresh.
    private mutating func evict() {
        if pairs.count > Lexicon.maxPairs {
            pairs.sort { $0.updatedAt > $1.updatedAt }
            pairs.removeLast(pairs.count - Lexicon.maxPairs)
        }
        if terms.count > Lexicon.maxTerms {
            terms.sort { $0.updatedAt > $1.updatedAt }
            terms.removeLast(terms.count - Lexicon.maxTerms)
        }
    }

    // MARK: reading

    /// Newest first — the order the dictionary screen lists them in, and the
    /// order recognition bias would want if it ever gets a wire to ride on.
    public var pairsByRecency: [LexiconPair] {
        pairs.sorted { $0.updatedAt > $1.updatedAt }
    }

    public var termsByRecency: [LexiconTerm] {
        terms.sorted { $0.updatedAt > $1.updatedAt }
    }

    /// The words the user would rather hear back: everything they typed in, plus
    /// the right-hand side of every correction. Deduplicated, newest first.
    public var recognitionTerms: [String] {
        var seen = Set<String>()
        var out: [String] = []
        for text in termsByRecency.map(\.text) + pairsByRecency.map(\.replacement) {
            if seen.insert(text).inserted { out.append(text) }
        }
        return out
    }

    // MARK: applying

    /// Rewrite the corrections the user has confirmed.
    ///
    /// Three rules, each of them a way of not doing damage:
    ///
    /// - **Only confirmed pairs.** `count >= autoApplyThreshold`; see there.
    /// - **Longest original first.** With both "parley" and "parley cloud" on
    ///   file the longer one has to win, or it gets half-rewritten by the
    ///   shorter one and comes out as neither.
    /// - **Word boundaries for Latin, plain substring for CJK.** An all-ASCII
    ///   original matches case-insensitively and only as a whole word: dictation
    ///   capitalises arbitrarily, and "api" must not eat the "api" inside
    ///   "rapid". Chinese has no word boundaries to assert, so there the match
    ///   is a plain substring — which is exactly what makes 在 → 再 possible.
    ///
    /// Deterministic: the same lexicon and the same text always give the same
    /// answer, ties in original length broken alphabetically.
    public func apply(to text: String) -> String {
        guard !text.isEmpty else { return text }
        let usable =
            pairs
            .filter {
                $0.count >= Lexicon.autoApplyThreshold && !$0.original.isEmpty
                    && !$0.replacement.isEmpty
                    && !Lexicon.loops(from: $0.original, to: $0.replacement)
            }
            .sorted {
                $0.original.count != $1.original.count
                    ? $0.original.count > $1.original.count
                    : $0.original < $1.original
            }

        var out = text
        for pair in usable {
            out =
                pair.original.isLatinWordLike
                ? Lexicon.replaceWord(pair.original, with: pair.replacement, in: out)
                : out.replacingOccurrences(of: pair.original, with: pair.replacement)
        }
        return out
    }

    /// The replacement properly contains the original, so substituting would
    /// grow the text every time it ran — "api" → "api endpoint" reaching "api
    /// endpoint endpoint" and onward.
    ///
    /// *Properly* is the whole subtlety: "api" → "API" also contains its
    /// original (Latin pairs match case-insensitively), but re-applying it is a
    /// no-op rather than growth, so the length test is what separates the two.
    static func loops(from: String, to: String) -> Bool {
        guard to.count > from.count else { return false }
        return from.isLatinWordLike
            ? to.range(of: from, options: [.caseInsensitive]) != nil
            : to.contains(from)
    }

    /// Case-insensitive whole-word replacement, mirroring the desktop's
    /// `asciiVariantRe`: the boundary is asserted only on the sides that
    /// actually begin or end with a word character, so a pair like "sql," still
    /// matches at the end of a clause.
    static func replaceWord(_ original: String, with replacement: String, in text: String) -> String
    {
        let escaped = NSRegularExpression.escapedPattern(for: original)
        let before = original.first.map(isWordScalar) == true ? "(?<![A-Za-z0-9_])" : ""
        let after = original.last.map(isWordScalar) == true ? "(?![A-Za-z0-9_])" : ""
        guard
            let re = try? NSRegularExpression(
                pattern: before + escaped + after, options: [.caseInsensitive])
        else { return text }
        return re.stringByReplacingMatches(
            in: text, range: NSRange(text.startIndex..., in: text),
            withTemplate: NSRegularExpression.escapedTemplate(for: replacement))
    }

    private static func isWordScalar(_ c: Character) -> Bool {
        c.isLetter || c.isNumber || c == "_"
    }
}

extension String {
    /// All-ASCII, and carrying at least one letter or digit — the shape that has
    /// word boundaries worth asserting. Anything else (Chinese, kana, an emoji)
    /// takes the substring path.
    var isLatinWordLike: Bool {
        unicodeScalars.allSatisfy { $0.isASCII } && contains { $0.isLetter || $0.isNumber }
    }
}

/// Decodes an element or shrugs. Used for the lexicon's arrays so one bad row
/// costs one row rather than the file.
struct Lossy<T: Decodable>: Decodable {
    let value: T?

    init(from decoder: Decoder) throws {
        value = try? T(from: decoder)
    }
}

/// The user's personal dictionary on disk.
///
/// `lexicon.json` in the App Group container, so both processes see the same
/// file: the keyboard writes what it learned from an edit, the app reads it when
/// it folds the final transcript, and the Settings screen is the only place
/// either of them is edited by hand. Same plumbing as `DictationChannel` —
/// atomic writes, a tolerant decode, no schema migration to get wrong.
///
/// Unlike `DictationChannel` there is no Darwin note. Nothing here is live: a
/// lexicon is read at the two moments it matters (before a fold, before a
/// screen draws) and a change that lands a second later is simply picked up the
/// next time. A notification would buy nothing and would have to be listened
/// for in a process that is trying to hold no state at all.
public enum LexiconStore {
    public static let fileName = "lexicon.json"

    public static func load() -> Lexicon {
        guard let url = url, let data = try? Data(contentsOf: url) else { return Lexicon() }
        return (try? decoder.decode(Lexicon.self, from: data)) ?? Lexicon()
    }

    public static func save(_ lexicon: Lexicon) {
        guard let url = url, let data = try? encoder.encode(lexicon) else { return }
        try? data.write(to: url, options: .atomic)
    }

    /// Read, change, write. Not atomic across processes, and deliberately not
    /// defended against: the two writers are a keyboard learning a word and a
    /// person editing Settings, which are never the same second, and the worst
    /// case is one lost correction the next edit will teach again.
    private static func mutate(_ change: (inout Lexicon) -> Void) {
        var lexicon = load()
        change(&lexicon)
        save(lexicon)
    }

    public static func record(original: String, replacement: String) {
        mutate { $0.record(original: original, replacement: replacement) }
    }

    /// Record a whole edit's worth of spans in one read-modify-write, which is
    /// what the keyboard has (see `KeyboardLexiconWatch`).
    public static func record(_ spans: [EditDiff.Span]) {
        guard !spans.isEmpty else { return }
        mutate { lexicon in
            for span in spans {
                lexicon.record(original: span.original, replacement: span.replacement)
            }
        }
    }

    public static func addTerm(_ text: String) {
        mutate { $0.addTerm(text) }
    }

    public static func removePair(original: String) {
        mutate { $0.removePair(original: original) }
    }

    public static func removeTerm(_ text: String) {
        mutate { $0.removeTerm(text) }
    }

    public static func removeAll() {
        mutate { $0.removeAll() }
    }

    public static func pairs() -> [LexiconPair] { load().pairsByRecency }
    public static func terms() -> [LexiconTerm] { load().termsByRecency }

    /// The terms recognition should be biased toward.
    ///
    /// Nothing spends these yet. Soniox's config frame has a `context.terms`
    /// field and the desktop already fills it (`transcription/soniox.rs`), but
    /// `SonioxProtocol.Config` on the phone carries no such field and whether
    /// the hosted relay forwards one from an iOS client is not something this
    /// side can establish — so the wire is deliberately left alone and this is
    /// the seam the follow-up plugs into. See `docs/design/ios-voice-keyboard.md`.
    public static func recognitionTerms() -> [String] { load().recognitionTerms }

    public static func apply(to text: String) -> String { load().apply(to: text) }

    // MARK: file plumbing

    private static var url: URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: DictationChannel.appGroup)?
            .appendingPathComponent(fileName)
    }

    private static var encoder: JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        return e
    }

    private static var decoder: JSONDecoder { JSONDecoder() }
}
