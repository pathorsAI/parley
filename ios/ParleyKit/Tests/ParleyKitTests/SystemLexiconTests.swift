import XCTest

@testable import ParleyKit

/// The system's lexicon, sorted: contact names into recognition terms, Text
/// Replacement shortcuts into the expansions the English bar offers.
final class SystemLexiconTests: XCTestCase {
    private func entry(_ input: String, _ text: String) -> SystemLexicon.Entry {
        SystemLexicon.Entry(userInput: input, documentText: text)
    }

    // MARK: partition

    func testNamesBecomeTermsAndShortcutsBecomeReplacements() {
        let (terms, replacements) = SystemLexicon.partition([
            entry("王小明", "王小明"),
            entry("omw", "On my way!"),
            entry("Ada", "Ada"),
            entry(" Ada ", "Ada"),
            entry("", "nothing"),
            entry("addr", "1 Infinite Loop\nCupertino"),
        ])
        XCTAssertEqual(terms, ["王小明", "Ada"])
        XCTAssertEqual(replacements.count, 2)
        XCTAssertEqual(
            replacements.match(before: "see you, omw"),
            TextReplacements.Match(typed: "omw", expansion: "On my way!"))
        XCTAssertEqual(
            replacements.match(before: "addr")?.expansion, "1 Infinite Loop\nCupertino")
    }

    func testTermsAreCapped() {
        let entries = (0..<(Lexicon.maxSystemTerms + 10)).map { entry("n\($0)", "n\($0)") }
        XCTAssertEqual(SystemLexicon.partition(entries).terms.count, Lexicon.maxSystemTerms)
    }

    // MARK: matching

    private let replacements = TextReplacements([
        (shortcut: "omw", expansion: "On my way!"),
        (shortcut: "@@", expansion: "me@example.com"),
        (shortcut: "OMW", expansion: "ignored, the first one wins"),
    ])

    func testTheWordBeforeTheCursorIsMatchedCaseInsensitively() {
        XCTAssertEqual(
            replacements.match(before: "OMW"), TextReplacements.Match(typed: "OMW", expansion: "On my way!"))
        XCTAssertEqual(replacements.match(before: "ok Omw")?.typed, "Omw")
    }

    func testOnlyTheWholeWordMatches() {
        XCTAssertNil(replacements.match(before: "omwx"))
        XCTAssertNil(replacements.match(before: "xomw"))
        XCTAssertNil(replacements.match(before: "omw "), "after the space the word is finished")
        XCTAssertNil(replacements.match(before: ""))
        XCTAssertNil(replacements.match(before: nil))
    }

    func testAShortcutThatIsNotLettersMatches() {
        XCTAssertEqual(replacements.match(before: "mail @@")?.expansion, "me@example.com")
    }

    func testAShortcutAfterAnOpeningBracketStillMatches() {
        XCTAssertEqual(
            replacements.match(before: "(omw"),
            TextReplacements.Match(typed: "omw", expansion: "On my way!"))
    }

    func testNoShortcutsMatchNothing() {
        XCTAssertNil(TextReplacements.none.match(before: "omw"))
        XCTAssertTrue(TextReplacements.none.isEmpty)
    }

    // MARK: the bar

    func testTheExpansionLeadsTheBarWithoutGrowingIt() {
        let match = TextReplacements.Match(typed: "omw", expansion: "On my way!")
        XCTAssertEqual(
            TextReplacements.leading(match, before: ["a", "b", "On my way!", "c"], limit: 3),
            ["On my way!", "a", "b"])
        XCTAssertEqual(TextReplacements.leading(nil, before: ["a", "b"]), ["a", "b"])
    }
}
