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
        XCTAssertEqual(lexicon.pairs.map(\.original), ["在來"])
    }

    func testASingleCJKCharacterOriginalIsNeverStored() {
        // Applied as a substring, 派 → 帕 would rewrite 派對 as well.
        var lexicon = Lexicon()
        lexicon.record(original: "派", replacement: "帕", now: t0)
        XCTAssertFalse(lexicon.recordConfirmed(original: "派", replacement: "帕", now: t0))
        XCTAssertTrue(lexicon.pairs.isEmpty)
        XCTAssertEqual(Lexicon.problem(original: "派", replacement: "帕"), .singleCharacter)
        // One Latin letter is a different matter: it only ever matches as a
        // whole word.
        XCTAssertNil(Lexicon.problem(original: "d", replacement: "the"))
    }

    // MARK: confirmed corrections

    func testAConfirmedCorrectionAppliesAtOnce() {
        var lexicon = Lexicon()
        XCTAssertTrue(lexicon.recordConfirmed(original: " 派斯 ", replacement: "Pathors", now: t0))
        XCTAssertEqual(lexicon.pairs, [confirmed("派斯", "Pathors")])
        XCTAssertEqual(lexicon.apply(to: "我們派斯的產品"), "我們Pathors的產品")
    }

    func testAConfirmedCorrectionReplacesEvenAConfirmedPair() {
        // `record` keeps a confirmed pair against a rival inference; a
        // correction the user typed in is not an inference.
        var lexicon = Lexicon(pairs: [confirmed("pearly", "Parley")])
        lexicon.recordConfirmed(original: "pearly", replacement: "Pearl Lee", now: t(60))
        XCTAssertEqual(lexicon.pairs.count, 1)
        XCTAssertEqual(lexicon.pairs[0].replacement, "Pearl Lee")
        XCTAssertEqual(lexicon.pairs[0].count, Lexicon.autoApplyThreshold)
        XCTAssertEqual(lexicon.pairs[0].updatedAt, t(60))
    }

    func testConfirmingAPairAlreadySeenKeepsItsCount() {
        var lexicon = Lexicon(pairs: [
            LexiconPair(original: "pearly", replacement: "Parley", count: 5, updatedAt: t0)
        ])
        lexicon.recordConfirmed(original: "pearly", replacement: "Parley", now: t(60))
        XCTAssertEqual(lexicon.pairs[0].count, 5)
    }

    func testAConfirmedCorrectionIsRefusedLikeAnyOther() {
        var lexicon = Lexicon()
        XCTAssertFalse(lexicon.recordConfirmed(original: "", replacement: "x", now: t0))
        XCTAssertFalse(lexicon.recordConfirmed(original: "same", replacement: "same", now: t0))
        XCTAssertFalse(lexicon.recordConfirmed(original: "api", replacement: "api v2", now: t0))
        XCTAssertTrue(lexicon.pairs.isEmpty)
        XCTAssertEqual(Lexicon.problem(original: "api", replacement: "api v2"), .grows)
        XCTAssertEqual(Lexicon.problem(original: "", replacement: "x"), .empty)
        XCTAssertEqual(Lexicon.problem(original: "a b", replacement: "a b"), .unchanged)
    }

    func testAConfirmedCorrectionJoinsTheRecognitionTerms() {
        var lexicon = Lexicon()
        lexicon.recordConfirmed(original: "派斯", replacement: "Pathors", now: t0)
        XCTAssertEqual(lexicon.recognitionTerms, ["Pathors"])
    }

    // MARK: system terms

    func testSystemTermsAreCleanedCappedAndReplacedWholesale() {
        var lexicon = Lexicon()
        XCTAssertTrue(lexicon.replaceSystemTerms([" 王小明 ", "", "王小明", "Ada"]))
        XCTAssertEqual(lexicon.systemTerms, ["王小明", "Ada"])
        XCTAssertFalse(lexicon.replaceSystemTerms(["王小明", "Ada"]), "unchanged is not a change")
        XCTAssertTrue(lexicon.replaceSystemTerms(["Grace"]))
        XCTAssertEqual(lexicon.systemTerms, ["Grace"])

        let many = (0..<(Lexicon.maxSystemTerms + 50)).map { "name\($0)" }
        lexicon.replaceSystemTerms(many)
        XCTAssertEqual(lexicon.systemTerms.count, Lexicon.maxSystemTerms)
        XCTAssertEqual(lexicon.systemTerms.first, "name0")
    }

    func testSystemTermsComeAfterTheUsersOwnWords() {
        // The order is the priority: the polish keeps the first 30, Soniox the
        // first 200, and the user's words have to survive both caps.
        var lexicon = Lexicon(systemTerms: ["Ada", "Parley"])
        lexicon.addTerm("Pathors", now: t(10))
        lexicon.record(original: "pearly", replacement: "Parley", now: t(20))
        XCTAssertEqual(lexicon.recognitionTerms, ["Pathors", "Parley", "Ada"])
        XCTAssertEqual(lexicon.userTerms, ["Pathors", "Parley"])
    }

    func testClearingTheDictionaryKeepsTheSystemTerms() {
        var lexicon = Lexicon(systemTerms: ["Ada"])
        lexicon.addTerm("Pathors", now: t0)
        lexicon.removeAll()
        XCTAssertEqual(lexicon, Lexicon(systemTerms: ["Ada"]))
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
            confirmed("pearly", "Parley"), confirmed("在說", "再說"),
        ])
        let text = "我在說 pearly 的事"
        let once = lexicon.apply(to: text)
        XCTAssertEqual(once, "我再說 Parley 的事")
        XCTAssertEqual(lexicon.apply(to: text), once)
    }

    func testAWidenedCJKPairLeavesOtherWordsWithTheSameCharacterAlone() {
        let lexicon = Lexicon(pairs: [confirmed("派斯", "帕斯")])
        XCTAssertEqual(lexicon.apply(to: "派斯的派對"), "帕斯的派對")
        XCTAssertEqual(lexicon.apply(to: "派對"), "派對")
    }

    func testALegacySingleCharacterPairIsNotApplied() {
        // Written before the minimum span existed, and still on file.
        let lexicon = Lexicon(pairs: [confirmed("派", "帕")])
        XCTAssertEqual(lexicon.apply(to: "派對"), "派對")
    }

    func testApplyCountsItsReplacements() {
        let lexicon = Lexicon(pairs: [confirmed("pearly", "Parley"), confirmed("派斯", "Pathors")])
        let result = lexicon.applyCounting(to: "pearly, Pearly, 派斯 and rapid")
        XCTAssertEqual(result.text, "Parley, Parley, Pathors and rapid")
        XCTAssertEqual(result.hits, 3)
        XCTAssertEqual(lexicon.applyCounting(to: "nothing here").hits, 0)
    }

    func testSubstituteUsesTheSameMatchingRules() {
        XCTAssertEqual(
            Lexicon.substitute("api", with: "API", in: "a rapid api").text, "a rapid API")
        XCTAssertEqual(Lexicon.substitute("派斯", with: "Pathors", in: "派斯派斯").hits, 2)
        XCTAssertEqual(Lexicon.substitute("zzz", with: "y", in: "abc").hits, 0)
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

    func testSystemTermsRoundTripAndAMalformedListCostsOnlyThem() throws {
        let lexicon = Lexicon(
            pairs: [confirmed("pearly", "Parley")], systemTerms: ["Ada", "王小明"])
        let data = try JSONEncoder().encode(lexicon)
        XCTAssertEqual(try JSONDecoder().decode(Lexicon.self, from: data), lexicon)

        let json = #"{"pairs":[{"original":"pearly","replacement":"Parley"}],"systemTerms":"oops"}"#
        let decoded = try JSONDecoder().decode(Lexicon.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.pairs.map(\.original), ["pearly"])
        XCTAssertEqual(decoded.systemTerms, [])
    }

    func testDecodeOfAnEmptyObjectIsAnEmptyLexicon() throws {
        XCTAssertEqual(try JSONDecoder().decode(Lexicon.self, from: Data("{}".utf8)), Lexicon())
    }
}
