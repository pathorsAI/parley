import XCTest

@testable import ParleyKit

/// The English word list. Fixtures for the rules, because the assertions are
/// about *order*, and a corpus that gets regenerated would own that order
/// instead of this file. The bundled resource gets its own section at the end.
final class EnglishWordsTests: XCTestCase {
    /// Hand-written, most frequent first — the array position is the rank, so
    /// alphabetical order and frequency order disagree on purpose here.
    private let fixture = EnglishWords(words: ["the", "to", "tomorrow", "today", "tomato"])

    func testCompletionsComeBackInListOrderRatherThanAlphabetically() {
        // Alphabetically this range is today, tomato, tomorrow — so anything
        // that answered in sorted order would be visibly wrong.
        XCTAssertEqual(
            fixture.completions(for: "to"), ["to", "tomorrow", "today", "tomato"])
    }

    func testAWordThatIsExactlyThePrefixIsOffered() {
        // Tapping it still adds the space, which is the whole reason someone
        // would tap a word they have already finished typing.
        XCTAssertEqual(fixture.completions(for: "to").first, "to")
        XCTAssertEqual(fixture.completions(for: "the"), ["the"])
    }

    func testTheLimitTakesTheMostFrequentRatherThanTheFirstAlphabetically() {
        XCTAssertEqual(fixture.completions(for: "to", limit: 2), ["to", "tomorrow"])
        XCTAssertEqual(fixture.completions(for: "tom", limit: 1), ["tomorrow"])
        XCTAssertEqual(fixture.completions(for: "to", limit: 0), [])
    }

    func testThePrefixIsCaseInsensitive() {
        let expected = fixture.completions(for: "to")
        XCTAssertEqual(fixture.completions(for: "TO"), expected)
        XCTAssertEqual(fixture.completions(for: "To"), expected)
    }

    func testAnEmptyPrefixOffersNothing() {
        // "Every word in the language" is not a suggestion.
        XCTAssertEqual(fixture.completions(for: ""), [])
    }

    func testAPrefixNothingStartsWithOffersNothing() {
        XCTAssertEqual(fixture.completions(for: "zzz"), [])
        XCTAssertEqual(fixture.completions(for: "tox"), [])
    }

    func testATypographicApostropheMatchesThePlainOneInTheList() {
        // A field with smart quotes on turns the keyboard's ' into ’, and the
        // user asking about don’t is asking about the list's don't.
        let contractions = EnglishWords(words: ["do", "done", "don't"])
        XCTAssertTrue(contractions.completions(for: "don\u{2019}").contains("don't"))
        XCTAssertEqual(
            contractions.completions(for: "don\u{2019}t"),
            contractions.completions(for: "don't"))
    }

    func testFollowersComeBackBestFirstInTheirOwnCase() {
        let words = EnglishWords(words: [], followers: ["new": ["York", "and"]])
        XCTAssertEqual(words.nextWords(after: "new"), ["York", "and"])
        XCTAssertEqual(words.nextWords(after: "New"), ["York", "and"])
        XCTAssertEqual(words.nextWords(after: "new", limit: 1), ["York"])
        XCTAssertEqual(words.nextWords(after: "old"), [])
    }

    func testRankIsAnExactMatchOnly() {
        XCTAssertEqual(fixture.rank(of: "tomorrow"), 2)
        XCTAssertEqual(fixture.rank(of: "Tomorrow"), 2)
        XCTAssertNil(fixture.rank(of: "tomo"))
        XCTAssertNil(fixture.rank(of: ""))
    }

    func testAMissingResourceIsSilentRatherThanFatal() {
        // A keyboard extension that crashed because a file moved would be far
        // worse than one that stops suggesting.
        let missing = EnglishWords(wordsURL: nil, followersURL: nil)
        XCTAssertEqual(missing.completions(for: "to"), [])
        XCTAssertEqual(missing.completions(for: "a"), [])
        XCTAssertEqual(missing.nextWords(after: "thank"), [])
        XCTAssertNil(missing.rank(of: "the"))
        XCTAssertEqual(WordSuggestions.suggestions(for: "thankyou", in: missing), [])
        XCTAssertEqual(WordSuggestions.predictions(after: "thank ", in: missing), [])
    }

    func testOneMissingFileLeavesTheOtherHalfWorking() {
        let noFollowers = EnglishWords(
            wordsURL: EnglishWords.bundledWordsURL, followersURL: nil)
        XCTAssertEqual(noFollowers.completions(for: "tomo").first, "tomorrow")
        XCTAssertEqual(noFollowers.nextWords(after: "thank"), [])
        let noWords = EnglishWords(
            wordsURL: nil, followersURL: EnglishWords.bundledFollowersURL)
        XCTAssertEqual(noWords.completions(for: "tomo"), [])
        XCTAssertEqual(noWords.nextWords(after: "thank"), ["you"])
    }

    // MARK: the bundled resource

    private let bundled = EnglishWords(
        wordsURL: EnglishWords.bundledWordsURL, followersURL: EnglishWords.bundledFollowersURL)

    func testTheBundledListLoadsAndAnswersTheCaseItExistsFor() {
        XCTAssertNotNil(EnglishWords.bundledWordsURL, "the resource didn't load")
        // The example in the file's own header: `tomo` must already offer
        // `tomorrow` rather than the far rarer `tomography`.
        XCTAssertEqual(bundled.completions(for: "tomo", limit: 5).first, "tomorrow")
        XCTAssertFalse(bundled.completions(for: "wor").isEmpty)
    }

    func testTheBundledFollowersAnswerTheCasesTheyExistFor() {
        XCTAssertNotNil(EnglishWords.bundledFollowersURL, "the resource didn't load")
        XCTAssertEqual(WordSuggestions.predictions(after: "thank ", in: bundled), ["you"])
        XCTAssertEqual(
            WordSuggestions.predictions(after: "i ", in: bundled),
            ["was", "do", "have", "am", "had"])
        XCTAssertEqual(
            WordSuggestions.predictions(after: "new ", in: bundled), ["York", "Zealand", "and"])
    }

    func testTheBundledDataSplitsTheRunTogetherPhrasesItShould() {
        XCTAssertEqual(WordSuggestions.suggestions(for: "thankyou", in: bundled).first, "thank you")
        XCTAssertEqual(WordSuggestions.suggestions(for: "Thankyou", in: bundled).first, "Thank you")
        XCTAssertEqual(WordSuggestions.suggestions(for: "THANKYOU", in: bundled).first, "THANK YOU")
        XCTAssertEqual(WordSuggestions.suggestions(for: "iam", in: bundled).first, "I am")
        // A scanning artefact the generator drops; kept, it would be a list
        // word and would never split.
        XCTAssertEqual(WordSuggestions.suggestions(for: "ofthe", in: bundled).first, "of the")
    }

    func testTheBundledDataLeavesRealWordsWhole() {
        for word in ["into", "area", "cannot", "maybe"] {
            let out = WordSuggestions.suggestions(for: word, in: bundled)
            XCTAssertEqual(out.first, word)
            XCTAssertFalse(out.contains { $0.contains(" ") }, "\(word) was split: \(out)")
        }
    }

    func testWarmingOffTheMainThreadYieldsTheSameTable() {
        // Reading and sorting 40,000 words must not land on the first letter
        // the user types, so the pane warms a beat earlier and idle. What comes
        // back has to be the same table a keystroke would have built itself.
        let warmed = EnglishWords(
            wordsURL: EnglishWords.bundledWordsURL,
            followersURL: EnglishWords.bundledFollowersURL)
        XCTAssertFalse(warmed.isWarm)
        warmed.warm()
        let landed = expectation(description: "warm lands on the main queue")
        func poll() {
            if warmed.isWarm { return landed.fulfill() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.02, execute: poll)
        }
        poll()
        wait(for: [landed], timeout: 5)
        XCTAssertEqual(warmed.completions(for: "tomo"), bundled.completions(for: "tomo"))
        XCTAssertEqual(warmed.completions(for: "wor"), bundled.completions(for: "wor"))
        XCTAssertEqual(warmed.completions(for: "tomo").first, "tomorrow")
        XCTAssertEqual(warmed.nextWords(after: "thank"), ["you"])
    }
}

/// The text rules around the bar. Pure functions over strings, which is the
/// point of them existing outside the keyboard extension at all.
final class WordSuggestionsTests: XCTestCase {
    func testThePartialWordIsTheRunOfLettersBeforeTheCursor() {
        XCTAssertEqual(WordSuggestions.partialWord(before: "hello wor"), "wor")
        XCTAssertEqual(WordSuggestions.partialWord(before: "wor"), "wor")
        XCTAssertEqual(WordSuggestions.partialWord(before: "it's do"), "do")
    }

    func testThereIsNoPartialWordWhereAWordIsNotBeingTyped() {
        XCTAssertEqual(WordSuggestions.partialWord(before: "hello "), "")
        XCTAssertEqual(WordSuggestions.partialWord(before: "hello,"), "")
        XCTAssertEqual(WordSuggestions.partialWord(before: ""), "")
        XCTAssertEqual(WordSuggestions.partialWord(before: nil), "")
    }

    func testApostrophesAndNonAsciiLettersAreStillTheSameWord() {
        // Unicode's answer rather than ASCII's: clipping café at the é would
        // ask the list about caf.
        XCTAssertEqual(WordSuggestions.partialWord(before: "café"), "café")
        XCTAssertEqual(WordSuggestions.partialWord(before: "don't"), "don't")
    }

    func testCaseFollowsWhatTheShiftKeyAlreadySaid() {
        XCTAssertEqual(WordSuggestions.matchingCase(of: "tomorrow", like: "tomo"), "tomorrow")
        XCTAssertEqual(WordSuggestions.matchingCase(of: "tomorrow", like: "Tomo"), "Tomorrow")
        XCTAssertEqual(WordSuggestions.matchingCase(of: "tomorrow", like: "TOM"), "TOMORROW")
        // One uppercase letter is a sentence starting, not caps lock — the far
        // commoner reading, and the only one a single letter can support.
        XCTAssertEqual(WordSuggestions.matchingCase(of: "tomorrow", like: "T"), "Tomorrow")
        // A word that carries case of its own is left alone by a lowercase
        // partial, which is what lets `kub` offer `Kubernetes`.
        XCTAssertEqual(WordSuggestions.matchingCase(of: "Kubernetes", like: "kub"), "Kubernetes")
    }

    func testThePronounIIsAlwaysCapitalised() {
        XCTAssertEqual(WordSuggestions.matchingCase(of: "i", like: "i"), "I")
        XCTAssertEqual(WordSuggestions.matchingCase(of: "i am", like: "iam"), "I am")
        XCTAssertEqual(WordSuggestions.matchingCase(of: "i'm", like: "i"), "I'm")
        XCTAssertEqual(WordSuggestions.matchingCase(of: "i\u{2019}ll", like: "i"), "I\u{2019}ll")
        XCTAssertEqual(WordSuggestions.matchingCase(of: "so i am", like: "soia"), "so I am")
        XCTAssertEqual(WordSuggestions.matchingCase(of: "in", like: "i"), "in")
        XCTAssertEqual(WordSuggestions.matchingCase(of: "it's", like: "i"), "it's")
    }

    // MARK: the bar itself

    private let fixture = EnglishWords(words: ["to", "tomorrow", "today", "tomato"])

    func testTheLexiconIsOfferedAheadOfTheWordList() {
        // It is the one source that knows the names and jargon this particular
        // person types, and there are only ever a handful of them.
        XCTAssertEqual(
            WordSuggestions.suggestions(
                for: "tomo", in: fixture, lexiconTerms: ["Tomohiro"]),
            ["Tomohiro", "tomorrow"])
    }

    func testATermInBothSourcesIsOfferedOnce() {
        let out = WordSuggestions.suggestions(
            for: "tomo", in: fixture, lexiconTerms: ["Tomorrow"])
        XCTAssertEqual(out, ["Tomorrow"], "the list's own tomorrow came back too")
    }

    func testAnEmptyLexiconStillSuggests() {
        // The no-Full-Access path: the App Group is unreadable, so there is no
        // lexicon at all, and App Review judges the pane in exactly that state.
        XCTAssertEqual(WordSuggestions.suggestions(for: "tomo", in: fixture), ["tomorrow"])
        XCTAssertEqual(
            WordSuggestions.suggestions(for: "to", in: fixture, lexiconTerms: []),
            ["to", "tomorrow", "today", "tomato"])
    }

    func testWhatComesBackIsCasedLikeWhatWasTyped() {
        XCTAssertEqual(
            WordSuggestions.suggestions(for: "Tomo", in: fixture, lexiconTerms: []),
            ["Tomorrow"])
        XCTAssertEqual(
            WordSuggestions.suggestions(for: "TOM", in: fixture, lexiconTerms: ["tomohiro"]),
            ["TOMOHIRO", "TOMORROW", "TOMATO"])
    }

    func testNothingIsSuggestedForNothingTyped() {
        XCTAssertEqual(
            WordSuggestions.suggestions(for: "", in: fixture, lexiconTerms: ["Tomohiro"]), [])
    }

    // MARK: missing spaces

    private let pairs = EnglishWords(
        words: ["thank", "you", "is", "a", "isabel"],
        followers: ["thank": ["you"], "is": ["a"]])

    func testTwoWordsRunTogetherAreOfferedWithTheSpace() {
        XCTAssertEqual(WordSuggestions.suggestions(for: "thankyou", in: pairs), ["thank you"])
        XCTAssertEqual(WordSuggestions.suggestions(for: "Thankyou", in: pairs), ["Thank you"])
    }

    func testTheLexiconStillComesAheadOfASplit() {
        XCTAssertEqual(
            WordSuggestions.suggestions(
                for: "thankyou", in: pairs, lexiconTerms: ["ThankYouNote"]),
            ["ThankYouNote", "thank you"])
    }

    func testAKnownPairComesAheadOfTheCompletions() {
        XCTAssertEqual(WordSuggestions.suggestions(for: "isa", in: pairs), ["is a", "isabel"])
    }

    func testAnUnknownPairIsOfferedOnlyWhenNothingCompletesThePartial() {
        let words = EnglishWords(words: ["so", "something", "meth", "meeting", "tomorrow"])
        // `someth` is one letter short of `something`, not `so meth`.
        XCTAssertEqual(WordSuggestions.suggestions(for: "someth", in: words), ["something"])
        XCTAssertEqual(
            WordSuggestions.suggestions(for: "meetingtomorrow", in: words), ["meeting tomorrow"])
        // The same run with `is a` unknown: the completion is all there is.
        let unpaired = EnglishWords(words: ["is", "a", "isabel"])
        XCTAssertEqual(WordSuggestions.suggestions(for: "isa", in: unpaired), ["isabel"])
    }

    func testAPartialThatIsItselfAWordIsNeverSplit() {
        let words = EnglishWords(
            words: ["in", "to", "into"], followers: ["in": ["to"]])
        XCTAssertEqual(WordSuggestions.suggestions(for: "into", in: words), ["into"])
    }

    func testTheMostCommonKnownPairWins() {
        // `a tea` and `ate a` are both known; the rarer half of `ate a` is
        // `ate` at rank 2, which beats `tea` at rank 4.
        let words = EnglishWords(
            words: ["a", "the", "ate", "at", "tea"],
            followers: ["a": ["tea"], "ate": ["a"]])
        XCTAssertEqual(WordSuggestions.split("atea", in: words), "ate a")
    }

    // MARK: next-word predictions

    private let followers = EnglishWords(
        words: [], followers: ["thank": ["you"], "new": ["York", "and"]])

    func testAWordAndASpaceOfferWhatFollowsIt() {
        XCTAssertEqual(WordSuggestions.predictions(after: "thank ", in: followers), ["you"])
        XCTAssertEqual(
            WordSuggestions.predictions(after: "I said thank ", in: followers), ["you"])
        XCTAssertEqual(WordSuggestions.predictions(after: "new ", in: followers), ["York", "and"])
        XCTAssertEqual(
            WordSuggestions.predictions(after: "new ", in: followers, limit: 1), ["York"])
    }

    func testPredictionsKeepTheDataCaseUnlessTheWordWasAllCaps() {
        XCTAssertEqual(WordSuggestions.predictions(after: "Thank ", in: followers), ["you"])
        XCTAssertEqual(WordSuggestions.predictions(after: "THANK ", in: followers), ["YOU"])
        XCTAssertEqual(WordSuggestions.predictions(after: "NEW ", in: followers), ["YORK", "AND"])
    }

    func testNothingIsPredictedOnceTheSentenceHasMovedOn() {
        XCTAssertEqual(WordSuggestions.predictions(after: "thank", in: followers), [])
        XCTAssertEqual(WordSuggestions.predictions(after: "thank  ", in: followers), [])
        XCTAssertEqual(WordSuggestions.predictions(after: "thank. ", in: followers), [])
        XCTAssertEqual(WordSuggestions.predictions(after: "thank\n", in: followers), [])
        XCTAssertEqual(WordSuggestions.predictions(after: " ", in: followers), [])
        XCTAssertEqual(WordSuggestions.predictions(after: "", in: followers), [])
        XCTAssertEqual(WordSuggestions.predictions(after: nil, in: followers), [])
        XCTAssertEqual(WordSuggestions.predictions(after: "old ", in: followers), [])
    }
}
