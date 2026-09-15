import XCTest

@testable import ParleyKit

/// What the in-transcript search promises. The UI on top is highlights and a
/// chevron; these are the parts that are a contract — which ranges match, in
/// what order, and what happens when the query is not really a query.
final class TranscriptSearchTests: XCTestCase {

    private func seg(_ id: String, _ text: String, isFinal: Bool = true)
        -> TranscriptSegment
    {
        TranscriptSegment(
            id: id, source: "mix", speaker: 1, text: text, isFinal: isFinal,
            startMs: 0, endMs: 1000)
    }

    /// The substring a hit actually covers, read back out of the segment it
    /// belongs to — which is the only way the range means anything.
    private func matched(_ hit: TranscriptSearch.Hit, in segments: [TranscriptSegment])
        -> String
    {
        guard let segment = segments.first(where: { $0.id == hit.segmentID }) else {
            return "<no such segment>"
        }
        return String(segment.text[hit.range])
    }

    // MARK: case folding

    func testMatchesRegardlessOfCase() {
        let segments = [seg("a", "Two weeks assumes your SSO is already on Okta.")]

        for query in ["okta", "OKTA", "Okta", "oKtA"] {
            let hits = TranscriptSearch.hits(in: segments, query: query)
            XCTAssertEqual(hits.count, 1, "query \(query)")
            XCTAssertEqual(matched(hits[0], in: segments), "Okta")
        }
    }

    /// The range comes back pointing at the text as written, not as searched —
    /// what gets highlighted is the transcript's own capitalisation.
    func testTheMatchedRangeKeepsTheOriginalSpelling() {
        let segments = [seg("a", "Forty is the FLOOR on the enterprise tier.")]

        let hits = TranscriptSearch.hits(in: segments, query: "floor")

        XCTAssertEqual(matched(hits[0], in: segments), "FLOOR")
    }

    // MARK: diacritics

    func testMatchesAcrossDiacritics() {
        let segments = [seg("a", "We met at the café on Wednesday.")]

        XCTAssertEqual(TranscriptSearch.hits(in: segments, query: "cafe").count, 1)
        XCTAssertEqual(TranscriptSearch.hits(in: segments, query: "café").count, 1)
    }

    /// Folding both ways at once: an unaccented query against accented text and
    /// the reverse, with the case fold on top.
    func testDiacriticAndCaseFoldTogether() {
        let segments = [seg("a", "Renée signed the order form.")]

        let hits = TranscriptSearch.hits(in: segments, query: "RENEE")

        XCTAssertEqual(hits.count, 1)
        XCTAssertEqual(matched(hits[0], in: segments), "Renée")
    }

    // MARK: zh-Hant

    /// The reason this is a substring search and not a tokeniser: Chinese has
    /// no spaces, so 「續約」 has to be findable inside 「下一次續約」 without
    /// anything having been taught where the word boundaries are.
    func testFindsChineseSubstringWithNoWordBoundaries() {
        let segments = [
            seg("a", "四十席是企業版的最低門檻，我沒辦法再往下。"),
            seg("b", "我能做的是把今年的價格鎖到下一次續約。"),
        ]

        let hits = TranscriptSearch.hits(in: segments, query: "續約")

        XCTAssertEqual(hits.count, 1)
        XCTAssertEqual(hits[0].segmentID, "b")
        XCTAssertEqual(matched(hits[0], in: segments), "續約")
    }

    func testFindsALongerChinesePhrase() {
        let segments = [seg("a", "兩週的前提是你們的 SSO 已經在 Okta 上。")]

        let hits = TranscriptSearch.hits(in: segments, query: "前提")

        XCTAssertEqual(hits.count, 1)
        XCTAssertEqual(matched(hits[0], in: segments), "前提")
    }

    // MARK: several hits

    func testFindsEveryOccurrenceInOneSegment() {
        let segments = [seg("a", "Forty seats, forty seats, and forty again.")]

        let hits = TranscriptSearch.hits(in: segments, query: "forty")

        XCTAssertEqual(hits.count, 3)
        XCTAssertEqual(hits.map { $0.segmentID }, ["a", "a", "a"])
        // In order, and not overlapping: each range starts after the last ended.
        let text = segments[0].text
        XCTAssertTrue(hits[0].range.upperBound <= hits[1].range.lowerBound)
        XCTAssertTrue(hits[1].range.upperBound <= hits[2].range.lowerBound)
        XCTAssertEqual(String(text[hits[0].range]), "Forty")
        XCTAssertEqual(String(text[hits[2].range]), "forty")
    }

    /// Document order across segments, because "n of N" and the next/previous
    /// chevrons walk this array and have to walk it down the page.
    func testHitsComeBackInDocumentOrder() {
        let segments = [
            seg("a", "The price hold is the lever."),
            seg("b", "A price hold helps."),
            seg("c", "Nothing relevant here."),
            seg("d", "Put the price hold in writing."),
        ]

        let hits = TranscriptSearch.hits(in: segments, query: "price hold")

        XCTAssertEqual(hits.map { $0.segmentID }, ["a", "b", "d"])
    }

    // MARK: the empty query

    func testEmptyQueryMatchesNothing() {
        let segments = [seg("a", "Anything at all.")]

        XCTAssertEqual(TranscriptSearch.hits(in: segments, query: ""), [])
    }

    /// A field holding only spaces is a field nobody has typed in yet. Matching
    /// every space in the transcript would light the whole column up.
    func testWhitespaceOnlyQueryMatchesNothing() {
        let segments = [seg("a", "Anything at all.")]

        XCTAssertEqual(TranscriptSearch.hits(in: segments, query: "   "), [])
        XCTAssertEqual(TranscriptSearch.hits(in: segments, query: "\n\t "), [])
    }

    /// Surrounding whitespace is trimmed, so a stray trailing space from a
    /// keyboard's autospacing does not lose a hit the reader can see.
    func testQueryIsTrimmed() {
        let segments = [seg("a", "Send the revised quote.")]

        let hits = TranscriptSearch.hits(in: segments, query: "  quote  ")

        XCTAssertEqual(hits.count, 1)
        XCTAssertEqual(matched(hits[0], in: segments), "quote")
    }

    // MARK: no hits

    func testNoHitsIsAnEmptyArray() {
        let segments = [
            seg("a", "Forty is the floor on the enterprise tier."),
            seg("b", "四十席是企業版的最低門檻。"),
        ]

        XCTAssertEqual(TranscriptSearch.hits(in: segments, query: "Okta"), [])
        XCTAssertEqual(TranscriptSearch.hits(in: segments, query: "續約"), [])
    }

    func testEmptyTranscriptMatchesNothing() {
        XCTAssertEqual(TranscriptSearch.hits(in: [], query: "anything"), [])
    }

    // MARK: what is not searched

    /// The tentative tail never reaches the detail screen, so a hit inside it
    /// would be a hit the reader cannot be scrolled to.
    func testSkipsSegmentsThatAreNotFinal() {
        let segments = [
            seg("committed", "The price hold is in the quote."),
            seg("tail", "The price hold is", isFinal: false),
        ]

        let hits = TranscriptSearch.hits(in: segments, query: "price hold")

        XCTAssertEqual(hits.map { $0.segmentID }, ["committed"])
    }
}
