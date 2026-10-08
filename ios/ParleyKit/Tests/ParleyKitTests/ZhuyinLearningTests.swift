import XCTest

@testable import ParleyKit

/// Typing helper shared by the suites below: symbols and tone marks, as keys.
private func type(_ keys: String, into composer: inout ZhuyinComposer) {
    for key in keys {
        if let tone = ZhuyinTone.mark(key) {
            _ = composer.tone(tone)
        } else {
            _ = composer.symbol(key)
        }
    }
}

/// The scores the lattice reads: written by the generators, parsed per row.
final class ZhuyinScoreTests: XCTestCase {
    func testAScoreParsesWithoutGoingThroughAString() {
        XCTAssertEqual(ZhuyinPhrases.Entry.parseScore("-3.07") ?? 0, -3.07, accuracy: 1e-6)
        XCTAssertEqual(ZhuyinPhrases.Entry.parseScore("-12.5") ?? 0, -12.5, accuracy: 1e-6)
        XCTAssertEqual(ZhuyinPhrases.Entry.parseScore("4") ?? 0, 4, accuracy: 1e-6)
        for invalid in ["", "-", "1.2.3", "--1", "x", "1-"] {
            XCTAssertNil(ZhuyinPhrases.Entry.parseScore(invalid[...]), invalid)
        }
    }

    func testTheBundledTablesCarryScores() {
        let 你好 = ZhuyinPhrases.bundled.exactCover(ZhuyinPhrasesTests.buffer("ㄋㄧˇㄏㄠˇ"))
        XCTAssertEqual(你好?.phrase, "你好")
        XCTAssertEqual(你好?.score ?? 0, -3.07, accuracy: 0.001)
        let 的 = ZhuyinDictionary.bundled.topCandidate(
            for: ZhuyinSyllable.parse("ㄉㄜ˙")!, toneless: false)
        XCTAssertEqual(的?.character, "的")
        XCTAssertEqual(的?.score ?? 0, -1.81, accuracy: 0.001)
        XCTAssertEqual(的?.errors, 0)
    }

    func testAPhraseOutscoresTheCharactersThatSpellIt() {
        // The calibration the lattice depends on: an everyday phrase is likelier
        // as itself than as the two characters that would spell it.
        let phrase = ZhuyinPhrases.bundled.exactCover(ZhuyinPhrasesTests.buffer("ㄊㄞˊㄨㄢ"))
        let 台 = ZhuyinDictionary.bundled.topCandidate(
            for: ZhuyinSyllable.parse("ㄊㄞˊ")!, toneless: false)
        let 灣 = ZhuyinDictionary.bundled.topCandidate(
            for: ZhuyinSyllable.parse("ㄨㄢ")!, toneless: false)
        XCTAssertEqual(phrase?.phrase, "台灣")
        XCTAssertGreaterThan(phrase!.score, 台!.score + 灣!.score)
    }

    func testTheExactCoverIsTheFirstExactMatchOfThatLength() {
        // Monotone within a length, so the lattice and the bar agree on which
        // phrase answers a span.
        for keys in ["ㄋㄏ", "ㄨㄛㄇㄣ", "ㄧㄢㄐㄧㄡ", "ㄊㄞㄨㄢ", "ㄕㄥㄇㄧㄥ"] {
            let buffer = ZhuyinPhrasesTests.buffer(keys)
            XCTAssertEqual(
                ZhuyinPhrases.bundled.exactCover(buffer)?.phrase,
                ZhuyinPhrases.bundled.matches(buffer, fuzzy: false)
                    .first { $0.span == buffer.count }?.phrase, keys)
        }
    }
}

/// The lattice: the likeliest segmentation of the whole buffer, not the
/// longest phrase first.
final class ZhuyinLatticeTests: XCTestCase {
    func testThePrincipleOnAFixture() {
        // 研究生 is a phrase, but 研究 + 生命 is likelier than 研究生 + 命 —
        // which the greedy walk, longest phrase first, could not see.
        var c = ZhuyinComposer(
            dictionary: ZhuyinDictionary(
                entries: ["~ㄇㄧㄥ": "命明", "~ㄕㄥ": "生", "~ㄧㄢ": "研", "~ㄐㄧㄡ": "究"],
                scores: ["~ㄇㄧㄥ": -3.5, "~ㄕㄥ": -3, "~ㄧㄢ": -4, "~ㄐㄧㄡ": -4]),
            phrases: ZhuyinPhrases(scoredEntries: [
                (phrase: "研究生", reading: "ㄧㄢˊ ㄐㄧㄡˋ ㄕㄥ", score: -4),
                (phrase: "研究", reading: "ㄧㄢˊ ㄐㄧㄡˋ", score: -3),
                (phrase: "生命", reading: "ㄕㄥ ㄇㄧㄥˋ", score: -3.3),
            ]))
        type("ㄧㄢㄐㄧㄡㄕㄥㄇㄧㄥ", into: &c)
        // 研究生 + 命 = −7.5; 研究 + 生命 = −6.3.
        XCTAssertEqual(c.best, "研究生命")
        XCTAssertEqual(c.walk(learning: false).path.map(\.value), ["研究", "生命"])
        // The bar is unchanged by any of it: the whole-buffer phrases first.
        XCTAssertEqual(c.candidates.first, "研究生")
    }

    /// Real readings where the greedy walk committed the wrong words and the
    /// lattice commits the right ones, found by typing every pair of the 400
    /// commonest two-character phrases (toneless, the way the pane is mostly
    /// typed) and comparing the two walks. See the PR for the scan.
    func testTheBundledTablesSegmentBetterThanGreedily() {
        // typed keys → (lattice, what greedy committed)
        let cases: [(String, String, String)] = ZhuyinLatticeFixtures.improved
        XCTAssertGreaterThanOrEqual(cases.count, 3)
        for (keys, expected, greedy) in cases {
            var c = ZhuyinComposer(dictionary: .bundled, phrases: .bundled)
            type(keys, into: &c)
            XCTAssertEqual(c.best, expected, "\(keys) — greedy committed \(greedy)")
            XCTAssertNotEqual(c.best, greedy)
        }
    }

    func testCorrectlyTypedSentencesStillCommitAsBefore() {
        let expected = [
            "ㄨㄛㄕㄊㄞㄨㄢㄖㄣ": "我是台灣人",
            "ㄋㄧㄏㄠ": "你好",
            "ㄋㄏ": "你好",
            "ㄊㄚㄕㄨㄛㄉㄜㄖㄣ": "他說的人",
            "ㄔㄈㄢㄌㄜㄇㄚ": "吃飯了麼",
        ]
        for (keys, sentence) in expected {
            var c = ZhuyinComposer(dictionary: .bundled, phrases: .bundled)
            type(keys, into: &c)
            XCTAssertEqual(c.best, sentence, keys)
        }
    }

    func testARawSyllableIsTheLastResort() {
        var c = ZhuyinComposer(
            dictionary: ZhuyinDictionary(entries: ["~ㄇㄚ": "媽"]),
            phrases: ZhuyinPhrases(entries: []))
        type("ㄍㄧㄇㄚ", into: &c)
        XCTAssertEqual(c.best, "ㄍㄧ媽", "nothing reads ㄍㄧ, so it is kept as typed")
    }
}

/// `ZhuyinMemory` on its own: weights, decay, the LRU and the file.
final class ZhuyinMemoryTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    private let day: TimeInterval = 24 * 60 * 60

    private func key(_ n: Int = 0, context: [String] = ["他"]) -> ZhuyinMemory.Key {
        ZhuyinMemory.Key(context: context, reading: "ㄓㄨㄥ", value: "中\(n == 0 ? "" : String(n))")
    }

    func testOnePickIsNotAPreferenceAndTwoAre() {
        let memory = ZhuyinMemory(url: nil)
        memory.observe(key(), chose: "鍾", longer: false, now: t0)
        XCTAssertNil(memory.suggestion(for: key(), now: t0), "one pick is ambiguous")
        memory.observe(key(), chose: "鍾", longer: false, now: t0 + 60)
        XCTAssertEqual(memory.suggestion(for: key(), now: t0 + 60)?.value, "鍾")
    }

    func testPickingWhatTheWalkHadTeachesNothing() {
        let memory = ZhuyinMemory(url: nil)
        memory.observe(key(), chose: "中", longer: false, now: t0)
        XCTAssertTrue(memory.isEmpty)
    }

    func testAnotherContextIsAnotherLesson() {
        let memory = ZhuyinMemory(url: nil)
        memory.observe(key(), chose: "鍾", longer: false, now: t0)
        memory.observe(key(), chose: "鍾", longer: false, now: t0)
        XCTAssertNil(memory.suggestion(for: key(context: ["我"]), now: t0))
        XCTAssertNil(memory.suggestion(for: key(context: []), now: t0))
    }

    func testAPreferenceDecaysWithAHalfLifeOfAWeek() {
        let memory = ZhuyinMemory(url: nil)
        memory.observe(key(), chose: "鍾", longer: false, now: t0)
        memory.observe(key(), chose: "鍾", longer: false, now: t0)
        // Weight 2, halved every seven days: 1.5 is crossed at 7·log2(4/3) ≈ 2.9 days.
        XCTAssertNotNil(memory.suggestion(for: key(), now: t0 + 2.5 * day))
        XCTAssertNil(memory.suggestion(for: key(), now: t0 + 3.5 * day))
        // Using it starts its age again; it does not add to its count.
        memory.touch(key(), value: "鍾", now: t0 + 2.5 * day)
        XCTAssertNotNil(memory.suggestion(for: key(), now: t0 + 5 * day))
        // Two weeks unused below the drop threshold — two at weight 2: 0.25 at
        // 21 days — and the key is gone.
        memory.prune(now: t0 + 2.5 * day + 22 * day)
        XCTAssertTrue(memory.isEmpty)
    }

    func testAnOldPickDoesNotMakeANewOneAPreference() {
        let memory = ZhuyinMemory(url: nil)
        memory.observe(key(), chose: "鍾", longer: false, now: t0)
        memory.observe(key(), chose: "鍾", longer: false, now: t0 + 14 * day)
        // 1 × 0.25 + 1 = 1.25 < 1.5.
        XCTAssertNil(memory.suggestion(for: key(), now: t0 + 14 * day))
    }

    func testTheHeavierChoiceWins() {
        let memory = ZhuyinMemory(url: nil)
        for _ in 0..<2 { memory.observe(key(), chose: "鍾", longer: false, now: t0) }
        for _ in 0..<3 { memory.observe(key(), chose: "忠", longer: false, now: t0 + day) }
        XCTAssertEqual(memory.suggestion(for: key(), now: t0 + day)?.value, "忠")
    }

    func testTheLeastRecentlyUsedKeyIsEvictedPastCapacity() {
        let memory = ZhuyinMemory(url: nil)
        for n in 0..<ZhuyinMemory.capacity {
            memory.observe(key(n), chose: "鍾", longer: false, now: t0)
        }
        // Using the oldest makes it the newest, so the next one goes instead.
        memory.observe(key(0), chose: "鍾", longer: false, now: t0)
        memory.observe(key(ZhuyinMemory.capacity), chose: "鍾", longer: false, now: t0)
        XCTAssertEqual(memory.count, ZhuyinMemory.capacity)
        XCTAssertNotNil(memory.suggestion(for: key(0), now: t0), "used, so kept")
        XCTAssertNil(memory.suggestion(for: key(1), now: t0), "least recently used, evicted")
        XCTAssertFalse(memory.knows(reading: "ㄓㄨㄥ") == false)
    }

    func testForgettingRemovesEveryLessonForThatWordAndNothingElse() {
        let memory = ZhuyinMemory(url: nil)
        for _ in 0..<2 {
            memory.observe(key(1), chose: "鍾", longer: false, now: t0)
            memory.observe(key(2), chose: "鍾", longer: false, now: t0)
            memory.observe(key(2), chose: "忠", longer: false, now: t0)
            memory.observe(key(3), chose: "終", longer: false, now: t0)
        }
        XCTAssertTrue(memory.produces("鍾"))
        XCTAssertTrue(memory.forget("鍾"))
        XCTAssertFalse(memory.produces("鍾"))
        XCTAssertNil(memory.suggestion(for: key(1), now: t0))
        XCTAssertEqual(memory.suggestion(for: key(2), now: t0)?.value, "忠")
        XCTAssertEqual(memory.suggestion(for: key(3), now: t0)?.value, "終")
        XCTAssertFalse(memory.forget("鍾"), "nothing left to forget")
    }

    func testTheFileRoundTrips() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("zhuyin-memory-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let suite = "zhuyin-memory-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        let now = Date()
        let written = ZhuyinMemory(url: url, defaults: defaults)
        written.persists = true
        for _ in 0..<2 {
            written.observe(key(1), chose: "鍾", longer: false, now: now)
            written.observe(key(2), chose: "字彙", longer: true, now: now)
        }
        written.save(synchronously: true)
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))

        let read = ZhuyinMemory(url: url, defaults: defaults)
        read.persists = true
        read.loadNow()
        XCTAssertEqual(read.count, 2)
        XCTAssertEqual(read.suggestion(for: key(1), now: now), .init(value: "鍾", longer: false))
        XCTAssertEqual(read.suggestion(for: key(2), now: now), .init(value: "字彙", longer: true))
        XCTAssertTrue(read.knows(reading: "ㄓㄨㄥ"))
    }

    func testAResetInSettingsWinsOverAKeyboardHoldingTheOldMemory() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("zhuyin-memory-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let suite = "zhuyin-memory-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        let keyboard = ZhuyinMemory(url: url, defaults: defaults)
        keyboard.persists = true
        keyboard.loadNow()
        for _ in 0..<2 { keyboard.observe(key(), chose: "鍾", longer: false) }
        keyboard.save(synchronously: true)

        // The app resets while the keyboard still holds what it learned.
        ZhuyinMemory.requestReset(url: url, defaults: defaults)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        // The keyboard's next write does not bring it back, because it honours
        // the reset first and writes what is left: nothing.
        keyboard.save(synchronously: true)
        let reread = ZhuyinMemory(url: url, defaults: defaults)
        reread.persists = true
        reread.loadNow()
        XCTAssertTrue(reread.isEmpty)
        XCTAssertTrue(keyboard.isEmpty)
        XCTAssertNil(keyboard.suggestion(for: key()))
    }

    func testWithoutFullAccessNothingTouchesTheDisk() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("zhuyin-memory-\(UUID().uuidString).json")
        let memory = ZhuyinMemory(url: url)
        for _ in 0..<2 { memory.observe(key(), chose: "鍾", longer: false) }
        memory.save(synchronously: true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        XCTAssertNotNil(memory.suggestion(for: key()), "still learned, in memory")
    }

    func testAFullMemoryIsSmall() {
        // Resident cost of 500 keys, each with two choices and two words of
        // context: what the memory holds at its largest.
        let before = ZhuyinFuzzyPerformanceTests.footprint()
        let memory = ZhuyinMemory(url: nil)
        for n in 0..<ZhuyinMemory.capacity {
            let key = ZhuyinMemory.Key(
                context: ["我們", "今天\(n)"], reading: "ㄧㄢ ㄐㄧㄡ ㄕㄥ", value: "研究生\(n)")
            memory.observe(key, chose: "研究", longer: false)
            memory.observe(key, chose: "菸酒生", longer: false)
        }
        let after = ZhuyinFuzzyPerformanceTests.footprint()
        let kilobytes = Double(Int64(after) - Int64(before)) / 1024
        print(String(format: "[zhuyin-mem] full ZhuyinMemory (500 keys): +%.0f KB footprint", kilobytes))
        XCTAssertEqual(memory.count, ZhuyinMemory.capacity)
        XCTAssertLessThan(kilobytes, 2048)
    }
}

/// The composer learning from picks: what the spec calls the third time.
final class ZhuyinComposerLearningTests: XCTestCase {
    /// Type 他 then the reading, starting a fresh field each time, as a user
    /// writing the same name on three occasions would.
    private func typeAfter他(
        _ keys: String, memory: ZhuyinMemory, context: String = "他"
    ) -> ZhuyinComposer {
        var c = ZhuyinComposer(dictionary: .bundled, phrases: .bundled, memory: memory)
        c.resetContext()
        type("ㄊㄚ", into: &c)
        if context == "他" {
            _ = c.pick("他")
        } else {
            _ = c.confirm()
            c.resetContext()
            type("ㄨㄛ", into: &c)
            _ = c.pick("我")
        }
        type(keys, into: &c)
        return c
    }

    func testTwoPicksInAContextPutTheChoiceFirstTheThirdTime() {
        let memory = ZhuyinMemory(url: nil)
        var first = typeAfter他("ㄓㄨㄥ", memory: memory)
        let walked = first.best
        let corpusFirst = first.candidates.first
        XCTAssertNotEqual(walked, "鍾", "the corpus would not commit 鍾 here")
        XCTAssertNotEqual(first.candidates.first, "鍾")
        XCTAssertTrue(first.candidates.contains("鍾"))
        _ = first.pick("鍾")

        var second = typeAfter他("ㄓㄨㄥ", memory: memory)
        XCTAssertNotEqual(second.candidates.first, "鍾", "one pick is not a preference")
        _ = second.pick("鍾")

        var third = typeAfter他("ㄓㄨㄥ", memory: memory)
        XCTAssertEqual(third.candidates.first, "鍾")
        XCTAssertEqual(third.best, "鍾")
        XCTAssertEqual(third.confirm(), .insert("鍾"))

        // Another context is untouched.
        let elsewhere = typeAfter他("ㄓㄨㄥ", memory: memory, context: "我")
        XCTAssertEqual(elsewhere.candidates.first, corpusFirst)
        XCTAssertEqual(elsewhere.best, walked)
    }

    func testReturnAndSpaceTeachNothing() {
        let memory = ZhuyinMemory(url: nil)
        for _ in 0..<3 {
            var c = typeAfter他("ㄓㄨㄥ", memory: memory)
            _ = c.space()
            _ = c.space()
            _ = c.confirm()
        }
        XCTAssertTrue(memory.isEmpty)
    }

    func testALongerChoiceOverridesTheWalkWithAHighScore() {
        // McBopomofo's 增加[自][會] → 增加[字彙] case: two characters that
        // together outscore the phrase, so the walk keeps choosing them. Once
        // the phrase is learned the walk takes it whatever the scores say.
        let memory = ZhuyinMemory(url: nil)
        func composer() -> ZhuyinComposer {
            var c = ZhuyinComposer(
                dictionary: ZhuyinDictionary(
                    entries: ["~ㄗ": "自字", "~ㄏㄨㄟ": "會彙"],
                    scores: ["~ㄗ": -2, "~ㄏㄨㄟ": -2]),
                phrases: ZhuyinPhrases(scoredEntries: [
                    (phrase: "字彙", reading: "ㄗˋ ㄏㄨㄟˋ", score: -6)
                ]),
                memory: memory)
            type("ㄗㄏㄨㄟ", into: &c)
            return c
        }
        var c = composer()
        XCTAssertEqual(c.best, "自會")
        _ = c.pick("字彙")
        c = composer()
        XCTAssertEqual(c.best, "自會", "one pick is not a preference")
        _ = c.pick("字彙")
        c = composer()
        XCTAssertEqual(c.best, "字彙")
        XCTAssertEqual(c.candidates.first, "字彙")
    }

    func testContextIsTheLastTwoCommittedWords() {
        var c = ZhuyinComposer(dictionary: .bundled, phrases: .bundled)
        type("ㄨㄛ", into: &c)
        _ = c.pick("我")
        type("ㄕㄊㄞㄨㄢㄖㄣ", into: &c)
        _ = c.confirm()
        // 我 picked, then the walk's 是 + 台灣人: the last two of those.
        XCTAssertEqual(c.context, ["是", "台灣人"])
        _ = c.space()
        XCTAssertEqual(c.context, [], "a space typed into the document starts over")
    }

    func testForgettingPutsTheBarBack() {
        let memory = ZhuyinMemory(url: nil)
        for _ in 0..<2 {
            var c = typeAfter他("ㄓㄨㄥ", memory: memory)
            _ = c.pick("鍾")
        }
        XCTAssertEqual(typeAfter他("ㄓㄨㄥ", memory: memory).candidates.first, "鍾")
        memory.forget("鍾")
        XCTAssertNotEqual(typeAfter他("ㄓㄨㄥ", memory: memory).candidates.first, "鍾")
    }
}

/// 聯想詞: what the bar offers after a pick that empties the buffer.
final class ZhuyinAssociationTests: XCTestCase {
    private let table = ZhuyinAssociations(entries: [
        "研": ["究", "究所", "究生", "發"],
        "究": ["竟", "責"],
        "好": ["的", "像"],
    ])

    func testTheLongestSuffixIsReadFirst() {
        XCTAssertEqual(table.continuations(after: "研"), ["究", "究所", "究生", "發"])
        XCTAssertEqual(
            table.continuations(after: "研究"), ["所", "生", "竟", "責"],
            "研究's own continuations, then 究's")
        XCTAssertEqual(table.continuations(after: "你好"), ["的", "像"])
        XCTAssertEqual(table.continuations(after: "嗎"), [])
    }

    func testAPickThatEmptiesTheBufferOpensThemAndAnyKeyClosesThem() {
        var c = ZhuyinComposer(
            dictionary: ZhuyinDictionary(entries: ["~ㄧㄢ": "研", "~ㄏㄠ": "好"]),
            associations: table)
        type("ㄧㄢ", into: &c)
        XCTAssertEqual(c.associations, [])
        XCTAssertEqual(c.pick("研"), .insert("研"))
        XCTAssertEqual(c.associations, ["究", "究所", "究生", "發"])

        XCTAssertEqual(c.pickAssociation("究"), .insert("究"))
        XCTAssertEqual(c.context, ["研究"], "an association extends the word before it")
        XCTAssertEqual(c.associations, ["所", "生", "竟", "責"])

        _ = c.symbol("ㄏ")
        XCTAssertEqual(c.associations, [], "a 注音 key dismisses them")
        _ = c.delete()
        _ = c.delete()
        XCTAssertEqual(c.associations, [], "and so does delete")
    }

    func testAPickThatLeavesSyllablesPendingOpensNothing() {
        var c = ZhuyinComposer(
            dictionary: ZhuyinDictionary(entries: ["~ㄧㄢ": "研", "~ㄏㄠ": "好"]),
            associations: table)
        type("ㄧㄢㄏㄠ", into: &c)
        _ = c.pick("研")
        XCTAssertEqual(c.associations, [])
    }

    func testTheBundledTable() {
        let continuations = ZhuyinAssociations.bundled.continuations(after: "研")
        XCTAssertEqual(continuations.first, "究")
        XCTAssertLessThanOrEqual(continuations.count, ZhuyinAssociations.limit)
        XCTAssertTrue(ZhuyinAssociations.bundled.continuations(after: "研究").contains("所"))
    }

    func testTheBundledTableIsSmall() throws {
        // Footprint before and after a parse, and the rows' own bytes — the
        // footprint delta alone can read low when the allocator reuses pages an
        // earlier test freed. Each row is one heap string; the dictionary adds
        // a few dozen bytes a row on top.
        let url = try XCTUnwrap(ZhuyinAssociations.bundledURL)
        let before = ZhuyinFuzzyPerformanceTests.footprint()
        let table = ZhuyinAssociations.parse(url)
        let after = ZhuyinFuzzyPerformanceTests.footprint()
        let kilobytes = Double(Int64(after) - Int64(before)) / 1024
        let payload = table.values.reduce(0) { $0 + $1.utf8.count }
        print(
            String(
                format:
                    "[zhuyin-mem] associations table (%d rows): +%.0f KB footprint, %.0f KB of row text",
                table.count, kilobytes, Double(payload) / 1024))
        XCTAssertGreaterThan(table.count, 3_000)
        XCTAssertLessThan(kilobytes, 4096)
        withExtendedLifetime(table) {}
    }
}

/// Cases from the greedy-vs-lattice scan: every pair of the 400 commonest
/// two-character phrases typed toneless, 144,728 four-syllable buffers. The
/// two walks disagreed on 5,808; the lattice committed the intended pair on
/// 3,901 of those and greedy on 173. These are a sample of the first kind —
/// typed keys, what the lattice commits, what greedy committed.
enum ZhuyinLatticeFixtures {
    static let improved: [(String, String, String)] = [
        ("ㄨㄛㄇㄣㄉㄜㄏㄨㄚ", "我們的話", "我們的化"),
        ("ㄧㄍㄜㄅㄢㄈㄚ", "一個辦法", "一個半法"),
        ("ㄒㄧㄢㄗㄞㄕㄐㄧㄝ", "現在世界", "現在是接"),
        ("ㄎㄜㄋㄥㄏㄨㄟㄌㄞ", "可能回來", "可能會來"),
        ("ㄗㄐㄧㄔㄨㄌㄧ", "自己處理", "造就出理"),
        ("ㄓㄨㄥㄧㄠㄕㄑㄧㄥ", "重要事情", "中藥商情"),
    ]
}

/// What the lattice costs. It runs on confirm (return, space, punctuation,
/// leaving the pane) and on a pick — never on a plain keystroke unless the
/// memory knows a reading in the buffer, when the refresh walks to see whether
/// the front has a lesson. Printed for the log; asserted loosely, as
/// `ZhuyinFuzzyPerformanceTests` is.
final class ZhuyinLatticePerformanceTests: XCTestCase {
    private func milliseconds(_ repetitions: Int = 20, _ body: () -> Void) -> Double {
        let start = DispatchTime.now().uptimeNanoseconds
        for _ in 0..<repetitions { body() }
        return Double(DispatchTime.now().uptimeNanoseconds - start) / Double(repetitions) / 1e6
    }

    func testTheWalkOverSixSyllables() {
        var c = ZhuyinComposer(dictionary: .bundled, phrases: .bundled)
        type("ㄓㄣㄗㄥㄕㄨㄙㄨㄈㄢㄏㄢ", into: &c)
        _ = c.best
        let ms = milliseconds { _ = c.best }
        print(String(format: "[zhuyin-perf] lattice walk, 6 syllables: %.3f ms", ms))
        XCTAssertLessThan(ms, 32)
    }

    func testAKeystrokeWhenTheMemoryKnowsTheReading() {
        let memory = ZhuyinMemory(url: nil)
        let key = ZhuyinMemory.Key(context: [], reading: "ㄓㄣ", value: "真")
        for _ in 0..<2 { memory.observe(key, chose: "針", longer: false) }
        var base = ZhuyinComposer(dictionary: .bundled, phrases: .bundled, memory: memory)
        type("ㄓㄣㄗㄥㄕㄨㄙㄨㄈㄢㄏ", into: &base)
        let ms = milliseconds {
            var c = base
            _ = c.symbol("ㄢ")
        }
        print(String(format: "[zhuyin-perf] keystroke with a known reading, 6 syllables: %.3f ms", ms))
        XCTAssertLessThan(ms, 32)
    }
}
