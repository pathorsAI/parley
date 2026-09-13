import XCTest

@testable import ParleyKit

/// The rules that stand between a model's answer and the user's library. The
/// recording already has a name and a home, so every gate here is free to be
/// strict: a dropped suggestion costs nothing, and a bad one accepted costs a
/// renamed recording in the wrong folder.
final class FilingSuggesterTests: XCTestCase {

    private func folder(_ id: String, _ name: String, orgId: String? = nil) -> CloudFolder {
        CloudFolder(id: id, name: name, orgId: orgId, createdAt: 0, updatedAt: 0)
    }

    private lazy var folders: [CloudFolder] = [
        folder("f-acme", "Acme Corp"),
        folder("f-hiring", "Hiring"),
        folder("f-board", "Board"),
        folder("f-ops", "Ops"),
    ]

    /// Shorthand for one raw pick off the model.
    private func pick(_ name: String, _ isNew: Bool = false, _ reason: String = "fits")
        -> FilingSuggester.RawFolder
    {
        FilingSuggester.RawFolder(name: name, isNew: isNew, reason: reason)
    }

    private func suggestion(_ id: String?, _ name: String, _ reason: String)
        -> FilingFolderSuggestion
    {
        FilingFolderSuggestion(folderId: id, name: name, reason: reason)
    }

    // MARK: resolveFolders

    func testMatchesAnExistingFolderByExactName() {
        XCTAssertEqual(
            FilingSuggester.resolveFolders([pick("Acme Corp")], folders: folders),
            [suggestion("f-acme", "Acme Corp", "fits")])
    }

    func testMatchesCaseAndWhitespaceInsensitivelyKeepingTheRegistrySpelling() {
        XCTAssertEqual(
            FilingSuggester.resolveFolders([pick("  acme CORP ")], folders: folders),
            [suggestion("f-acme", "Acme Corp", "fits")])
    }

    func testTreatsANameMatchingNothingAsANewFolder() {
        XCTAssertEqual(
            FilingSuggester.resolveFolders([pick("Globex")], folders: folders),
            [suggestion(nil, "Globex", "fits")])
    }

    func testResolvesToTheExistingFolderEvenWhenTheModelClaimsItIsNew() {
        XCTAssertEqual(
            FilingSuggester.resolveFolders([pick("Hiring", true)], folders: folders),
            [suggestion("f-hiring", "Hiring", "fits")])
    }

    func testKeepsOnlyTheFirstNewFolderSuggestion() {
        XCTAssertEqual(
            FilingSuggester.resolveFolders(
                [pick("Globex", true), pick("Initech", true), pick("Acme Corp")],
                folders: folders),
            [suggestion(nil, "Globex", "fits"), suggestion("f-acme", "Acme Corp", "fits")])
    }

    func testCollapsesDuplicateFolderIdsToOneEntry() {
        XCTAssertEqual(
            FilingSuggester.resolveFolders(
                [
                    pick("Acme Corp", false, "customer"), pick("acme corp", true, "same again"),
                    pick("Ops"),
                ], folders: folders),
            [suggestion("f-acme", "Acme Corp", "customer"), suggestion("f-ops", "Ops", "fits")])
    }

    func testCapsAtThreeEntriesPreservingTheModelsOrder() {
        let out = FilingSuggester.resolveFolders(
            [pick("Acme Corp"), pick("Hiring"), pick("Board"), pick("Ops")], folders: folders)
        XCTAssertEqual(out.map(\.folderId), ["f-acme", "f-hiring", "f-board"])
    }

    func testDropsEmptyAndWhitespaceOnlyNames() {
        XCTAssertEqual(
            FilingSuggester.resolveFolders(
                [pick(""), pick("   "), pick("Board")], folders: folders),
            [suggestion("f-board", "Board", "fits")])
    }

    func testTrimsTheReasonAndAllowsAnEmptyOne() {
        XCTAssertEqual(
            FilingSuggester.resolveFolders(
                [pick("Board", false, "  ongoing governance  ")], folders: folders),
            [suggestion("f-board", "Board", "ongoing governance")])
        XCTAssertEqual(
            FilingSuggester.resolveFolders([pick("Board", false, "   ")], folders: folders),
            [suggestion("f-board", "Board", "")])
    }

    func testReturnsAnEmptyArrayForEmptyInput() {
        XCTAssertEqual(FilingSuggester.resolveFolders([], folders: folders), [])
        XCTAssertEqual(FilingSuggester.resolveFolders([], folders: []), [])
    }

    /// An org's shared folders belong to a workspace, not to the personal
    /// library this pass files into — offering one produces a suggestion the
    /// user cannot accept. The name is not "taken" by the org folder either: it
    /// falls through to the new-folder path like any other unknown name.
    func testOrgFoldersAreNeverOfferedAsFilingTargets() {
        let mixed = folders + [folder("f-shared", "Sales", orgId: "org-1")]
        XCTAssertEqual(
            FilingSuggester.resolveFolders([pick("Sales")], folders: mixed),
            [suggestion(nil, "Sales", "fits")])
    }

    /// Two folders sharing a name resolve to the first the registry lists, so
    /// the suggestion is at least stable rather than dependent on hash order.
    func testFirstOccurrenceWinsWhenTwoFoldersShareAName() {
        let dupes = [folder("f-old", "Acme Corp"), folder("f-new", "acme corp")]
        XCTAssertEqual(
            FilingSuggester.resolveFolders([pick("ACME CORP")], folders: dupes),
            [suggestion("f-old", "Acme Corp", "fits")])
    }

    // MARK: the folder menu

    func testTheMenuListsPersonalFoldersOnly() {
        let menu = FilingSuggester.folderMenu(folders + [folder("f-s", "Sales", orgId: "org-1")])
        XCTAssertTrue(menu.contains("- Acme Corp"))
        XCTAssertFalse(menu.contains("Sales"))
    }

    /// With nothing to file into, "prefer an existing folder" is unanswerable —
    /// the model has to be told to propose one, or it invents three.
    func testAnEmptyRegistryAsksForExactlyOneNewFolder() {
        let menu = FilingSuggester.folderMenu([])
        XCTAssertTrue(menu.contains("NO folders yet"))
        XCTAssertTrue(menu.contains("isNew: true"))
    }

    // MARK: parsing what came back

    func testParsesAPlainJSONObject() {
        let parsed = FilingSuggester.parse(
            #"{"title":"Acme renewal terms","folders":[{"name":"Acme Corp","isNew":false,"reason":"the customer"}]}"#
        )
        XCTAssertEqual(parsed?.title, "Acme renewal terms")
        XCTAssertEqual(parsed?.folders.count, 1)
        XCTAssertEqual(parsed?.folders.first?.name, "Acme Corp")
    }

    func testParsesJSONInsideCodeFences() {
        let parsed = FilingSuggester.parse(
            """
            ```json
            {"title": "Board Q3 budget", "folders": [{"name": "Board", "isNew": false, "reason": "governance"}]}
            ```
            """)
        XCTAssertEqual(parsed?.title, "Board Q3 budget")
        XCTAssertEqual(parsed?.folders.first?.reason, "governance")
    }

    func testParsesJSONAfterAPreamble() {
        let parsed = FilingSuggester.parse(
            "Sure! Here is the suggestion:\n{\"title\":\"Hiring loop debrief\",\"folders\":[]}")
        XCTAssertEqual(parsed?.title, "Hiring loop debrief")
        XCTAssertEqual(parsed?.folders.count, 0)
    }

    /// A brace inside a `reason` must not end the object early — reasons are
    /// free text written by a model.
    func testABraceInsideAStringDoesNotEndTheObject() {
        let parsed = FilingSuggester.parse(
            #"{"title":"Ops handover","folders":[{"name":"Ops","isNew":false,"reason":"the {ops} rota"}]}"#
        )
        XCTAssertEqual(parsed?.folders.first?.reason, "the {ops} rota")
    }

    func testMalformedAnswersParseToNil() {
        XCTAssertNil(FilingSuggester.parse("I'm sorry, I can't help with that."))
        XCTAssertNil(FilingSuggester.parse(""))
        XCTAssertNil(
            FilingSuggester.parse("{\"title\": \"truncated mid-answer\", \"folders\": ["),
            "an unbalanced object is a truncated answer, not a suggestion")
    }

    /// A row missing `isNew` or `reason` still names a folder; losing the whole
    /// suggestion over a missing boolean would be a poor trade.
    func testMissingFieldsFallBackRatherThanFailingTheParse() {
        let parsed = FilingSuggester.parse(#"{"folders":[{"name":"Board"}]}"#)
        XCTAssertEqual(parsed?.title, "")
        XCTAssertEqual(parsed?.folders.first?.name, "Board")
        XCTAssertEqual(parsed?.folders.first?.isNew, false)
        XCTAssertEqual(parsed?.folders.first?.reason, "")
    }

    // MARK: the title gate

    func testAcceptsAPlausibleTitle() {
        XCTAssertTrue(
            FilingSuggester.acceptTitle(
                "Acme renewal terms", currentTitle: "Meeting Sep 7, 3:20 PM",
                transcript: "[0:00] [Speaker 1] Let's start with the renewal."))
    }

    func testRejectsAnEmptyTitle() {
        XCTAssertFalse(FilingSuggester.acceptTitle("", currentTitle: "x", transcript: "y"))
        XCTAssertFalse(FilingSuggester.acceptTitle("  \n ", currentTitle: "x", transcript: "y"))
    }

    /// The shape of a model that answered with the meeting's summary where a
    /// label was asked for. The library shows one line.
    func testRejectsATitleLongerThanEightyCharacters() {
        let sentence = String(repeating: "a", count: 81)
        XCTAssertFalse(
            FilingSuggester.acceptTitle(sentence, currentTitle: "x", transcript: "y"))
        XCTAssertTrue(
            FilingSuggester.acceptTitle(
                String(repeating: "a", count: 80), currentTitle: "x", transcript: "y"),
            "the cap is loose enough to let a long but honest title through")
    }

    func testRejectsSimplifiedDrift() {
        XCTAssertFalse(
            FilingSuggester.acceptTitle(
                "报价讨论", currentTitle: "即時會議",
                transcript: "[0:00] [Speaker 1] 我們來討論報價的部分。"),
            "Traditional in, Simplified out is the failure that looks like success")
    }

    func testASimplifiedMeetingKeepsItsOwnScript() {
        XCTAssertTrue(
            FilingSuggester.acceptTitle(
                "报价讨论", currentTitle: "即时会议",
                transcript: "[0:00] [Speaker 1] 我们来讨论报价的部分。"),
            "the guard is about drift, not about preferring one script")
        XCTAssertTrue(
            FilingSuggester.acceptTitle(
                "报价讨论", currentTitle: "即時會議",
                transcript: "[0:00] [Speaker 1] 我们来讨论报价的部分。"),
            "the transcript alone is enough to establish the script")
    }

    // MARK: the transcript we send

    private func segment(
        _ id: String, _ text: String, speaker: Int = 1, startMs: UInt64 = 0, isFinal: Bool = true
    ) -> TranscriptSegment {
        TranscriptSegment(
            id: id, source: "mix", speaker: speaker, text: text, isFinal: isFinal,
            startMs: startMs, endMs: startMs + 1000)
    }

    func testRendersFinalSegmentsOldestFirstWithClockAndSpeaker() {
        let rendered = FilingSuggester.transcript(
            [
                segment("b", "Second thing.", speaker: 2, startMs: 72_000),
                segment("a", "  First thing.  ", speaker: 1, startMs: 5_000),
                segment("t", "tentative tail", startMs: 90_000, isFinal: false),
                segment("blank", "   ", startMs: 95_000),
            ],
            speakerNames: ["mix-2": "Mei"])
        // Unnamed speakers are letters, the same label the transcript screens
        // render (`speakerLetter`); a name still wins over the letter.
        XCTAssertEqual(
            rendered,
            """
            [0:05] [Speaker A] First thing.
            [1:12] [Mei] Second thing.
            """)
    }

    func testAnEmptyTranscriptRendersAsNothing() {
        XCTAssertEqual(FilingSuggester.transcript([], speakerNames: [:]), "")
        XCTAssertEqual(
            FilingSuggester.transcript(
                [segment("t", "tail", isFinal: false)], speakerNames: [:]), "")
    }

    /// A long meeting is sent as its two ends: the opening says what this is and
    /// who is in it, the close carries the decision. The middle is what a title
    /// can most afford to lose, and it must be visibly gone rather than look
    /// like the meeting stopped mid-sentence.
    func testALongTranscriptKeepsItsHeadAndTail() {
        let long = String(repeating: "x", count: 20_000) + "MIDDLE"
            + String(repeating: "y", count: 20_000) + "THE DECISION"
        let capped = FilingSuggester.capped(long)

        XCTAssertLessThanOrEqual(
            capped.count,
            FilingSuggester.maximumTranscriptCharacters + FilingSuggester.elisionMarker.count)
        XCTAssertTrue(capped.hasPrefix("xxx"))
        XCTAssertTrue(capped.hasSuffix("THE DECISION"))
        XCTAssertTrue(capped.contains(FilingSuggester.elisionMarker))
        XCTAssertFalse(capped.contains("MIDDLE"))
    }

    func testAShortTranscriptIsSentWhole() {
        let short = "[0:00] [Speaker 1] Short and complete."
        XCTAssertEqual(FilingSuggester.capped(short), short)
    }

    // MARK: the prompt and the request

    /// The desktop and the phone file the same person's recordings into the same
    /// registry, so the rules travel verbatim. If a rule is dropped here the two
    /// platforms start disagreeing about where a meeting belongs, with no test
    /// failing anywhere else.
    func testThePromptCarriesTheDesktopsFilingRules() {
        let prompt = FilingSuggester.systemPrompt
        XCTAssertTrue(prompt.contains("No date and no time."))
        XCTAssertTrue(prompt.contains("Copy an existing folder's name EXACTLY"))
        XCTAssertTrue(prompt.contains("AT MOST ONE candidate"))
        XCTAssertTrue(prompt.contains("2-3 candidates ordered best-first"))
    }

    func testThePromptAsksForJSONInWords() {
        let prompt = FilingSuggester.systemPrompt
        XCTAssertTrue(prompt.contains("\"isNew\": boolean"))
        XCTAssertTrue(prompt.contains("no code fences"))
    }

    func testTheUserMessageNamesTheCurrentTitleTheMenuAndTheTranscript() {
        let message = FilingSuggester.userMessage(
            currentTitle: "  Meeting Sep 7, 3:20 PM  ", folders: folders,
            transcript: "[0:00] [Speaker 1] Hello.")
        XCTAssertTrue(message.contains("currently called: Meeting Sep 7, 3:20 PM"))
        XCTAssertTrue(message.contains("- Hiring"))
        XCTAssertTrue(message.hasSuffix("Transcript:\n[0:00] [Speaker 1] Hello."))
    }

    /// An untitled recording must not send an empty line the model reads as "the
    /// title is blank on purpose".
    func testABlankCurrentTitleIsSpelledOut() {
        XCTAssertTrue(
            FilingSuggester.userMessage(currentTitle: "   ", folders: [], transcript: "x")
                .contains("currently called: (untitled)"))
    }

    func testTheRequestUsesTheFastModelAndNoResponseFormat() throws {
        let body = try JSONEncoder().encode(
            CloudChat.Request(
                model: FilingSuggester.model, temperature: 0.2, maxTokens: 512,
                messages: [
                    .init(role: "system", content: FilingSuggester.systemPrompt),
                    .init(role: "user", content: "…"),
                ]))
        let obj = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(obj["model"] as? String, "parley-fast")
        XCTAssertEqual(obj["max_tokens"] as? Int, 512, "snake_case, as the OpenAI shape wants")
        XCTAssertNil(
            obj["response_format"],
            "unverified against the worker; a rejected request costs the whole pass")
    }

    // MARK: the flag the desktop reads

    func testFilingSuggestedRoundTripsThroughTheRawMeta() {
        var meta = RecordingMeta(raw: ["id": "r-1", "title": "Meeting Sep 7, 3:20 PM"])
        XCTAssertFalse(meta.filingSuggested, "absent means the pass has not run")

        meta.title = "Acme renewal terms"
        meta.filingSuggested = true
        XCTAssertEqual(meta.raw["title"] as? String, "Acme renewal terms")
        XCTAssertEqual(meta.raw["filingSuggested"] as? Bool, true)
        XCTAssertEqual(meta.title, "Acme renewal terms")
        XCTAssertTrue(meta.filingSuggested)
    }
}
