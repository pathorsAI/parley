import XCTest

@testable import ParleyKit

/// The personal dictionary's rules, exercised as a value.
///
/// `LexiconStore` is the same API with a file behind it, and the file lives in
/// an App Group container that does not exist on a machine running `swift test`
/// — which is exactly why every rule is on `Lexicon` and none of them is on the
/// store.
final class LexiconTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)
    private func t(_ offset: TimeInterval) -> Date { t0.addingTimeInterval(offset) }

    /// A pair confirmed enough times to be worth applying.
    private func confirmed(_ original: String, _ replacement: String) -> LexiconPair {
        LexiconPair(
            original: original, replacement: replacement,
            count: Lexicon.autoApplyThreshold, updatedAt: t0)
    }

    // MARK: recording

    func testFirstSightingIsRecordedOnce() {
        var lexicon = Lexicon()
        lexicon.record(original: "pearly", replacement: "Parley", now: t0)
        XCTAssertEqual(lexicon.pairs.count, 1)
        XCTAssertEqual(lexicon.pairs[0].count, 1)
        XCTAssertEqual(lexicon.pairs[0].updatedAt, t0)
    }

    func testTheSameCorrectionAgainIncrementsAndRestamps() {
        var lexicon = Lexicon()
        lexicon.record(original: "pearly", replacement: "Parley", now: t0)
        lexicon.record(original: "pearly", replacement: "Parley", now: t(60))
        XCTAssertEqual(lexicon.pairs.count, 1)
        XCTAssertEqual(lexicon.pairs[0].count, 2)
        XCTAssertEqual(lexicon.pairs[0].updatedAt, t(60))
    }

    func testAFresherCorrectionDisplacesAnUnconfirmedOne() {
        // Seen once is a guess; a newer guess is a better guess.
        var lexicon = Lexicon()
        lexicon.record(original: "pearly", replacement: "Parley", now: t0)
        lexicon.record(original: "pearly", replacement: "Purley", now: t(60))
        XCTAssertEqual(lexicon.pairs.count, 1)
        XCTAssertEqual(lexicon.pairs[0].replacement, "Purley")
        XCTAssertEqual(lexicon.pairs[0].count, 1)
    }

    func testAConfirmedCorrectionKeepsItsSlot() {
        // Twice is a habit. Deleting the row in Settings is how the user changes
        // their mind — deliberately, and visibly.
        var lexicon = Lexicon()
        lexicon.record(original: "pearly", replacement: "Parley", now: t0)
        lexicon.record(original: "pearly", replacement: "Parley", now: t(60))
        lexicon.record(original: "pearly", replacement: "Purley", now: t(120))
        XCTAssertEqual(lexicon.pairs.count, 1)
        XCTAssertEqual(lexicon.pairs[0].replacement, "Parley")
        XCTAssertEqual(lexicon.pairs[0].count, 2)
    }

    func testNonsensePairsAreRefused() {
        var lexicon = Lexicon()
        lexicon.record(original: "", replacement: "Parley", now: t0)
        lexicon.record(original: "pearly", replacement: "   ", now: t0)
        lexicon.record(original: "same", replacement: "same", now: t0)
        XCTAssertTrue(lexicon.pairs.isEmpty)
    }

    func testBothSidesAreTrimmed() {
        var lexicon = Lexicon()
        lexicon.record(original: "  pearly ", replacement: " Parley\n", now: t0)
        XCTAssertEqual(lexicon.pairs[0].original, "pearly")
        XCTAssertEqual(lexicon.pairs[0].replacement, "Parley")
    }

    func testAPairThatWouldGrowTheTextIsRefused() {
        // "api" → "api endpoint" applied to its own output forever.
        var lexicon = Lexicon()
        lexicon.record(original: "api", replacement: "the API endpoint", now: t0)
        lexicon.record(original: "在", replacement: "在再", now: t0)
        XCTAssertTrue(lexicon.pairs.isEmpty)
    }

    func testSpansFromADiffFeedStraightIn() {
        var lexicon = Lexicon()
        for span in EditDiff.spans(pasted: "我在來一次", edited: "我再來一次") {
            lexicon.record(original: span.original, replacement: span.replacement, now: t0)
        }
        XCTAssertEqual(lexicon.pairs.map(\.original), ["在"])
    }

    // MARK: terms

    func testTermsAreAddedTrimmedAndDeduplicated() {
        var lexicon = Lexicon()
        lexicon.addTerm(" Pathors ", now: t0)
        lexicon.addTerm("Pathors", now: t(60))
        lexicon.addTerm("", now: t(60))
        XCTAssertEqual(lexicon.terms.map(\.text), ["Pathors"])
        XCTAssertEqual(lexicon.terms[0].updatedAt, t(60))
    }

    func testRecognitionTermsAreManualTermsThenReplacements() {
        var lexicon = Lexicon()
        lexicon.addTerm("Pathors", now: t(10))
        lexicon.record(original: "pearly", replacement: "Parley", now: t(20))
        lexicon.record(original: "sonyox", replacement: "Soniox", now: t(30))
        XCTAssertEqual(lexicon.recognitionTerms, ["Pathors", "Soniox", "Parley"])
    }

    func testRecognitionTermsDeduplicate() {
        var lexicon = Lexicon()
        lexicon.addTerm("Parley", now: t(10))
        lexicon.record(original: "pearly", replacement: "Parley", now: t(20))
        XCTAssertEqual(lexicon.recognitionTerms, ["Parley"])
    }

    // MARK: removal

    func testRemoval() {
        var lexicon = Lexicon()
        lexicon.record(original: "pearly", replacement: "Parley", now: t0)
        lexicon.addTerm("Pathors", now: t0)
        lexicon.removePair(original: "pearly")
        lexicon.removeTerm("Pathors")
        XCTAssertTrue(lexicon.pairs.isEmpty)
        XCTAssertTrue(lexicon.terms.isEmpty)

        lexicon.record(original: "pearly", replacement: "Parley", now: t0)
        lexicon.addTerm("Pathors", now: t0)
        lexicon.removeAll()
        XCTAssertEqual(lexicon, Lexicon())
    }

    // MARK: caps

    func testThePairCapEvictsTheOldestUpdated() {
        var lexicon = Lexicon()
        for i in 0...Lexicon.maxPairs {
            lexicon.record(original: "w\(i)", replacement: "W\(i)", now: t(Double(i)))
        }
        XCTAssertEqual(lexicon.pairs.count, Lexicon.maxPairs)
        XCTAssertNil(lexicon.pairs.first { $0.original == "w0" })
        XCTAssertNotNil(lexicon.pairs.first { $0.original == "w\(Lexicon.maxPairs)" })
    }

    func testTheTermCapEvictsTheOldestUpdated() {
        var lexicon = Lexicon()
        for i in 0...Lexicon.maxTerms {
            lexicon.addTerm("t\(i)", now: t(Double(i)))
        }
        XCTAssertEqual(lexicon.terms.count, Lexicon.maxTerms)
        XCTAssertNil(lexicon.terms.first { $0.text == "t0" })
    }

    // MARK: applying

    func testASinglySeenPairIsNotApplied() {
        var lexicon = Lexicon()
        lexicon.record(original: "pearly", replacement: "Parley", now: t0)
        XCTAssertEqual(lexicon.apply(to: "we use pearly"), "we use pearly")
    }

    func testAConfirmedPairIsApplied() {
        let lexicon = Lexicon(pairs: [confirmed("pearly", "Parley")])
        XCTAssertEqual(lexicon.apply(to: "we use pearly today"), "we use Parley today")
    }

    func testLatinPairsNeedWordBoundaries() {
        let lexicon = Lexicon(pairs: [confirmed("api", "API")])
        // "rapid" contains "api" and must be left alone.
        XCTAssertEqual(lexicon.apply(to: "a rapid api call"), "a rapid API call")
    }

    func testLatinPairsMatchRegardlessOfCase() {
        // Dictation capitalises arbitrarily; the pair is about the word.
        let lexicon = Lexicon(pairs: [confirmed("pearly", "Parley")])
        XCTAssertEqual(lexicon.apply(to: "Pearly and pearly"), "Parley and Parley")
    }

    func testCJKPairsAreAPlainSubstringReplacement() {
        let lexicon = Lexicon(pairs: [confirmed("在來", "再來")])
        XCTAssertEqual(lexicon.apply(to: "我在來一次"), "我再來一次")
    }

    func testTheLongestOriginalWins() {
        // With both on file, "parley cloud" must not be half-rewritten by
        // "parley" and come out as neither.
        let lexicon = Lexicon(pairs: [
            confirmed("pearly", "Parley"),
            confirmed("pearly clod", "Parley Cloud"),
        ])
        XCTAssertEqual(lexicon.apply(to: "ship on pearly clod"), "ship on Parley Cloud")
    }

    func testALoopingPairIsNeverAppliedEvenIfItIsOnFile() {
        // `record` refuses these, but the file is shared and hand-editable.
        let lexicon = Lexicon(pairs: [confirmed("api", "api endpoint")])
        XCTAssertEqual(lexicon.apply(to: "the api"), "the api")
    }

    func testApplyIsDeterministicAndLeavesUnknownTextAlone() {
        let lexicon = Lexicon(pairs: [
            confirmed("pearly", "Parley"), confirmed("在", "再"),
        ])
        let text = "我在說 pearly 的事"
        let once = lexicon.apply(to: text)
        XCTAssertEqual(once, "我再說 Parley 的事")
        XCTAssertEqual(lexicon.apply(to: text), once)
    }

    func testApplyOnEmptyLexiconAndEmptyText() {
        XCTAssertEqual(Lexicon().apply(to: "untouched"), "untouched")
        XCTAssertEqual(Lexicon(pairs: [confirmed("a", "b")]).apply(to: ""), "")
    }

    func testARegexMetacharacterInAPairIsALiteral() {
        let lexicon = Lexicon(pairs: [confirmed("c++", "C++")])
        XCTAssertEqual(lexicon.apply(to: "wrote c++ today"), "wrote C++ today")
    }

    func testADollarInAReplacementIsALiteral() {
        let lexicon = Lexicon(pairs: [confirmed("usd", "$")])
        XCTAssertEqual(lexicon.apply(to: "10 usd"), "10 $")
    }

    // MARK: coding

    func testRoundTrip() throws {
        var lexicon = Lexicon()
        lexicon.record(original: "pearly", replacement: "Parley", now: t0)
        lexicon.addTerm("Pathors", now: t0)
        let data = try JSONEncoder().encode(lexicon)
        XCTAssertEqual(try JSONDecoder().decode(Lexicon.self, from: data), lexicon)
    }

    func testDecodeToleratesMissingFieldsAndDropsOnlyTheUnreadableRows() throws {
        let json = """
            {
              "pairs": [
                {"original": "pearly", "replacement": "Parley"},
                {"replacement": "no original here"},
                {"original": "在", "replacement": "再", "count": 7}
              ],
              "terms": [{"text": "Pathors"}, {"nope": true}]
            }
            """
        let lexicon = try JSONDecoder().decode(Lexicon.self, from: Data(json.utf8))
        XCTAssertEqual(lexicon.pairs.map(\.original), ["pearly", "在"])
        XCTAssertEqual(lexicon.pairs[0].count, 1)
        XCTAssertEqual(lexicon.pairs[1].count, 7)
        XCTAssertEqual(lexicon.terms.map(\.text), ["Pathors"])
    }

    func testDecodeOfAnEmptyObjectIsAnEmptyLexicon() throws {
        XCTAssertEqual(try JSONDecoder().decode(Lexicon.self, from: Data("{}".utf8)), Lexicon())
    }
}
