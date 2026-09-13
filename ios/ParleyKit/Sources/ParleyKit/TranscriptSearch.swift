import Foundation

/// Finding a phrase inside one recording's transcript.
///
/// The library already searches titles and snippets; this is the other half —
/// once you are *inside* a recording, a one-hour meeting is one continuous
/// column and finding where somebody said the number you remember means
/// scrolling and reading.
///
/// Plain substring matching, deliberately. No tokenising, no stemming, no
/// index: the corpus is one meeting's worth of text, the reader is looking for
/// something they already know was said, and zh-Hant does not put spaces
/// between words — a tokeniser would have to be taught Chinese before it could
/// match 「續約」 inside 「下一次續約」, which a substring search does for free.
/// The same call handles both shipping languages with no branch.
///
/// Kept here rather than in the view because it is the part worth testing: the
/// UI is highlights and a chevron, but which ranges match, in what order, and
/// what an empty query means are contracts.
public enum TranscriptSearch {

    /// One occurrence, as the segment it is in and the range of that segment's
    /// `text` it covers.
    ///
    /// The range indexes `segment.text` and nothing else — it is only meaningful
    /// against the segment named by `segmentID`, which is why the two travel
    /// together. Diacritic-insensitive matching means the matched range is not
    /// always the same length as the query, so it is carried rather than
    /// recomputed from the query's length at the call site.
    public struct Hit: Equatable, Sendable {
        public let segmentID: String
        public let range: Range<String.Index>

        public init(segmentID: String, range: Range<String.Index>) {
            self.segmentID = segmentID
            self.range = range
        }
    }

    /// Every occurrence of `query`, in document order.
    ///
    /// - Case- and diacritic-insensitive, so "okta" finds "Okta" and "cafe"
    ///   finds "café". Both folds come from `String.range(of:options:)`, which
    ///   is the platform's own Unicode-correct comparison rather than a
    ///   lowercased-ASCII approximation.
    /// - Final segments only. The tentative tail a live session leaves behind
    ///   is not on screen, so it must not be findable either — a hit that
    ///   cannot be scrolled to is worse than no hit.
    /// - An empty or whitespace-only query matches nothing. It is what a search
    ///   field holds before anybody has typed and immediately after they clear
    ///   it, and highlighting the entire transcript at that moment is the one
    ///   behaviour guaranteed to be wrong.
    /// - All occurrences within a segment, not just the first: "n of N" has to
    ///   be able to count them, and a turn that says the thing twice is exactly
    ///   the turn somebody is looking for.
    public static func hits(in segments: [TranscriptSegment], query: String) -> [Hit] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return [] }

        var found: [Hit] = []
        for segment in segments where segment.isFinal {
            let text = segment.text
            var from = text.startIndex
            while from < text.endIndex,
                let match = text.range(
                    of: needle, options: [.caseInsensitive, .diacriticInsensitive],
                    range: from..<text.endIndex)
            {
                found.append(Hit(segmentID: segment.id, range: match))
                // Resume after the match, except for the degenerate empty match
                // a fold can in principle produce — advancing by one character
                // there is what keeps this from spinning forever.
                from =
                    match.upperBound > match.lowerBound
                    ? match.upperBound
                    : text.index(after: match.lowerBound)
            }
        }
        return found
    }
}
