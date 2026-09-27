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
        // "Every word in the language" is not a suggestion; the strip goes back
        // to the wordmark instead.
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

    func testAMissingResourceIsSilentRatherThanFatal() {
        // A keyboard extension that crashed because a file moved would be far
        // worse than one that stops suggesting.
        let missing = EnglishWords(url: nil)
        XCTAssertEqual(missing.completions(for: "to"), [])
        XCTAssertEqual(missing.completions(for: "a"), [])
    }

    // MARK: the bundled resource

    func testTheBundledListLoadsAndAnswersTheCaseItExistsFor() {
        XCTAssertNotNil(EnglishWords.bundledURL, "the resource didn't load")
        let words = EnglishWords(url: EnglishWords.bundledURL)
        // The example in the file's own header: `tomo` must already offer
        // `tomorrow` rather than the far rarer `tomography`.
        XCTAssertEqual(words.completions(for: "tomo", limit: 5).first, "tomorrow")
        XCTAssertFalse(words.completions(for: "wor").isEmpty)
    }

    func testWarmingOffTheMainThreadYieldsTheSameTable() {
        // Reading and sorting 40,000 words must not land on the first letter
        // the user types, so the pane warms a beat earlier and idle. What comes
        // back has to be the same table a keystroke would have built itself.
        let cold = EnglishWords(url: EnglishWords.bundledURL)
        let warmed = EnglishWords(url: EnglishWords.bundledURL)
        XCTAssertFalse(warmed.isWarm)
        warmed.warm()
        let landed = expectation(description: "warm lands on the main queue")
        func poll() {
            if warmed.isWarm { return landed.fulfill() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.02, execute: poll)
        }
        poll()
        wait(for: [landed], timeout: 5)
        XCTAssertEqual(warmed.completions(for: "tomo"), cold.completions(for: "tomo"))
        XCTAssertEqual(warmed.completions(for: "wor"), cold.completions(for: "wor"))
    }

    func testALookupThatBeatsTheWarmAnswersNothingAndReadsNothing() {
        // Reading a second copy beside the one being built is exactly the
        // memory spike the warm exists to avoid; the letter that loses the race
        // gets a blank bar and the completion fills it in.
        let words = EnglishWords(url: EnglishWords.bundledURL)
        let landed = expectation(description: "the warm's completion runs")
        words.warm { landed.fulfill() }
        XCTAssertEqual(words.completions(for: "tomo"), [])
        XCTAssertEqual(words.parseCount, 1)
        wait(for: [landed], timeout: 5)
        XCTAssertEqual(words.completions(for: "tomo").first, "tomorrow")
        XCTAssertEqual(words.parseCount, 1)

        var immediately = false
        words.warm { immediately = true }
        XCTAssertTrue(immediately, "already warm: no trip through the queue")
    }

    func testUnloadDropsTheListAndTheNextLookupReadsItAgain() {
        let words = EnglishWords(url: EnglishWords.bundledURL)
        XCTAssertEqual(words.completions(for: "tomo").first, "tomorrow")
        words.unload()
        XCTAssertFalse(words.isWarm)
        XCTAssertEqual(words.completions(for: "tomo").first, "tomorrow")
        XCTAssertEqual(words.parseCount, 2)

        let fixture = EnglishWords(words: ["the", "tomorrow"])
        fixture.unload()
        XCTAssertEqual(fixture.completions(for: "to"), ["tomorrow"], "nothing to reload from")
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
}
