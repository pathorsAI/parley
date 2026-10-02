import Foundation

/// The arithmetic behind learning from an edit the keyboard can only half see.
///
/// A keyboard extension's whole view of the field is the proxy's two clipped
/// runs of text either side of the cursor — `documentContextBeforeInput` and
/// `documentContextAfterInput` — each cut by iOS at a length it does not
/// promise. Comparing two such views taken minutes apart is the only way to
/// find out what the user corrected, and it is a genuinely unreliable
/// comparison — which is why the decisions live here, next to `EditDiff`,
/// rather than in the extension where nothing can be run against them.
///
/// `KeyboardLexiconWatch` is the stateful, UIKit-facing half; this is the half
/// worth testing.
///
/// ## Why both sides of the cursor
///
/// This used to read only the text *before* the cursor, and that was the bug
/// behind the worst pairs the dictionary ever learned. Fix 派斯 → Pathors in
/// 「我們派斯的產品很好」 and leave the cursor right after the fix, and the
/// before-cursor view goes from 「我們派斯的產品很好」 to 「我們Pathors」: the
/// rest of the sentence did not go anywhere, it is simply behind the cursor
/// now, but to a one-sided view it looks deleted — and it sits right against
/// the real change, so the diff merged the two into 派斯的產品很好 → Pathors.
/// The mirror case was silent: a misheard word *after* where the cursor ended
/// up was never seen at all. Reading both sides, the field is the same field
/// wherever the cursor is, and only the word that changed is different.
public enum LexiconCapture {
    /// How much of the field to keep **on each side of the cursor**. The
    /// proxy's view is bounded by iOS anyway; this bounds the diff, which is an
    /// O(n·m) table in a process with a hard memory cap — two sides of this
    /// are exactly `EditDiff.maxTokens` at most.
    public static let windowLimit = 200

    /// How much shared text, in `anchorWeight`, has to border a change —
    /// counting both sides together — before the change is believed to be one
    /// edit rather than the seam between two unrelated stretches.
    ///
    /// Below this the agreement is coincidence: two unrelated English
    /// sentences share a "the " often enough, and an edit invented between two
    /// unrelated pieces of text becomes a rule that rewrites the user's words
    /// from then on.
    public static let minAnchor = 6

    /// The least shared text, in `anchorWeight`, that has to sit on *each* side
    /// of a change that is not at a trustworthy edge — two ideographs, or three
    /// Latin characters ("Hi "). It is what pins a change at both ends: a
    /// change with shared text on only one side may run on into text that
    /// merely slid out of view.
    public static let minSideAnchor = 3

    /// How much of the smaller view has to line up with the other before the
    /// two are believed to be views of the same field. Half: generous enough
    /// for a long field whose windows overlap only partly because the cursor
    /// moved, strict enough to refuse two unrelated paragraphs that happen to
    /// share their commonest characters.
    public static let minCoverage = 0.5

    /// The field around the cursor at one moment: up to `windowLimit`
    /// characters before it and up to `windowLimit` after it, and whether
    /// either side was cut short by that limit.
    public struct Window: Equatable, Sendable {
        public let before: String
        public let after: String
        /// The text before the cursor ran past `windowLimit`, so the window's
        /// first character is not the field's.
        public let clippedStart: Bool
        /// The same at the far end.
        public let clippedEnd: Bool

        public init(before: String?, after: String?) {
            let before = before ?? ""
            let after = after ?? ""
            self.before = String(before.suffix(LexiconCapture.windowLimit))
            self.after = String(after.prefix(LexiconCapture.windowLimit))
            clippedStart = before.count > LexiconCapture.windowLimit
            clippedEnd = after.count > LexiconCapture.windowLimit
        }

        /// The window as one run of text — the cursor is not part of the field,
        /// and where it sits is the one thing that legitimately differs
        /// between two views of an unchanged field.
        public var text: String { before + after }
    }

    /// What one harvest came to: the pairs worth recording, and a reason for
    /// every change that was not one. Both are for the keyboard's log; only
    /// `learned` reaches the dictionary.
    public struct Outcome: Equatable, Sendable {
        public var learned: [EditDiff.Span] = []
        public var refusals: [EditDiff.Refusal] = []
    }

    /// Compare two views of the field and decide what, if anything, the user
    /// taught us.
    ///
    /// Three gates, in order:
    ///
    /// 1. **Same field.** The token alignment has to cover at least
    ///    `minCoverage` of the smaller view. Ends are no longer required to
    ///    agree — in a field longer than the windows, moving the cursor slides
    ///    *both* ends — but the bulk of the text has to.
    /// 2. **A vocabulary change.** `EditDiff`'s own refusals: insertions,
    ///    deletions, styling, too long, a lone CJK character.
    /// 3. **Anchored.** Shared text on both sides of the change
    ///    (`minSideAnchor` each, `minAnchor` together) — or, on a side with
    ///    none, the real edge of the field. An edge only counts as real when
    ///    neither view was clipped there: a change that runs into a clipped
    ///    edge may include text that only slid out of view, which is how a
    ///    whole clause became one side of a pair.
    public static func harvest(before: Window, after: Window) -> Outcome {
        let old = before.text
        let new = after.text
        guard old != new else { return Outcome(refusals: [.unchanged]) }
        guard !old.isEmpty, !new.isEmpty else { return Outcome(refusals: [.unrelated]) }
        guard let alignment = EditDiff.Alignment(old, new) else {
            return Outcome(refusals: [.oversized])
        }
        let smaller = min(alignment.weightA, alignment.weightB)
        guard alignment.matchedWeight >= minAnchor,
            Double(alignment.matchedWeight) >= minCoverage * Double(smaller)
        else { return Outcome(refusals: [.unrelated]) }

        let trustedStart = !before.clippedStart && !after.clippedStart
        let trustedEnd = !before.clippedEnd && !after.clippedEnd
        var outcome = Outcome()
        for change in alignment.changes {
            switch alignment.verdict(for: change) {
            case .refused(let reason):
                outcome.refusals.append(reason)
            case .learned(let span):
                let leftHolds =
                    change.atStart ? trustedStart : change.leftAnchor >= minSideAnchor
                let rightHolds = change.atEnd ? trustedEnd : change.rightAnchor >= minSideAnchor
                if leftHolds, rightHolds, change.leftAnchor + change.rightAnchor >= minAnchor {
                    outcome.learned.append(span)
                } else {
                    outcome.refusals.append(.unanchored)
                }
            }
        }
        return outcome
    }

    /// `harvest`, reduced to what is learned.
    public static func spans(before: Window, after: Window) -> [EditDiff.Span] {
        harvest(before: before, after: after).learned
    }

    /// Two whole, unclipped fields with the cursor at the end of each — the
    /// shape of a short field that was never scrolled, and the convenient one
    /// for a test.
    public static func spans(before: String, after: String) -> [EditDiff.Span] {
        spans(before: Window(before: before, after: nil), after: Window(before: after, after: nil))
    }
}
