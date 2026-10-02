import Foundation

/// Turn "the user fixed a word right after dictating" into (original,
/// replacement) pairs.
///
/// The phone's counterpart to the desktop's `src/lib/dictionary/diffCorrection.ts`,
/// and it has the same job with a harder input. The desktop watches one
/// Accessibility value and gets the whole field; the keyboard only ever sees
/// the text either side of the cursor, clipped at a length iOS does not
/// promise (see `LexiconCapture`). So this
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

    /// Why a changed stretch was not learned. Public so the keyboard can say,
    /// in its log, *which* refusal fired — "nothing was learned" is the common
    /// outcome, and without the reason a capture that never learns anything is
    /// indistinguishable from one that works and is simply not being fed.
    public enum Refusal: String, Sendable, CaseIterable {
        /// Words were added and nothing was replaced.
        case insertion
        /// Words were removed and nothing replaced them.
        case deletion
        /// Only case, punctuation or whitespace differ.
        case styling
        /// Either side is longer than `maxSpanLength`.
        case tooLong
        /// The original would be a single CJK character, and there is no shared
        /// neighbouring character to widen it with. See `widened`.
        case singleCharacter
        /// The change touches the edge of a clipped window, or is not bordered
        /// by enough shared text to say where it begins and ends. Only
        /// `LexiconCapture` reaches this one.
        case unanchored
        /// The two views share too little to be views of the same field. Only
        /// `LexiconCapture` reaches this one.
        case unrelated
        /// Nothing changed between the two views.
        case unchanged
        /// More tokens than `maxTokens`; the alignment was not attempted.
        case oversized
    }

    /// Longest either side of a span may be. A vocabulary fix is a name or a
    /// short phrase; past this the user is rewriting their sentence, and the
    /// two are indistinguishable from here.
    public static let maxSpanLength = 10

    /// How many tokens either side may carry before this gives up.
    ///
    /// The alignment is an O(n·m) table and it runs inside a keyboard
    /// extension, which iOS gives a hard memory cap and no patience. The
    /// callers bound their input to a few hundred characters already (two
    /// 200-character windows, one each side of the cursor — and a token is at
    /// least one character, so that is at most this many); this is the
    /// backstop that keeps a surprise from becoming a jetsam.
    public static let maxTokens = 400

    /// The replaced spans between what was dictated and what is there now.
    ///
    /// Empty is the normal answer. It means either nothing changed, or what
    /// changed was not a word being corrected — and in both cases there is
    /// nothing to learn.
    ///
    /// This is the context-free form: every changed region is vetted on its own
    /// content and nothing else. `LexiconCapture` is the form the keyboard
    /// uses, which also asks whether each region is anchored in text both views
    /// share.
    public static func spans(pasted: String, edited: String) -> [Span] {
        guard pasted != edited, let alignment = Alignment(pasted, edited) else { return [] }
        return alignment.changes.compactMap {
            if case .learned(let span) = alignment.verdict(for: $0) { return span }
            return nil
        }
    }

    /// What one changed region comes to.
    enum Verdict: Equatable {
        case learned(Span)
        case refused(Refusal)
    }

    /// Two token streams, aligned, with every stretch where they disagree and
    /// how much agreeing text sits on either side of it.
    struct Alignment {
        let a: [String]
        let b: [String]
        let changes: [Change]
        /// `anchorWeight` of everything the two streams share.
        let matchedWeight: Int
        let weightA: Int
        let weightB: Int

        /// `nil` when either side is empty or past `maxTokens`.
        init?(_ pasted: String, _ edited: String) {
            let a = EditDiff.tokenize(pasted)
            let b = EditDiff.tokenize(edited)
            guard !a.isEmpty, !b.isEmpty, a.count <= maxTokens, b.count <= maxTokens else {
                return nil
            }
            self.a = a
            self.b = b
            let regions = EditDiff.regions(a, b)
            let weights = a.map(EditDiff.anchorWeight(of:))
            func weight(_ range: Range<Int>) -> Int { weights[range].reduce(0, +) }

            var changes: [Change] = []
            for (k, region) in regions.enumerated() {
                // Everything between two regions is matched, token for token,
                // so the run to either side is measured on `a` alone.
                let leftStart = k == 0 ? 0 : regions[k - 1].a.upperBound
                let rightEnd = k == regions.count - 1 ? a.count : regions[k + 1].a.lowerBound
                changes.append(
                    Change(
                        a: region.a, b: region.b,
                        leftAnchor: weight(leftStart..<region.a.lowerBound),
                        rightAnchor: weight(region.a.upperBound..<rightEnd),
                        atStart: region.a.lowerBound == 0 && region.b.lowerBound == 0,
                        atEnd: region.a.upperBound == a.count && region.b.upperBound == b.count))
            }
            self.changes = changes
            let changedWeight = regions.reduce(0) { $0 + weight($1.a) }
            weightA = weights.reduce(0, +)
            matchedWeight = weightA - changedWeight
            weightB = b.reduce(0) { $0 + EditDiff.anchorWeight(of: $1) }
        }

        /// One changed region, vetted. Everything that is not a vocabulary
        /// correction is refused:
        ///
        /// - **A pure insertion or deletion.** There is no "this became that"
        ///   pair in it; the user added or removed words, which says nothing
        ///   about how any word should be transcribed.
        /// - **A case, punctuation or whitespace change.** "api" → "API" is the
        ///   user styling their sentence, and recording it would have the
        ///   lexicon fighting the host app's own autocapitalisation forever.
        /// - **A lone CJK character that cannot be widened.** See `widened`.
        /// - **Anything too long.** See `maxSpanLength`.
        func verdict(for change: Change) -> Verdict {
            let original = a[change.a].joined()
            let replacement = b[change.b].joined()
            let from = original.trimmingCharacters(in: .whitespacesAndNewlines)
            let to = replacement.trimmingCharacters(in: .whitespacesAndNewlines)
            if from.isEmpty, to.isEmpty { return .refused(.styling) }
            if from.isEmpty { return .refused(.insertion) }
            if to.isEmpty { return .refused(.deletion) }
            guard from != to, significant(from) != significant(to) else {
                return .refused(.styling)
            }
            // Widening needs the neighbour to sit right against the change,
            // which a stretch padded with whitespace does not have.
            let flush = from == original && to == replacement
            guard let span = widened(Span(original: from, replacement: to), change, flush: flush)
            else { return .refused(.singleCharacter) }
            guard span.original.count <= maxSpanLength, span.replacement.count <= maxSpanLength
            else { return .refused(.tooLong) }
            return .learned(span)
        }

        /// A CJK pair whose original — or whose replacement — is one character,
        /// grown by one shared neighbouring character so neither side is.
        ///
        /// Ideographs are diffed one at a time, so 派斯 → 帕斯 comes out of the
        /// alignment as 派 → 帕: the 斯 matches and is left out. Stored like
        /// that, the pair is applied as a plain substring everywhere, and 派對
        /// becomes 帕對. One character is too little context to be a word in
        /// Chinese, so a single-character original is never stored: the shared
        /// character after it (or, failing that, before it) is taken onto both
        /// sides, and 派斯 → 帕斯 is what is learned. The same goes for a
        /// replacement that would be one character (帕索斯 → 派斯 diffs to
        /// 帕索 → 派), because a pair that narrow is just as likely to fire in
        /// the wrong place.
        ///
        /// `nil` when the original is a single ideograph with nothing shared to
        /// widen into — or when the other side is not CJK at all, where there
        /// is no "neighbouring character of the same word" to speak of.
        func widened(_ span: Span, _ change: Change, flush: Bool) -> Span? {
            let loneOriginal = isLoneIdeograph(span.original)
            guard loneOriginal || isLoneIdeograph(span.replacement) else { return span }
            guard flush, isAllIdeographic(span.original), isAllIdeographic(span.replacement) else {
                return loneOriginal ? nil : span
            }
            // The tokens either side of a region are matched by construction,
            // so a neighbour on `a` is the same character on `b`.
            if change.a.upperBound < a.count, isLoneIdeograph(a[change.a.upperBound]) {
                let next = a[change.a.upperBound]
                return Span(original: span.original + next, replacement: span.replacement + next)
            }
            if change.a.lowerBound > 0, isLoneIdeograph(a[change.a.lowerBound - 1]) {
                let previous = a[change.a.lowerBound - 1]
                return Span(
                    original: previous + span.original, replacement: previous + span.replacement)
            }
            return loneOriginal ? nil : span
        }
    }

    /// One stretch where the two streams disagree, with the agreeing text on
    /// either side of it measured in `anchorWeight`.
    struct Change: Equatable {
        let a: Range<Int>
        let b: Range<Int>
        /// The matched run immediately before the change, back to the previous
        /// change or the start.
        let leftAnchor: Int
        /// The matched run immediately after it, up to the next change or the
        /// end.
        let rightAnchor: Int
        /// Nothing precedes the change on either side: it begins where both
        /// texts begin.
        let atStart: Bool
        /// Nothing follows it on either side.
        let atEnd: Bool
    }

    /// What a shared token is worth as evidence that two texts line up: an
    /// ideograph counts double.
    ///
    /// Chinese packs into five characters what English spends a clause on, so
    /// counting raw characters would demand several times more agreement from
    /// a Chinese user than from an English one — and would refuse exactly the
    /// correction this feature was built for.
    static func anchorWeight(of token: String) -> Int {
        token.reduce(0) { $0 + (isIdeographic($1) ? 2 : 1) }
    }

    /// One ideograph and nothing else.
    static func isLoneIdeograph(_ text: String) -> Bool {
        text.count == 1 && text.first.map(isIdeographic) == true
    }

    private static func isAllIdeographic(_ text: String) -> Bool {
        !text.isEmpty && text.allSatisfy(isIdeographic)
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
    /// 在來 → 再來 and sometimes 我在 → 我再 would give the user a lexicon they
    /// cannot predict.
    ///
    /// One flat table rather than an array of rows: at the two-window maximum
    /// that is 160 000 cells in one allocation instead of 401, freed the
    /// moment the harvest returns.
    private static func matches(_ a: [String], _ b: [String]) -> [(Int, Int)] {
        let width = b.count + 1
        var table = [Int32](repeating: 0, count: (a.count + 1) * width)
        for i in stride(from: a.count - 1, through: 0, by: -1) {
            for j in stride(from: b.count - 1, through: 0, by: -1) {
                table[i * width + j] =
                    a[i] == b[j]
                    ? table[(i + 1) * width + j + 1] + 1
                    : max(table[(i + 1) * width + j], table[i * width + j + 1])
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
            } else if table[(i + 1) * width + j] >= table[i * width + j + 1] {
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
    /// this is what lets 在來 → 再來 come out as a short pair instead of the whole
    /// sentence. Whitespace runs and single punctuation marks are tokens
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
