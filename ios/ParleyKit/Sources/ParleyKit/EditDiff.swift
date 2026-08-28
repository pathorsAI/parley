import Foundation

/// Turn "the user fixed a word right after dictating" into (original,
/// replacement) pairs.
///
/// The phone's counterpart to the desktop's `src/lib/dictionary/diffCorrection.ts`,
/// and it has the same job with a harder input. The desktop watches one
/// Accessibility value and gets the whole field; the keyboard only ever sees
/// `documentContextBeforeInput`, a clipped window ending at the cursor. So this
/// diff is deliberately token-level and deliberately suspicious: everything
/// interesting is in refusing the edits that are *not* a misheard word.
///
/// An insertion, a deletion, a wholesale rewrite and a typo fix all arrive
/// through the same channel. Only one of them is vocabulary, and learning any
/// of the others would poison the lexicon — a dictionary that rewrites text the
/// user never asked it to rewrite is worse than no dictionary.
public enum EditDiff {
    /// One replaced stretch: what was dictated, and what the user made of it.
    public struct Span: Equatable, Sendable {
        public let original: String
        public let replacement: String

        public init(original: String, replacement: String) {
            self.original = original
            self.replacement = replacement
        }
    }

    /// Longest either side of a span may be. A vocabulary fix is a name or a
    /// short phrase; past this the user is rewriting their sentence, and the
    /// two are indistinguishable from here.
    public static let maxSpanLength = 10

    /// How many tokens either side may carry before this gives up.
    ///
    /// The alignment is an O(n·m) table and it runs inside a keyboard
    /// extension, which iOS gives a hard memory cap and no patience. The
    /// callers bound their input to a couple of hundred characters already;
    /// this is the backstop that keeps a surprise from becoming a jetsam.
    public static let maxTokens = 400

    /// The replaced spans between what was dictated and what is there now.
    ///
    /// Empty is the normal answer. It means either nothing changed, or what
    /// changed was not a word being corrected — and in both cases there is
    /// nothing to learn.
    public static func spans(pasted: String, edited: String) -> [Span] {
        guard pasted != edited else { return [] }
        let a = tokenize(pasted)
        let b = tokenize(edited)
        guard !a.isEmpty, !b.isEmpty, a.count <= maxTokens, b.count <= maxTokens else { return [] }

        var out: [Span] = []
        for region in regions(a, b) {
            let original = a[region.a].joined()
            let replacement = b[region.b].joined()
            if let span = span(original: original, replacement: replacement) {
                out.append(span)
            }
        }
        return out
    }

    /// One changed region, vetted. `nil` for everything that is not a
    /// vocabulary correction:
    ///
    /// - **A pure insertion or deletion.** There is no "this became that" pair
    ///   in it; the user added or removed words, which says nothing about how
    ///   any word should be transcribed.
    /// - **A case, punctuation or whitespace change.** "api" → "API" is the
    ///   user styling their sentence, and recording it would have the lexicon
    ///   fighting the host app's own autocapitalisation forever.
    /// - **Anything too long.** See `maxSpanLength`.
    private static func span(original: String, replacement: String) -> Span? {
        let from = original.trimmingCharacters(in: .whitespacesAndNewlines)
        let to = replacement.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !from.isEmpty, !to.isEmpty, from != to else { return nil }
        guard from.count <= maxSpanLength, to.count <= maxSpanLength else { return nil }
        guard significant(from) != significant(to) else { return nil }
        return Span(original: from, replacement: to)
    }

    /// What is left of a string once the things a correction may not be about
    /// — case, punctuation, whitespace — are taken out of it. Two spans that
    /// reduce to the same thing differ only in styling.
    private static func significant(_ text: String) -> String {
        String(text.lowercased().unicodeScalars.filter {
            !CharacterSet.whitespacesAndNewlines.contains($0)
                && !CharacterSet.punctuationCharacters.contains($0)
                && !CharacterSet.symbols.contains($0)
        }.map(Character.init))
    }

    // MARK: alignment

    /// The stretches where the two token streams disagree, in order.
    ///
    /// Adjacent changed tokens land in the same region by construction — a
    /// region is simply the gap between two aligned tokens — which is what
    /// makes "pearly cloud" → "Parley Cloud" one span rather than two halves of
    /// one.
    private static func regions(
        _ a: [String], _ b: [String]
    ) -> [(a: Range<Int>, b: Range<Int>)] {
        var out: [(a: Range<Int>, b: Range<Int>)] = []
        var i = 0
        var j = 0
        for (ai, bj) in matches(a, b) {
            if ai > i || bj > j { out.append((i..<ai, j..<bj)) }
            i = ai + 1
            j = bj + 1
        }
        if i < a.count || j < b.count { out.append((i..<a.count, j..<b.count)) }
        return out
    }

    /// Index pairs of the longest common subsequence, ascending.
    ///
    /// A plain LCS table with a deterministic backtrack — ties always step in
    /// `a` first — because "the same edit always produces the same pair" is the
    /// property the whole feature is built on. A diff that sometimes learns
    /// 在 → 再 and sometimes learns 在來 → 再來 would give the user a lexicon
    /// they cannot predict.
    private static func matches(_ a: [String], _ b: [String]) -> [(Int, Int)] {
        var table = [[Int]](repeating: [Int](repeating: 0, count: b.count + 1), count: a.count + 1)
        for i in stride(from: a.count - 1, through: 0, by: -1) {
            for j in stride(from: b.count - 1, through: 0, by: -1) {
                table[i][j] =
                    a[i] == b[j]
                    ? table[i + 1][j + 1] + 1
                    : max(table[i + 1][j], table[i][j + 1])
            }
        }

        var out: [(Int, Int)] = []
        var i = 0
        var j = 0
        while i < a.count, j < b.count {
            if a[i] == b[j] {
                out.append((i, j))
                i += 1
                j += 1
            } else if table[i + 1][j] >= table[i][j + 1] {
                i += 1
            } else {
                j += 1
            }
        }
        return out
    }

    // MARK: tokens

    /// Split text into the units a correction can be about.
    ///
    /// Latin (and any other spaced script) runs as whole words, because the
    /// word is what gets misheard. Ideographic scripts one character at a time,
    /// because they are written without spaces and a character *is* the unit —
    /// this is what lets 在 → 再 come out as a two-character pair instead of the
    /// whole sentence. Whitespace runs and single punctuation marks are tokens
    /// too, so they can align rather than being silently absorbed into a
    /// neighbour.
    static func tokenize(_ text: String) -> [String] {
        var out: [String] = []
        var run = ""
        var runIsWord = false

        func flush() {
            if !run.isEmpty { out.append(run) }
            run = ""
        }

        for c in text {
            if c.isWhitespace {
                if runIsWord { flush() }
                runIsWord = false
                run.append(c)
            } else if isIdeographic(c) {
                flush()
                runIsWord = false
                out.append(String(c))
            } else if c.isLetter || c.isNumber || c == "'" || c == "\u{2019}" {
                if !runIsWord { flush() }
                runIsWord = true
                run.append(c)
            } else {
                flush()
                runIsWord = false
                out.append(String(c))
            }
        }
        flush()
        return out
    }

    /// Written without spaces, so one character is one token. CJK ideographs
    /// (including the extensions and the compatibility block), kana, and Hangul
    /// syllables.
    static func isIdeographic(_ c: Character) -> Bool {
        guard let scalar = c.unicodeScalars.first, c.unicodeScalars.count == 1 else { return false }
        switch scalar.value {
        case 0x3040...0x30FF,  // Hiragana, Katakana
            0x3400...0x4DBF,  // CJK Extension A
            0x4E00...0x9FFF,  // CJK Unified Ideographs
            0xAC00...0xD7AF,  // Hangul syllables
            0xF900...0xFAFF,  // CJK Compatibility Ideographs
            0x20000...0x2FA1F:  // CJK Extension B and beyond
            return true
        default:
            return false
        }
    }
}
