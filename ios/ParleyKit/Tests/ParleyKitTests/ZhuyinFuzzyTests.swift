import XCTest

@testable import ParleyKit

/// The packed syllable: the phrase table's readings are these now, so a value
/// that does not round-trip is a phrase that can never be typed.
final class ZhuyinPackedTests: XCTestCase {
    func testEverySyllableTheModelCanHoldRoundTrips() {
        // Every symbol in every slot, empty included, under every tone and none:
        // 22 × 4 × 14 × 6 = 7,392 syllables, most of them unpronounceable, all
        // of them representable — which is the claim `packed` makes.
        let initials: [Character?] = [nil] + ZhuyinSyllable.initials.map { $0 }
        let medials: [Character?] = [nil] + ZhuyinSyllable.medials.map { $0 }
        let finals: [Character?] = [nil] + ZhuyinSyllable.finals.map { $0 }
        let tones: [ZhuyinTone?] = [nil] + ZhuyinTone.allCases
        var seen = Set<UInt16>()
        for i in initials {
            for m in medials {
                for f in finals {
                    for t in tones {
                        let syllable = ZhuyinSyllable(initial: i, medial: m, final: f, tone: t)
                        let packed = syllable.packed
                        XCTAssertEqual(ZhuyinSyllable(packed: packed), syllable, syllable.text)
                        XCTAssertTrue(seen.insert(packed).inserted, "\(syllable.text) collides")
                        XCTAssertLessThan(packed, 1 << 14, "\(syllable.text) spills past 14 bits")
                    }
                }
            }
        }
        XCTAssertEqual(seen.count, 22 * 4 * 14 * 6)
    }

    func testOnlyTheEmptySyllablePacksToZero() {
        // 0 marks "no syllable" inside a packed reading, which is only safe
        // because nothing typeable packs to it.
        XCTAssertEqual(ZhuyinSyllable().packed, 0)
        XCTAssertNotEqual(ZhuyinSyllable(initial: "ㄅ").packed, 0)
        XCTAssertNotEqual(ZhuyinSyllable.parse("ㄚ")?.packed, 0, "a first-tone reading carries a tone")
    }

    func testBitsNoSyllablePacksToAreRefused() {
        XCTAssertNil(ZhuyinSyllable(packed: 22), "a 22nd 聲母")
        XCTAssertNil(ZhuyinSyllable(packed: 14 << 7), "a 14th 韻母")
        XCTAssertNil(ZhuyinSyllable(packed: 6 << 11), "a sixth tone")
        XCTAssertNil(ZhuyinSyllable(packed: 1 << 14), "bits above the tone")
    }

    func testPackingAReadingAgreesWithParsingItForEveryBundledSyllable() {
        // `pack` is `parse(_:)?.packed` without the allocations, run 150,000 times
        // at load. It has to agree on every syllable the data holds, and refuse
        // what `parse` refuses.
        var readings = Set(
            ZhuyinSyllableTests.bundledReadings().map { $0.hasPrefix("~") ? String($0.dropFirst()) : $0 })
        if let url = ZhuyinPhrases.bundledURL, let text = try? String(contentsOf: url, encoding: .utf8) {
            for line in text.split(separator: "\n") where !line.hasPrefix("#") {
                guard let reading = line.split(separator: "\t").last else { continue }
                for syllable in reading.split(separator: " ") { readings.insert(String(syllable)) }
            }
        }
        XCTAssertGreaterThan(readings.count, 1000, "the resources didn't load")
        for reading in readings {
            XCTAssertEqual(
                ZhuyinSyllable.pack(reading[...].unicodeScalars), ZhuyinSyllable.parse(reading)?.packed,
                reading)
        }
        for invalid in ["", "ˊ", "ㄅㄆ", "ㄧㄩ", "ㄚㄅ", "ㄨㄛˇˋ", "ㄉㄜ˙ㄅ", "ㄅㄨㄥx", "de"] {
            XCTAssertNil(ZhuyinSyllable.pack(invalid[...].unicodeScalars), "accepted \"\(invalid)\"")
        }
    }

    func testAPhraseRowIsSmallAndHoldsNoReadingString() {
        // What B0 bought: the row is a phrase plus two integers. Printed so the
        // number is in the log next to the one it replaced (String + String, 32).
        let stride = MemoryLayout<ZhuyinPhrases.Entry>.stride
        print("[zhuyin-mem] ZhuyinPhrases.Entry stride \(stride) bytes")
        XCTAssertLessThanOrEqual(stride, 32)
    }
}

/// The rules themselves: which symbol could have been meant for which.
final class ZhuyinFuzzyTests: XCTestCase {
    private let symbols = Array(ZhuyinSyllable.initials + ZhuyinSyllable.medials + ZhuyinSyllable.finals)

    func testTheTableForTheSymbolsTheDesignNames() {
        // 模糊音 partners first, then adjacent keys nearest-centre first. ㄋ's
        // ㄌ is both a partner and the key below it, and appears once, as a
        // partner. ㄧ's neighbours are ㄗ, ㄛ, ˙, ㄚ, ㄨ and ㄘ — only ㄨ is a 介音.
        XCTAssertEqual(ZhuyinFuzzy.alternatives(for: "ㄋ"), Array("ㄌㄇㄎㄊㄍㄏ"))
        XCTAssertEqual(ZhuyinFuzzy.alternatives(for: "ㄓ"), Array("ㄗㄔㄐ"))
        XCTAssertEqual(ZhuyinFuzzy.alternatives(for: "ㄣ"), Array("ㄥㄟㄢㄦㄤㄠ"))
        XCTAssertEqual(ZhuyinFuzzy.alternatives(for: "ㄧ"), Array("ㄨ"))
    }

    func testThe模糊音PairsAreSymmetricAndComeFirst() {
        for (a, b) in ZhuyinFuzzy.pairs {
            XCTAssertTrue(ZhuyinFuzzy.alternatives(for: a).contains(b), "\(a) → \(b)")
            XCTAssertTrue(ZhuyinFuzzy.alternatives(for: b).contains(a), "\(b) → \(a)")
        }
        // Not transitive: ㄌ pairs with both ㄋ and ㄖ, which do not pair.
        XCTAssertEqual(ZhuyinFuzzy.alternatives(for: "ㄌ").prefix(2), ["ㄋ", "ㄖ"])
        XCTAssertEqual(ZhuyinFuzzy.table["ㄋ"]?.pairs, ["ㄌ"])
        XCTAssertEqual(ZhuyinFuzzy.table["ㄖ"]?.pairs, ["ㄌ"])
    }

    func testAdjacencyIsSymmetric() {
        // Computed from centres, so if the thumb can slip from a to b it can slip
        // back — a table typed by hand would be the first thing to lose this.
        for a in symbols {
            for b in ZhuyinFuzzy.table[a]?.adjacent ?? [] {
                XCTAssertTrue(ZhuyinFuzzy.alternatives(for: b).contains(a), "\(a) ~ \(b)")
            }
        }
    }

    func testTheStaggerDecidesWhichKeysTouch() {
        // Rows 2 and 3 step right, row 4 steps back to the left edge. So ㄧ (u)
        // touches ㄨ (j) at its own index, and ㄋ (s) touches ㄏ (c) — one column
        // over — because the fourth row is not staggered.
        XCTAssertEqual(ZhuyinFuzzy.adjacentKeys(to: "ㄋ"), Array("ㄇㄎㄊㄍㄏㄌ"))
        XCTAssertEqual(ZhuyinFuzzy.adjacentKeys(to: "ㄅ"), Array("ㄉㄆ"), "a corner key")
        XCTAssertEqual(
            ZhuyinFuzzy.adjacentKeys(to: "ㄓ"), Array("ㄔㄐ"),
            "its left and right keys are tone marks, which never count")
    }

    func testAlternativesStayInTheirSlotAndNeverIncludeATone() {
        let tones: Set<Character> = ["ˊ", "ˇ", "ˋ", "˙"]
        for symbol in symbols {
            let alternatives = ZhuyinFuzzy.alternatives(for: symbol)
            XCTAssertFalse(alternatives.isEmpty, "\(symbol) has no alternatives")
            XCTAssertEqual(Set(alternatives).count, alternatives.count, "\(symbol) repeats one")
            XCTAssertFalse(alternatives.contains(symbol), "\(symbol) is its own alternative")
            for alternative in alternatives {
                XCTAssertFalse(tones.contains(alternative), "\(symbol) → a tone")
                XCTAssertEqual(
                    ZhuyinSyllable.slot(of: alternative), ZhuyinSyllable.slot(of: symbol),
                    "\(symbol) → \(alternative) crosses slots")
            }
        }
        for tone in tones {
            XCTAssertEqual(ZhuyinFuzzy.alternatives(for: tone), [], "a tone is never substituted")
        }
        XCTAssertEqual(ZhuyinFuzzy.alternatives(for: "a"), [])
    }

    func testAVariantDiffersInExactlyOneFilledSlot() {
        let typed = ZhuyinSyllable(initial: "ㄓ", medial: "ㄨ", final: "ㄥ", tone: .second)
        let variants = ZhuyinFuzzy.variants(of: typed)
        XCTAssertEqual(
            variants.count,
            ["ㄓ", "ㄨ", "ㄥ"].map { ZhuyinFuzzy.alternatives(for: $0).count }.reduce(0, +))
        XCTAssertEqual(Set(variants).count, variants.count, "a variant repeats")
        for variant in variants {
            XCTAssertEqual(variant.tone, .second, "the tone is never touched")
            let differing = [
                variant.initial != typed.initial, variant.medial != typed.medial,
                variant.final != typed.final,
            ].filter { $0 }
            XCTAssertEqual(differing.count, 1, variant.text)
        }
        // 模糊音 before slips, across all the slots: ㄗㄨㄥ and ㄓㄨㄣ lead.
        XCTAssertEqual(variants.prefix(2).map(\.text), ["ㄗㄨㄥˊ", "ㄓㄨㄣˊ"])
    }

    func testAnEmptySlotIsNeverFilledByAVariant() {
        // A missing symbol is not a wrong one.
        for variant in ZhuyinFuzzy.variants(of: ZhuyinSyllable(initial: "ㄋ", final: "ㄠ")) {
            XCTAssertNil(variant.medial, variant.text)
        }
        XCTAssertEqual(ZhuyinFuzzy.variants(of: ZhuyinSyllable()), [])
    }
}

/// The dictionary's fuzzy tail: after the exact row, bounded, never duplicated.
final class ZhuyinFuzzyDictionaryTests: XCTestCase {
    private let fixture = ZhuyinDictionary(entries: [
        "~ㄗㄨㄥ": "宗總",
        "~ㄓㄨㄥ": "中宗種",
        "~ㄓㄨㄣ": "諄准",
        "ㄗㄨㄥˇ": "總",
        "ㄓㄨㄥˇ": "種腫",
        "ㄓㄨㄥˋ": "眾",
    ])

    func testTheExactRowComesFirstAndTheVariantsFollow() {
        let syllable = ZhuyinSyllable(initial: "ㄗ", medial: "ㄨ", final: "ㄥ")
        XCTAssertEqual(fixture.tonelessCandidates(for: syllable), ["宗", "總", "中", "種"])
        XCTAssertEqual(fixture.tonelessCandidates(for: syllable, fuzzy: false), ["宗", "總"])
    }

    func testTheToneIsNeverForgiven() {
        // ㄗㄨㄥˇ's variants are all third tone: ㄓㄨㄥˇ answers, ㄓㄨㄥˋ does not.
        XCTAssertEqual(
            fixture.candidates(for: ZhuyinSyllable(initial: "ㄗ", medial: "ㄨ", final: "ㄥ", tone: .third)),
            ["總", "種", "腫"])
    }

    func testWithNoExactRowTheFirstVariantAnswers() {
        // ㄓㄨㄡ is nobody's reading; ㄥ slipped to its left neighbour ㄡ. The
        // variants that exist in the table answer, in `variants` order.
        let syllable = ZhuyinSyllable(initial: "ㄓ", medial: "ㄨ", final: "ㄡ")
        XCTAssertEqual(fixture.tonelessCandidates(for: syllable, fuzzy: false), [])
        XCTAssertEqual(fixture.tonelessCandidates(for: syllable).first, "中")
    }

    func testEachVariantAddsABoundedNumberOfCharacters() {
        let long = String((0..<50).map { Character(UnicodeScalar(0x4E00 + $0)!) })
        let dictionary = ZhuyinDictionary(entries: ["~ㄓㄨㄥ": long, "~ㄗㄨㄥ": "宗"])
        let row = dictionary.tonelessCandidates(for: ZhuyinSyllable(initial: "ㄗ", medial: "ㄨ", final: "ㄥ"))
        XCTAssertEqual(row.count, 1 + ZhuyinDictionary.fuzzyPerVariant)
    }

    func testTheBundledDictionaryOffers中For宗sReading() {
        let typed = ZhuyinSyllable(initial: "ㄗ", medial: "ㄨ", final: "ㄥ")
        let exact = ZhuyinDictionary.bundled.tonelessCandidates(for: typed, fuzzy: false)
        let row = ZhuyinDictionary.bundled.tonelessCandidates(for: typed)
        XCTAssertFalse(exact.contains("中"))
        XCTAssertEqual(Array(row.prefix(exact.count)), exact, "the exact row is untouched and first")
        XCTAssertTrue(row.contains("中"), "ㄓ/ㄗ is the commonest 模糊音 there is")
        XCTAssertEqual(Set(row).count, row.count, "a character appears twice")
    }
}

/// The phrase table's forgiving half.
final class ZhuyinFuzzyPhrasesTests: XCTestCase {
    /// File order is deliberately hostile: the forgiven rows come first, so if
    /// ranking fell back to file order they would lead the bar.
    private let fixture = ZhuyinPhrases(entries: [
        (phrase: "理好", reading: "ㄌㄧˇ ㄏㄠˇ"),  // ㄋ→ㄌ, under another key
        (phrase: "你後", reading: "ㄋㄧˇ ㄏㄡˋ"),  // ㄠ→ㄡ, under the same key
        (phrase: "李好嗎", reading: "ㄌㄧˇ ㄏㄠˇ ㄇㄚ˙"),  // forgiven, and a prediction
        (phrase: "路好", reading: "ㄌㄨˋ ㄏㄠˇ"),  // ㄋ→ㄌ *and* ㄧ→ㄨ: two in one syllable
        (phrase: "你好", reading: "ㄋㄧˇ ㄏㄠˇ"),
        (phrase: "你好嗎", reading: "ㄋㄧˇ ㄏㄠˇ ㄇㄚ˙"),
        (phrase: "禮後", reading: "ㄌㄧˇ ㄏㄡˋ"),  // one error in each syllable
        (phrase: "你好", reading: "ㄌㄧˇ ㄏㄠˇ"),  // 你好 again, under a forgiven reading
        (phrase: "你拷", reading: "ㄋㄧˇ ㄎㄠˇ"),  // ㄏ→ㄎ, the key above it
    ])

    private func phrases(_ symbols: String, fuzzy: Bool = true) -> [String] {
        fixture.matches(ZhuyinPhrasesTests.buffer(symbols), fuzzy: fuzzy).map(\.phrase)
    }

    func testExactMatchesAlwaysPrecedeForgivenOnes() {
        XCTAssertEqual(
            phrases("ㄋㄧㄏㄠ"),
            ["你好", "你好嗎", "理好", "你後", "你拷", "李好嗎", "禮後"])
        let matches = fixture.matches(ZhuyinPhrasesTests.buffer("ㄋㄧㄏㄠ"))
        XCTAssertEqual(matches.map(\.errors), [0, 0, 1, 1, 1, 1, 2])
    }

    func testAPhraseIsNeverOfferedTwice() {
        // 你好 matches exactly under ㄋㄧˇ ㄏㄠˇ and forgivingly under ㄌㄧˇ ㄏㄠˇ;
        // it is shown once, at the exact position.
        let offered = phrases("ㄋㄧㄏㄠ")
        XCTAssertEqual(offered.filter { $0 == "你好" }.count, 1)
        XCTAssertEqual(Set(offered).count, offered.count)
    }

    func testTwoErrorsInOneSyllableAreNotForgiven() {
        XCTAssertFalse(phrases("ㄋㄧㄏㄠ").contains("路好"))
        // One of the two is.
        XCTAssertTrue(phrases("ㄌㄧㄏㄠ").contains("路好"), "only ㄧ→ㄨ from ㄌㄧ")
    }

    func testATypedToneIsNeverForgiven() {
        // 你後 differs from ㄋㄧˇ ㄏㄠˇ in one symbol *and* the tone.
        let toned = phrases("ㄋㄧˇㄏㄠˇ")
        XCTAssertFalse(toned.contains("你後"))
        XCTAssertFalse(toned.contains("禮後"))
        XCTAssertEqual(toned, ["你好", "你好嗎", "理好", "你拷", "李好嗎"])
    }

    func testAWrongFirstSymbolIsFoundUnderItsOwnKey() {
        // Typed ㄌㄧㄏㄠ, the exact answers are ㄌㄏ's own. 你後 lives under ㄋㄏ and
        // 你拷 under ㄋㄎ — both of the first two symbols substituted — so they
        // are only reachable by reading every bucket a substitution could have
        // come from.
        let offered = phrases("ㄌㄧㄏㄠ")
        XCTAssertEqual(offered.prefix(3), ["理好", "你好", "李好嗎"])
        XCTAssertTrue(offered.contains("你後"))
        XCTAssertTrue(offered.contains("你拷"))
    }

    func testFuzzyOffIsTheExactTable() {
        XCTAssertEqual(phrases("ㄋㄧㄏㄠ", fuzzy: false), ["你好", "你好嗎"])
    }

    func testForgivenMatchesStillRespectTheCap() {
        let many = ZhuyinPhrases(
            entries: (0..<(ZhuyinPhrases.matchLimit + 20)).map {
                (phrase: "\(Character(UnicodeScalar(0x4E00 + $0)!))好", reading: "ㄔˊ ㄏㄠˇ")
            })
        // Typed ㄘ, meant ㄔ: every row is forgiven, and still only forty come back.
        XCTAssertEqual(
            many.matches(ZhuyinPhrasesTests.buffer("ㄘㄏ")).count, ZhuyinPhrases.matchLimit)
    }

    func testDuplicatesCannotCrowdOutTheRowsBehindThem() {
        // Thirty phrases listed under two readings each, then thirty more. The
        // shortlist the forgiving half keeps fills with the thirty twice over;
        // deduplicated that is short of forty, and the rows behind must still
        // come through.
        let hanzi = { (n: Int) in "\(Character(UnicodeScalar(0x4E00 + n)!))好" }
        var rows: [(phrase: String, reading: String)] = []
        rows += (0..<30).map { (phrase: hanzi($0), reading: "ㄔˊ ㄏㄠˇ") }
        rows += (0..<30).map { (phrase: hanzi($0), reading: "ㄔˋ ㄏㄠˇ") }
        rows += (100..<130).map { (phrase: hanzi($0), reading: "ㄔˊ ㄏㄠˇ") }
        let offered = ZhuyinPhrases(entries: rows).matches(ZhuyinPhrasesTests.buffer("ㄘㄏ"))
            .map(\.phrase)
        XCTAssertEqual(offered, (0..<30).map(hanzi) + (100..<110).map(hanzi))
    }

    // MARK: the bundled resource

    func testOneSlipOn你好StillOffers你好() {
        // ㄋ typed as ㄌ (模糊音, and the key below it), and ㄏ typed as ㄎ (the
        // key above it).
        for typed in ["ㄌㄧㄏㄠ", "ㄋㄧㄎㄠ"] {
            let offered = ZhuyinPhrases.bundled.matches(ZhuyinPhrasesTests.buffer(typed))
            XCTAssertTrue(offered.contains { $0.phrase == "你好" }, "\(typed): \(offered.prefix(8))")
        }
        let slipped = ZhuyinPhrases.bundled.matches(ZhuyinPhrasesTests.buffer("ㄋㄧㄎㄠ"))
        XCTAssertEqual(slipped.first?.phrase, "你好")
    }

    func testTheBundledTableKeepsEveryExactMatchInFront() {
        let typed = ZhuyinPhrasesTests.buffer("ㄌㄧㄏㄠ")
        let exact = ZhuyinPhrases.bundled.matches(typed, fuzzy: false)
        let all = ZhuyinPhrases.bundled.matches(typed)
        XCTAssertEqual(Array(all.prefix(exact.count)), exact)
        XCTAssertTrue(all.dropFirst(exact.count).allSatisfy { $0.errors > 0 })
        XCTAssertEqual(Set(all.map(\.phrase)).count, all.count, "a phrase appears twice")
    }

    func testA模糊音中文IsStill中文() {
        let offered = ZhuyinPhrases.bundled.matches(ZhuyinPhrasesTests.buffer("ㄗㄨㄥㄨㄣˊ"))
        XCTAssertEqual(offered.first?.phrase, "中文")
    }
}

/// The composer on top of forgiving tables: the bar forgives, `best` barely does.
final class ZhuyinFuzzyComposerTests: XCTestCase {
    private func type(_ symbols: String, into composer: inout ZhuyinComposer) {
        for symbol in symbols {
            if let tone = ZhuyinTone.mark(symbol) {
                _ = composer.tone(tone)
            } else {
                _ = composer.symbol(symbol)
            }
        }
    }

    func testTheBarOffers中For宗sReadingAfterTheExactCharacters() {
        var c = ZhuyinComposer(dictionary: .bundled, phrases: .bundled)
        type("ㄗㄨㄥ", into: &c)
        XCTAssertTrue(c.candidates.contains("中"))
        XCTAssertEqual(c.best, "從", "ㄗㄨㄥ is a real reading, so its own top commits")
    }

    func testASyllableNobodyReadsCommitsItsFirstForgivenCharacter() {
        // Before, return committed the raw ㄓㄨㄡ.
        var c = ZhuyinComposer(dictionary: .bundled, phrases: .bundled)
        type("ㄓㄨㄡ", into: &c)
        XCTAssertEqual(c.candidates.first, "中")
        XCTAssertEqual(c.confirm(), .insert("中"))
    }

    func testAMistyped中文CommitsAs中文WhenTheSlipIsNotARealSyllable() {
        var c = ZhuyinComposer(dictionary: .bundled, phrases: .bundled)
        type("ㄓㄨㄡㄨㄣˊ", into: &c)
        XCTAssertEqual(c.candidates.first, "中文")
        XCTAssertEqual(c.confirm(), .insert("中文"))
    }

    func testA模糊音中文IsOfferedFirstButNotCommittedUnasked() {
        // Both syllables are real readings (從, 文), so return commits them as
        // typed; 中文 is the first thing in the bar.
        var c = ZhuyinComposer(dictionary: .bundled, phrases: .bundled)
        type("ㄗㄨㄥㄨㄣˊ", into: &c)
        XCTAssertEqual(c.candidates.first, "中文")
        XCTAssertEqual(c.pick("中文"), .insert("中文"))
    }

    func testCorrectlyTypedTextCommitsExactlyAsBefore() {
        // The sentences that broke when a forgiven phrase was allowed to beat one
        // character per syllable: 他說的人 became 他說到任, 吃飯了麼 吃飯老馬.
        let expected = [
            "ㄊㄚㄕㄨㄛㄉㄜㄖㄣ": "他說的人",
            "ㄉㄜㄖㄣㄏㄣㄉㄨㄛ": "的人很多",
            "ㄔㄈㄢㄌㄜㄇㄚ": "吃飯了麼",
            "ㄨㄛㄕㄊㄞㄨㄢㄖㄣ": "我是台灣人",
        ]
        for (typed, sentence) in expected {
            var c = ZhuyinComposer(dictionary: .bundled, phrases: .bundled)
            type(typed, into: &c)
            XCTAssertEqual(c.best, sentence, typed)
        }
    }

    func testAnExactCoverOfAnyLengthBeatsAForgivenLongerOne() {
        var c = ZhuyinComposer(
            dictionary: ZhuyinDictionary(entries: ["~ㄇㄚ": "媽"]),
            phrases: ZhuyinPhrases(entries: [
                (phrase: "李好嗎", reading: "ㄌㄧˇ ㄏㄠˇ ㄇㄚ˙"),
                (phrase: "你好", reading: "ㄋㄧˇ ㄏㄠˇ"),
            ]))
        type("ㄋㄧㄏㄠㄇㄚ", into: &c)
        XCTAssertEqual(c.candidates.prefix(2), ["你好", "李好嗎"], "the bar forgives")
        XCTAssertEqual(c.best, "你好媽", "return does not")
    }
}

/// What a keystroke costs once the tables are warm. The budget is 8 ms on a
/// phone; the numbers are printed so the log carries them, and the assertion is
/// loose enough for a shared CI runner in a debug build — it is there to catch
/// an order-of-magnitude regression, not to benchmark.
final class ZhuyinFuzzyPerformanceTests: XCTestCase {
    private static let budget = 8.0

    override class func setUp() {
        super.setUp()
        _ = ZhuyinPhrases.bundled.matches(ZhuyinPhrasesTests.buffer("ㄋㄏ"))
        _ = ZhuyinDictionary.bundled.candidates(for: "ㄧ")
    }

    /// Type everything but the last symbol, then time that last keystroke —
    /// `symbol(_:)` including the refresh of the bar — on a fresh copy each time.
    private func timeLastKeystroke(of symbols: String, label: String) {
        var base = ZhuyinComposer(dictionary: .bundled, phrases: .bundled)
        for symbol in symbols.dropLast() { _ = base.symbol(symbol) }
        guard let last = symbols.last else { return }
        let repetitions = 20
        var nanoseconds: UInt64 = 0
        var runs = 0
        measure {
            let start = DispatchTime.now().uptimeNanoseconds
            for _ in 0..<repetitions {
                var composer = base
                _ = composer.symbol(last)
            }
            nanoseconds += DispatchTime.now().uptimeNanoseconds - start
            runs += repetitions
        }
        let perKeystroke = Double(nanoseconds) / Double(runs) / 1_000_000
        var after = base
        _ = after.symbol(last)
        print(
            String(
                format: "[zhuyin-perf] %@ (%d pending, %d candidates): %.3f ms per keystroke",
                label, after.syllables.count, after.candidates.count, perKeystroke))
        XCTAssertLessThan(perKeystroke, Self.budget * 4, label)
    }

    func testOneSyllable() {
        timeLastKeystroke(of: "ㄓㄣ", label: "1 syllable")
    }

    func testTwoSyllables() {
        timeLastKeystroke(of: "ㄓㄣㄗㄥ", label: "2 syllables")
    }

    func testTwoLoneInitials() {
        // The widest fan-out: two bare 聲母 with seven alternatives between them
        // and a sparse bucket of their own.
        timeLastKeystroke(of: "ㄖㄑ", label: "2 lone initials")
    }

    func testSixSyllables() {
        // Every initial and final here has a 模糊音 partner and adjacent keys.
        timeLastKeystroke(of: "ㄓㄣㄗㄥㄕㄨㄙㄨㄈㄢㄏㄢ", label: "6 syllables")
    }

    func testTheBuiltIndexFootprint() {
        // Approximate: the process's physical footprint (what jetsam counts)
        // before and after building a second, private copy of the index. The
        // class has already built the bundled one, so the allocator reuses the
        // parse's freed buffers and this is close to what the index retains
        // (~3 MB). Measured cold, in a fresh process, the same build costs
        // ~12.6 MB with packed readings against ~15.5 MB with string ones — the
        // difference being the 61,000 reading strings — most of it the file and
        // its split lines, which are freed but whose pages stay.
        let before = Self.footprint()
        let phrases = ZhuyinPhrases(url: ZhuyinPhrases.bundledURL)
        _ = phrases.matches(ZhuyinPhrasesTests.buffer("ㄋㄏ"))
        let after = Self.footprint()
        let megabytes = Double(Int64(after) - Int64(before)) / 1_048_576
        print(String(format: "[zhuyin-mem] built phrase index: +%.1f MB footprint", megabytes))
        XCTAssertLessThan(megabytes, 16)
        withExtendedLifetime(phrases) {}
    }

    static func footprint() -> UInt64 {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(
            MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        return result == KERN_SUCCESS ? info.phys_footprint : 0
    }
}
