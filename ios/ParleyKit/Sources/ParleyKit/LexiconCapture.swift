import Foundation

/// The arithmetic behind learning from an edit the keyboard can only half see.
///
/// A keyboard extension's whole view of the field is
/// `textDocumentProxy.documentContextBeforeInput`: a run of text ending at the
/// cursor, clipped by iOS at a length it does not promise. Comparing two such
/// windows taken minutes apart is the only way to find out what the user
/// corrected, and it is a genuinely unreliable comparison — which is why the
/// decisions live here, next to `EditDiff`, rather than in the extension where
/// nothing can be run against them.
///
/// `KeyboardLexiconWatch` is the stateful, UIKit-facing half; this is the half
/// worth testing.
public enum LexiconCapture {
    /// How much of the field to keep. The proxy's window is bounded by iOS
    /// anyway; this bounds the diff, which is an O(n·m) table in a process with
    /// a hard memory cap.
    public static let windowLimit = 200

    /// How much the two windows must agree, at one end or the other, before they
    /// are believed to be views of the same field.
    ///
    /// Measured in `anchorWeight`, not characters. Below this the agreement is
    /// coincidence — two unrelated English sentences share a "the " often enough
    /// — and an edit invented between two unrelated pieces of text becomes a rule
    /// that rewrites the user's words from then on.
    public static let minAnchor = 6

    /// The stretch of the field worth remembering.
    public static func window(_ context: String?) -> String {
        String((context ?? "").suffix(windowLimit))
    }

    /// Whether two windows are worth diffing at all.
    ///
    /// Both end at the cursor and both begin wherever iOS decided to clip —
    /// which is *not* the same offset once the text has changed length, so there
    /// is no index arithmetic that lines them up. What can be checked is whether
    /// they agree at one end: a run of shared characters at the front or the
    /// back says these are two views of one field.
    ///
    /// That is the only gate. Deciding which parts actually changed is
    /// `EditDiff`'s job and it is better at it — a shared prefix that has slid
    /// out of the window comes back as a pure deletion, an over-long rewrite
    /// comes back as nothing, and both are refusals it already makes.
    ///
    /// It is deliberately *not* a trim. Cutting the windows down to their
    /// disagreement here would cut through the middle of words: "we use pearly"
    /// against "we use Parley" shares the prefix "we use " and the suffix "y",
    /// so the trimmed pair is "pearl" → "Parle" — and a Latin pair needs a whole
    /// word to match, so that rule would then fire on nothing. Handing both
    /// windows to a token-level diff is what keeps the pair at word edges.
    public static func alignable(_ before: String, _ after: String) -> Bool {
        guard !before.isEmpty, !after.isEmpty, before != after else { return false }
        let a = Array(before)
        let b = Array(after)

        var prefix = 0
        var prefixWeight = 0
        while prefix < a.count, prefix < b.count, a[prefix] == b[prefix] {
            prefixWeight += anchorWeight(a[prefix])
            prefix += 1
        }
        var suffix = 0
        var suffixWeight = 0
        while suffix < a.count - prefix, suffix < b.count - prefix,
            a[a.count - 1 - suffix] == b[b.count - 1 - suffix]
        {
            suffixWeight += anchorWeight(a[a.count - 1 - suffix])
            suffix += 1
        }
        return max(prefixWeight, suffixWeight) >= minAnchor
    }

    /// What one shared character is worth as evidence: an ideograph counts
    /// double.
    ///
    /// Chinese packs into five characters what English spends a clause on, so
    /// counting raw characters would demand several times more agreement from a
    /// Chinese user than from an English one — and would refuse exactly the
    /// correction this feature was built for. 明天我**在**來一次好嗎 → 再 shares
    /// eight characters with its corrected form, and a raw count of six would
    /// have thrown it away for want of a ninth.
    private static func anchorWeight(_ c: Character) -> Int {
        EditDiff.isIdeographic(c) ? 2 : 1
    }

    /// What the user taught us, from two windows on the same field. Empty
    /// whenever there is nothing worth learning — which is the common case, and
    /// the safe one.
    public static func spans(before: String, after: String) -> [EditDiff.Span] {
        guard alignable(before, after) else { return [] }
        return EditDiff.spans(pasted: before, edited: after)
    }
}
