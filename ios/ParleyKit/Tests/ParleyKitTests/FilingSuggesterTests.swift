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

    /// The gate is per character, from the shared list: 说 is let through only
    /// when the transcript as sent already has 说 — another Simplified
    /// character elsewhere in the meeting does not vouch for it — while 台 and
    /// 后, which Traditional text uses too, are never grounds for rejection.
    func testSimplifiedIsJudgedPerCharacterFromTheSharedList() {
        XCTAssertTrue(FilingPrompt.simplifiedOnlyChars.contains("说"))
        XCTAssertFalse(FilingPrompt.simplifiedOnlyChars.contains("台"))
        XCTAssertFalse(FilingPrompt.simplifiedOnlyChars.contains("后"))

        XCTAssertFalse(
            FilingSuggester.acceptTitle(
                "客户说明会", currentTitle: "會議 9/7", transcript: "[0:00] [Speaker A] 我們來談報價。"))
        XCTAssertFalse(
            FilingSuggester.acceptTitle(
                "客户说明会", currentTitle: "會議 9/7", transcript: "[0:00] [Speaker A] 时间到了。"),
            "a different Simplified character in the transcript does not vouch for 说")
        XCTAssertTrue(
            FilingSuggester.acceptTitle(
                "说明", currentTitle: "會議 9/7", transcript: "[0:00] [Speaker A] 我来说一下。"))
        XCTAssertTrue(
            FilingSuggester.acceptTitle(
                "说明", currentTitle: "说明会 草稿", transcript: "[0:00] [Speaker A] 我們開始。"),
            "the current title counts as well")

        XCTAssertTrue(
            FilingSuggester.acceptTitle(
                "台北後續 台灣 之后", currentTitle: "會議 9/7",
                transcript: "[0:00] [Speaker A] 我們開始。"))
    }

    /// The model returning the name the recording already has is it following
    /// the "return it UNCHANGED" rule. There is nothing to offer, so the title
    /// half resolves to "" rather than a card proposing a no-op rename.
    func testRejectsATitleEqualToTheCurrentOne() {
        XCTAssertFalse(
            FilingSuggester.acceptTitle(
                "Acme renewal terms", currentTitle: " Acme renewal terms ", transcript: "y"))
        XCTAssertFalse(
            FilingSuggester.acceptTitle(
                "  Acme renewal terms\n", currentTitle: "Acme renewal terms", transcript: "y"))
    }

    /// The length cap is in code points too, so an 80-character CJK title
    /// passes and 81 does not, on every platform alike.
    func testTheTitleCapCountsCodePoints() {
        XCTAssertEqual(FilingPrompt.maxTitleCharacters, 80)
        XCTAssertTrue(
            FilingSuggester.acceptTitle(
                String(repeating: "會", count: 80), currentTitle: "x", transcript: "會"))
        XCTAssertFalse(
            FilingSuggester.acceptTitle(
                String(repeating: "會", count: 81), currentTitle: "x", transcript: "會"))
        // 12 family emoji: 12 graphemes, 84 code points.
        XCTAssertFalse(
            FilingSuggester.acceptTitle(
                String(repeating: "👨‍👩‍👧‍👦", count: 12), currentTitle: "x", transcript: "y"))
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

        XCTAssertEqual(
            capped.unicodeScalars.count,
            FilingPrompt.maxTranscriptCharacters + FilingPrompt.elisionMarker.unicodeScalars.count)
        XCTAssertTrue(capped.hasPrefix("xxx"))
        XCTAssertTrue(capped.hasSuffix("THE DECISION"))
        XCTAssertTrue(capped.contains(FilingPrompt.elisionMarker))
        XCTAssertFalse(capped.contains("MIDDLE"))
    }

    /// The cap counts Unicode code points, not grapheme clusters — what the
    /// desktop (`Array.from`) and Android (`codePointCount`) count — so all
    /// three cut a transcript at the same place. A family emoji is one
    /// grapheme and seven code points; counting graphemes would let seven
    /// times as much of it through.
    func testTheCapCountsCodePointsAndSplitsTwoThirdsToTheHead() {
        let family = "👨‍👩‍👧‍👦"
        XCTAssertEqual(family.count, 1)
        XCTAssertEqual(family.unicodeScalars.count, 7)

        let max = FilingPrompt.maxTranscriptCharacters
        let headCount = max * FilingPrompt.headShareNumerator / FilingPrompt.headShareDenominator
        XCTAssertEqual(headCount, 16_000)
        let tailCount = max - headCount

        // 4_000 families = 28_000 code points but only 4_000 graphemes.
        let long = String(repeating: family, count: 4_000)
        let capped = FilingSuggester.capped(long)
        XCTAssertNotEqual(capped, long, "over the limit in code points, though not in graphemes")
        let parts = capped.components(separatedBy: FilingPrompt.elisionMarker)
        XCTAssertEqual(parts.count, 2)
        XCTAssertEqual(parts[0].unicodeScalars.count, headCount)
        XCTAssertEqual(parts[1].unicodeScalars.count, tailCount)

        // Exactly at the limit is sent whole.
        let cjk = String(repeating: "會", count: max)
        XCTAssertEqual(FilingSuggester.capped(cjk), cjk)
        XCTAssertNotEqual(FilingSuggester.capped(cjk + "議"), cjk + "議")
    }

    func testAShortTranscriptIsSentWhole() {
        let short = "[0:00] [Speaker 1] Short and complete."
        XCTAssertEqual(FilingSuggester.capped(short), short)
    }

    // MARK: the prompt and the request

    /// Every piece of the system message comes out of the shared prompt
    /// (`shared/prompts/filing.json` → `FilingPrompt`), in the one order all
    /// three platforms use: rules, language, JSON shape.
    func testTheSystemPromptIsTheSharedRulesThenLanguageThenJSON() {
        XCTAssertEqual(
            FilingSuggester.systemPrompt(language: .traditionalChinese),
            FilingPrompt.rules + FilingPrompt.languageInstructionZhTW + FilingPrompt.jsonInstruction)
        XCTAssertEqual(
            FilingSuggester.systemPrompt(language: .english),
            FilingPrompt.rules + FilingPrompt.languageInstructionEn + FilingPrompt.jsonInstruction)
    }

    func testThePromptCarriesTheSharedFilingRules() {
        let prompt = FilingSuggester.systemPrompt(language: .english)
        XCTAssertTrue(prompt.contains("No date and no time."))
        XCTAssertTrue(prompt.contains("Copy an existing folder's name EXACTLY"))
        XCTAssertTrue(prompt.contains("AT MOST ONE candidate"))
        XCTAssertTrue(prompt.contains("\"isNew\": boolean"))
        XCTAssertTrue(prompt.contains("no code fences"))
    }

    /// The title follows the app's UI language, resolved the way the rest of
    /// the app resolves it: any `zh` localization is Traditional Chinese.
    func testTheLanguageFollowsTheUILocalization() {
        XCTAssertEqual(FilingSuggester.Language(localization: "zh-Hant"), .traditionalChinese)
        XCTAssertEqual(FilingSuggester.Language(localization: "zh-Hant-TW"), .traditionalChinese)
        XCTAssertEqual(FilingSuggester.Language(localization: "zh-TW"), .traditionalChinese)
        XCTAssertEqual(FilingSuggester.Language(localization: "en"), .english)
        XCTAssertEqual(FilingSuggester.Language(localization: "ja"), .english)
    }

    /// The user message, byte for byte: context, current title, folder menu,
    /// transcript — the order the desktop and Android send.
    func testTheUserMessageWithMeetingContext() {
        let message = FilingSuggester.userMessage(
            meetingContext: "  Renewal call with Acme  ",
            currentTitle: "  Meeting Sep 7, 3:20 PM  ",
            folders: [folder("f-acme", " Acme Corp "), folder("f-blank", "   "),
                folder("f-s", "Sales", orgId: "org-1"), folder("f-ops", "Ops")],
            transcript: "[0:00] [Speaker A] Hello.")
        XCTAssertEqual(
            message,
            FilingPrompt.meetingContextPrefix + "Renewal call with Acme\n\n"
                + FilingPrompt.currentTitlePrefix + "Meeting Sep 7, 3:20 PM\n\n"
                + FilingPrompt.foldersHeader + "\n- Acme Corp\n- Ops\n\n"
                + FilingPrompt.transcriptHeader + "\n[0:00] [Speaker A] Hello.")
    }

    func testTheUserMessageWithoutContextLeavesTheLineOut() {
        let message = FilingSuggester.userMessage(
            meetingContext: "   ", currentTitle: "Standup", folders: [folder("f-ops", "Ops")],
            transcript: "x")
        XCTAssertEqual(
            message,
            FilingPrompt.currentTitlePrefix + "Standup\n\n"
                + FilingPrompt.foldersHeader + "\n- Ops\n\n"
                + FilingPrompt.transcriptHeader + "\nx")
    }

    /// No folders (or only org ones, which the user cannot file into): the model
    /// is told to propose exactly one, and an untitled recording is spelled out
    /// rather than sent as an empty line.
    func testTheUserMessageWithNoFoldersAndNoTitle() {
        let message = FilingSuggester.userMessage(
            meetingContext: "", currentTitle: "   ",
            folders: [folder("f-s", "Sales", orgId: "org-1")], transcript: "x")
        XCTAssertEqual(
            message,
            FilingPrompt.currentTitlePrefix + FilingPrompt.untitled + "\n\n"
                + FilingPrompt.noFolders + "\n\n"
                + FilingPrompt.transcriptHeader + "\nx")
    }

    func testTheRequestReadsModelTemperatureAndTokensFromTheSharedPrompt() throws {
        let request = FilingSuggester.request(
            meetingContext: "", currentTitle: "t", folders: [], transcript: "x",
            language: .traditionalChinese)
        let body = try JSONEncoder().encode(request)
        let obj = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(obj["model"] as? String, FilingPrompt.model)
        XCTAssertEqual(obj["temperature"] as? Double, FilingPrompt.temperature)
        XCTAssertEqual(obj["max_tokens"] as? Int, FilingPrompt.maxTokens, "snake_case, as the OpenAI shape wants")
        XCTAssertNil(
            obj["response_format"],
            "unverified against the worker; a rejected request costs the whole pass")
        let messages = try XCTUnwrap(obj["messages"] as? [[String: Any]])
        XCTAssertEqual(messages.map { $0["role"] as? String }, ["system", "user"])
        XCTAssertEqual(
            messages[0]["content"] as? String,
            FilingSuggester.systemPrompt(language: .traditionalChinese))
        XCTAssertEqual(
            messages[1]["content"] as? String,
            FilingSuggester.userMessage(
                meetingContext: "", currentTitle: "t", folders: [], transcript: "x"))
    }

    // MARK: gating the whole answer

    func testAnUnchangedTitleIsDroppedButTheFoldersSurvive() throws {
        let payload = try XCTUnwrap(FilingSuggester.parse(
            #"{"title":" Acme renewal ","folders":[{"name":"Acme Corp","isNew":false,"reason":"customer"}]}"#))
        let gated = FilingSuggester.gate(
            payload, currentTitle: "Acme renewal", folders: folders, transcript: "x")
        XCTAssertEqual(gated?.title, "")
        XCTAssertEqual(gated?.folders.map(\.folderId), ["f-acme"])
    }

    func testNothingLeftStandingIsNoSuggestion() throws {
        let payload = try XCTUnwrap(FilingSuggester.parse(#"{"title":"Acme renewal","folders":[]}"#))
        XCTAssertNil(
            FilingSuggester.gate(payload, currentTitle: "Acme renewal", folders: folders, transcript: "x"))
    }

    // MARK: the meta the pass reads

    func testMeetingContextIsReadFromTheMeta() {
        XCTAssertEqual(
            RecordingMeta(raw: ["meetingContext": "Acme renewal"]).meetingContext, "Acme renewal")
        XCTAssertEqual(RecordingMeta(raw: [:]).meetingContext, "")
        XCTAssertEqual(RecordingMeta(raw: ["meetingContext": NSNull()]).meetingContext, "")
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
