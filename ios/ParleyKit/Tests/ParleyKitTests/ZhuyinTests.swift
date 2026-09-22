import XCTest

@testable import ParleyKit

/// The 大千 table. It is a fixed layout with one honest way to be wrong — a
/// transposed pair — so the tests are about coverage and about the two halves of
/// the table agreeing with each other.
final class ZhuyinDachenTests: XCTestCase {
    func testEveryKeyOnTheBlockTypesSomething() {
        // 37 bopomofo symbols + 4 tone marks = 41 keys, which is why the top row
        // is eleven wide.
        let keys = ZhuyinDachen.rows.flatMap { $0 }
        XCTAssertEqual(keys.count, 41)
        XCTAssertEqual(Set(keys).count, 41, "a key appears on two rows")
        for key in keys {
            XCTAssertNotNil(ZhuyinDachen.symbol(for: key), "\(key) types nothing")
        }
        XCTAssertEqual(ZhuyinDachen.symbols.count, 41)
    }

    func testTheBlockCoversTheWholeAlphabet() {
        let typed = Set(ZhuyinDachen.symbols.values)
        let expected = Set(
            ZhuyinSyllable.initials + ZhuyinSyllable.medials + ZhuyinSyllable.finals
                + "ˊˇˋ˙")
        XCTAssertEqual(typed, expected)
    }

    func testTheStandardPositions() {
        // Spot checks against the layout printed on a Taiwanese keyboard, `ㄦ`
        // on the hyphen included — the key a 4×10 grid would have to drop.
        XCTAssertEqual(ZhuyinDachen.symbol(for: "1"), "ㄅ")
        XCTAssertEqual(ZhuyinDachen.symbol(for: "2"), "ㄉ")
        XCTAssertEqual(ZhuyinDachen.symbol(for: "5"), "ㄓ")
        XCTAssertEqual(ZhuyinDachen.symbol(for: "-"), "ㄦ")
        XCTAssertEqual(ZhuyinDachen.symbol(for: "u"), "ㄧ")
        XCTAssertEqual(ZhuyinDachen.symbol(for: "j"), "ㄨ")
        XCTAssertEqual(ZhuyinDachen.symbol(for: "m"), "ㄩ")
        XCTAssertEqual(ZhuyinDachen.symbol(for: "k"), "ㄜ")
        XCTAssertEqual(ZhuyinDachen.symbol(for: ";"), "ㄤ")
        XCTAssertEqual(ZhuyinDachen.symbol(for: "/"), "ㄥ")
        // The tone marks, which is where the layout surprises people: `3` is the
        // third tone but `4` is the fourth and `6` is the second.
        XCTAssertEqual(ZhuyinDachen.symbol(for: "3"), "ˇ")
        XCTAssertEqual(ZhuyinDachen.symbol(for: "4"), "ˋ")
        XCTAssertEqual(ZhuyinDachen.symbol(for: "6"), "ˊ")
        XCTAssertEqual(ZhuyinDachen.symbol(for: "7"), "˙")
    }

    func testTheReverseLookupAgrees() {
        for (key, symbol) in ZhuyinDachen.symbols {
            XCTAssertEqual(ZhuyinDachen.key(for: symbol), key)
        }
    }

    func testAHardwareKeyboardsShiftedLettersStillType() {
        XCTAssertEqual(ZhuyinDachen.symbol(for: "U"), "ㄧ")
        XCTAssertNil(ZhuyinDachen.symbol(for: "="))
    }

    func testTypingTheClassicSyllable() {
        // 「的」= ㄉㄜ˙ = keys 2, k, 7. McBopomofo's own data carries this
        // keystroke column, which is what this table was checked against.
        var syllable = ZhuyinSyllable()
        for key in "2k" {
            guard let symbol = ZhuyinDachen.symbol(for: key) else { return XCTFail("\(key)") }
            XCTAssertTrue(syllable.place(symbol))
        }
        syllable.tone = ZhuyinTone.mark(ZhuyinDachen.symbol(for: "7")!)
        XCTAssertEqual(syllable.text, "ㄉㄜ˙")
    }
}

/// The syllable model. Its whole job is to make an impossible reading
/// unrepresentable, so most of these tests are about what it refuses.
final class ZhuyinSyllableTests: XCTestCase {
    func testSlots() {
        XCTAssertEqual(ZhuyinSyllable.slot(of: "ㄅ"), .initial)
        XCTAssertEqual(ZhuyinSyllable.slot(of: "ㄧ"), .medial)
        XCTAssertEqual(ZhuyinSyllable.slot(of: "ㄥ"), .final)
        XCTAssertEqual(ZhuyinSyllable.slot(of: "ㄦ"), .final)
        XCTAssertNil(ZhuyinSyllable.slot(of: "ˊ"), "a tone is not a slot")
        XCTAssertNil(ZhuyinSyllable.slot(of: "a"))
    }

    func testASymbolReplacesWhateverIsInItsSlot() {
        var s = ZhuyinSyllable()
        s.place("ㄅ")
        s.place("ㄆ")
        XCTAssertEqual(s.text, "ㄆ", "two 聲母 cannot both be there")
        s.place("ㄧ")
        s.place("ㄨ")
        s.place("ㄥ")
        XCTAssertEqual(s.text, "ㄆㄨㄥ")
    }

    func testOrderIsTheSlotsRatherThanTheTypingOrder() {
        var s = ZhuyinSyllable()
        s.place("ㄥ")
        s.place("ㄨ")
        s.place("ㄆ")
        XCTAssertEqual(s.text, "ㄆㄨㄥ")
    }

    func testPlaceRefusesTonesAndStrays() {
        var s = ZhuyinSyllable()
        XCTAssertFalse(s.place("ˊ"))
        XCTAssertFalse(s.place("x"))
        XCTAssertTrue(s.isEmpty)
    }

    func testToneIsWrittenLast() {
        var s = ZhuyinSyllable()
        s.place("ㄨ")
        s.place("ㄛ")
        s.tone = .third
        XCTAssertEqual(s.text, "ㄨㄛˇ")
        s.tone = .first
        XCTAssertEqual(s.text, "ㄨㄛ", "the first tone has no mark")
    }

    func testDeleteWalksBackTheWayItWasBuilt() {
        var s = ZhuyinSyllable(initial: "ㄅ", medial: "ㄨ", final: "ㄥ", tone: .second)
        XCTAssertTrue(s.removeLast())
        XCTAssertEqual(s.text, "ㄅㄨㄥ")
        XCTAssertTrue(s.removeLast())
        XCTAssertEqual(s.text, "ㄅㄨ")
        XCTAssertTrue(s.removeLast())
        XCTAssertEqual(s.text, "ㄅ")
        XCTAssertTrue(s.removeLast())
        XCTAssertTrue(s.isEmpty)
        XCTAssertFalse(s.removeLast(), "nothing left is delete's cue to reach the document")
    }

    func testPronounceable() {
        XCTAssertTrue(ZhuyinSyllable(initial: "ㄉ", final: "ㄜ").isPronounceable)
        XCTAssertTrue(ZhuyinSyllable(final: "ㄦ").isPronounceable)
        XCTAssertTrue(ZhuyinSyllable(medial: "ㄧ").isPronounceable)
        // The seven that stand alone: 知 吃 詩 日 資 詞 思.
        for initial in ZhuyinSyllable.standalone {
            XCTAssertTrue(ZhuyinSyllable(initial: initial).isPronounceable, "\(initial)")
        }
        XCTAssertFalse(ZhuyinSyllable(initial: "ㄅ").isPronounceable, "ㄅ needs a vowel")
        XCTAssertFalse(ZhuyinSyllable().isPronounceable)
    }

    func testParsingAReading() {
        XCTAssertEqual(
            ZhuyinSyllable.parse("ㄅㄨㄥˊ"),
            ZhuyinSyllable(initial: "ㄅ", medial: "ㄨ", final: "ㄥ", tone: .second))
        XCTAssertEqual(
            ZhuyinSyllable.parse("ㄉㄜ˙"),
            ZhuyinSyllable(initial: "ㄉ", final: "ㄜ", tone: .neutral))
        // No mark means the first tone, not an unfinished syllable — that is
        // what the mark's absence means in the dictionary data.
        XCTAssertEqual(ZhuyinSyllable.parse("ㄍㄨㄥ")?.tone, .first)
        XCTAssertEqual(ZhuyinSyllable.parse("ㄓ"), ZhuyinSyllable(initial: "ㄓ", tone: .first))
    }

    func testParsingRefusesEverythingElse() {
        for invalid in [
            "",  // nothing
            "ˊ",  // a bare tone
            "ㄅㄆ",  // two 聲母
            "ㄧㄩ",  // two 介音
            "ㄚㄅ",  // slots out of order
            "ㄨㄛˇˋ",  // two tones
            "ㄉㄜ˙ㄅ",  // something after the tone
            "ㄅㄨㄥx",  // a stray character
            "de",
        ] {
            XCTAssertNil(ZhuyinSyllable.parse(invalid), "accepted \"\(invalid)\"")
        }
    }

    func testParsingRoundTripsEveryReadingInTheBundledDictionary() {
        // The strongest available check on the model: ~1,400 real readings, none
        // of which may fall outside what the keyboard can type.
        let keys = Self.bundledReadings()
        XCTAssertGreaterThan(keys.count, 1000, "the resource didn't load")
        var toneless = 0
        for key in keys {
            // A `~` key is the toneless lookup, not a reading. Its remainder is
            // one — and must carry no tone mark, which `parse` reports as the
            // first tone. A `~` row keyed with a mark would be unreachable.
            let reading = key.hasPrefix("~") ? String(key.dropFirst()) : key
            if key.hasPrefix("~") { toneless += 1 }
            guard let syllable = ZhuyinSyllable.parse(reading) else {
                XCTFail("cannot parse \"\(key)\"")
                continue
            }
            XCTAssertEqual(syllable.text, reading)
            XCTAssertTrue(syllable.isPronounceable || !syllable.isEmpty, "\(key)")
            if key.hasPrefix("~") {
                XCTAssertEqual(syllable.tone, .first, "\(key) is keyed with a tone")
            }
        }
        XCTAssertGreaterThan(toneless, 300, "the resource has no toneless rows")
    }

    static func bundledReadings() -> [String] {
        guard let url = ZhuyinDictionary.bundledURL,
            let text = try? String(contentsOf: url, encoding: .utf8)
        else { return [] }
        return text.split(separator: "\n")
            .filter { !$0.hasPrefix("#") }
            .compactMap { $0.split(separator: "\t").first.map(String.init) }
    }
}

final class ZhuyinDictionaryTests: XCTestCase {
    /// A hand-written stand-in, so ordering is asserted against something this
    /// file controls rather than against whatever the corpus currently says.
    private let fixture = ZhuyinDictionary(entries: [
        "ㄉㄜ˙": "的得地",
        "ㄨㄛˇ": "我婐",
        "ㄕˋ": "是事",
        "~ㄉㄜ": "的得地德",
    ])

    func testCandidatesComeBackInFileOrder() {
        XCTAssertEqual(fixture.candidates(for: "ㄉㄜ˙"), ["的", "得", "地"])
        XCTAssertEqual(fixture.top(for: ZhuyinSyllable.parse("ㄨㄛˇ")!), "我")
    }

    func testTonelessCandidatesIgnoreTheTone() {
        // Built from the slots, so a syllable that already carries a tone still
        // answers the toneless row — re-toning is allowed, and the question
        // "what could this still become" has to survive it.
        XCTAssertEqual(
            fixture.tonelessCandidates(for: ZhuyinSyllable(initial: "ㄉ", final: "ㄜ")),
            ["的", "得", "地", "德"])
        XCTAssertEqual(
            fixture.tonelessCandidates(
                for: ZhuyinSyllable(initial: "ㄉ", final: "ㄜ", tone: .neutral)),
            ["的", "得", "地", "德"])
        XCTAssertEqual(fixture.tonelessCandidates(for: ZhuyinSyllable()), [])
        XCTAssertEqual(
            fixture.tonelessCandidates(for: ZhuyinSyllable(initial: "ㄍ", medial: "ㄧ")), [])
    }

    func testAnUnknownReadingHasNoCandidates() {
        XCTAssertEqual(fixture.candidates(for: "ㄍㄧ"), [])
        XCTAssertEqual(fixture.candidates(for: ""), [])
    }

    func testAMissingResourceIsSilentRatherThanFatal() {
        // A keyboard extension that crashed because a file moved would be far
        // worse than one that offers no candidates.
        let missing = ZhuyinDictionary(url: nil)
        XCTAssertEqual(missing.candidates(for: "ㄉㄜ˙"), [])
    }

    // MARK: the bundled resource

    func testTheBundledDictionaryAnswersCommonSyllables() {
        let expected = [
            "ㄉㄜ˙": "的",
            "ㄨㄛˇ": "我",
            "ㄕˋ": "是",
            "ㄅㄨˋ": "不",
            "ㄧ": "一",
            "ㄖㄣˊ": "人",
            "ㄩˇ": "與",
        ]
        for (reading, top) in expected {
            let candidates = ZhuyinDictionary.bundled.candidates(for: reading)
            XCTAssertFalse(candidates.isEmpty, "\(reading) has no candidates")
            XCTAssertEqual(candidates.first, top, "\(reading)")
        }
    }

    func testTheBundledDictionaryAnswersTonelessSyllables() {
        // 你好 typed with no tone key at all — the sequence the pane has to
        // convert, and the reason the `~` rows exist.
        let ni = ZhuyinDictionary.bundled.tonelessCandidates(
            for: ZhuyinSyllable(initial: "ㄋ", medial: "ㄧ"))
        let hao = ZhuyinDictionary.bundled.tonelessCandidates(
            for: ZhuyinSyllable(initial: "ㄏ", final: "ㄠ"))
        XCTAssertEqual(ni.first, "你")
        XCTAssertEqual(hao.first, "好")
        // The union of the five tone rows, so it is longer than any one of them.
        XCTAssertGreaterThan(ni.count, ZhuyinDictionary.bundled.candidates(for: "ㄋㄧˇ").count)
        XCTAssertEqual(Set(ni).count, ni.count, "a character appears twice")
    }

    func testTheBundledDictionaryIsSplitIntoWholeCharacters() {
        // Rows are stored with no separator because every character in the
        // source is one Unicode scalar — including the ones outside the BMP,
        // which is where 𰻞 and friends live. If that ever stopped being true
        // the candidates would silently come apart.
        for reading in ZhuyinSyllableTests.bundledReadings() {
            for candidate in ZhuyinDictionary.bundled.candidates(for: reading) {
                XCTAssertEqual(candidate.unicodeScalars.count, 1, "\(reading) → \(candidate)")
            }
        }
    }
}

/// The composer: what a sequence of taps does to the buffer and to the document.
final class ZhuyinComposerTests: XCTestCase {
    /// A hand-written stand-in, toneless `~` rows included, so the ordering the
    /// assertions rely on is this file's rather than the corpus's.
    private func composer() -> ZhuyinComposer {
        ZhuyinComposer(
            dictionary: ZhuyinDictionary(entries: [
                "ㄉㄜ˙": "的得地",
                "ㄨㄛˇ": "我婐",
                "ㄇㄣ˙": "們",
                "ㄕˊ": "十時實",
                "ㄕˋ": "是事",
                "ㄏㄠˇ": "好郝",
                "~ㄉㄜ": "的得地德",
                "~ㄨㄛ": "我窩",
                "~ㄇㄣ": "們悶",
                "~ㄋㄧ": "你尼",
                "~ㄏㄠ": "好號",
                "~ㄏ": "厂",
                "~ㄅ": "不把",
                "~ㄆ": "怕拍",
            ]))
    }

    func testSymbolsAccumulateWithoutTouchingTheDocument() {
        var c = composer()
        XCTAssertEqual(c.stage, .idle)
        XCTAssertEqual(c.symbol("ㄉ"), .handled)
        XCTAssertEqual(c.symbol("ㄜ"), .handled)
        XCTAssertEqual(c.stage, .composing)
        XCTAssertEqual(c.reading, "ㄉㄜ")
        XCTAssertEqual(c.syllables.count, 1)
        XCTAssertEqual(c.candidates, ["的", "得", "地", "德"], "the toneless bar")
    }

    func testAToneFinalizesAndProducesCandidates() {
        var c = composer()
        _ = c.symbol("ㄉ")
        _ = c.symbol("ㄜ")
        XCTAssertEqual(c.tone(.neutral), .handled)
        XCTAssertEqual(c.stage, .choosing)
        XCTAssertEqual(c.reading, "ㄉㄜ˙")
        XCTAssertEqual(c.candidates, ["的", "得", "地"], "narrowed to the toned row")
        XCTAssertEqual(c.best, "的")
    }

    // MARK: typing without tones

    func testAWholeWordTypesWithoutASingleToneKey() {
        // The bug this buffer exists for: ㄋㄧ then ㄏ used to overwrite the
        // 聲母 and leave ㄏㄧ. The system keyboard segments instead, and shows
        // the segments space-separated.
        var c = ZhuyinComposer(dictionary: .bundled)
        for symbol in "ㄋㄧㄏㄠ" {
            XCTAssertEqual(c.symbol(symbol), .handled, "\(symbol)")
        }
        XCTAssertEqual(c.syllables.count, 2)
        XCTAssertEqual(c.reading, "ㄋㄧ ㄏㄠ")
        XCTAssertEqual(c.stage, .composing)
        XCTAssertEqual(c.candidates.first, "你", "the bar answers the first syllable")
        XCTAssertEqual(c.best, "你好")
        XCTAssertEqual(c.confirm(), .insert("你好"))
        XCTAssertEqual(c.stage, .idle)
    }

    func testASymbolWhoseSlotIsTakenStartsTheNextSyllable() {
        var c = composer()
        XCTAssertEqual(c.symbol("ㄅ"), .handled)
        XCTAssertEqual(c.symbol("ㄆ"), .handled)
        XCTAssertEqual(c.syllables.count, 2, "two 聲母 cannot share a syllable")
        XCTAssertEqual(c.reading, "ㄅ ㄆ")
    }

    func testAnInitialAfterAFinalStartsTheNextSyllable() {
        var c = composer()
        _ = c.symbol("ㄉ")
        _ = c.symbol("ㄜ")
        XCTAssertEqual(c.symbol("ㄇ"), .handled)
        XCTAssertEqual(c.syllables.count, 2, "a 聲母 can only begin a syllable")
        XCTAssertEqual(c.reading, "ㄉㄜ ㄇ")
        // Same rule one slot up: a 介音 after a 韻母 is the next syllable too.
        _ = c.symbol("ㄣ")
        XCTAssertEqual(c.symbol("ㄧ"), .handled)
        XCTAssertEqual(c.reading, "ㄉㄜ ㄇㄣ ㄧ")
    }

    func testAToneAppliesToTheLastSyllableWhileTheBarShowsTheFirst() {
        var c = composer()
        for symbol in "ㄋㄧㄏㄠ" { _ = c.symbol(symbol) }
        XCTAssertEqual(c.tone(.third), .handled)
        XCTAssertEqual(c.reading, "ㄋㄧ ㄏㄠˇ", "the tone lands on what is being typed")
        XCTAssertEqual(c.stage, .choosing)
        XCTAssertEqual(c.candidates, ["你", "尼"], "the bar is still the first syllable")
    }

    func testDeleteWalksBackAcrossASyllableBoundary() {
        var c = composer()
        for symbol in "ㄋㄧㄏ" { _ = c.symbol(symbol) }
        XCTAssertEqual(c.reading, "ㄋㄧ ㄏ")
        XCTAssertEqual(c.delete(), .handled)
        XCTAssertEqual(c.reading, "ㄋㄧ", "an emptied syllable leaves the buffer")
        XCTAssertEqual(c.syllables.count, 1)
    }

    func testPickCommitsTheFirstSyllableAndLeavesTheRest() {
        var c = composer()
        for symbol in "ㄋㄧㄏㄠ" { _ = c.symbol(symbol) }
        XCTAssertEqual(c.pick("妳"), .insert("妳"))
        XCTAssertEqual(c.syllables.count, 1, "the rest stays pending")
        XCTAssertEqual(c.reading, "ㄏㄠ")
        XCTAssertEqual(c.candidates, ["好", "號"], "the bar moves on")
        XCTAssertEqual(c.pick("好"), .insert("好"))
        XCTAssertEqual(c.stage, .idle)
    }

    func testOverflowingTheBufferCommitsTheOldestSyllable() {
        // Six is a keyboard's worth of pending state, not a feature. Past it the
        // user is still typing rather than choosing, so the best guess is the
        // only answer available.
        var c = composer()
        for _ in 0..<ZhuyinComposer.maxPending {
            XCTAssertEqual(c.symbol("ㄅ"), .handled)
        }
        XCTAssertEqual(c.syllables.count, ZhuyinComposer.maxPending)
        XCTAssertEqual(c.symbol("ㄅ"), .insert("不"))
        XCTAssertEqual(
            c.syllables.count, ZhuyinComposer.maxPending, "the new syllable still arrived")
    }

    // MARK: space, delete, confirm

    func testSpaceIsTheFirstToneAndThenTheConfirmKey() {
        var c = composer()
        _ = c.symbol("ㄨ")
        _ = c.symbol("ㄛ")
        XCTAssertEqual(c.space(), .handled, "the first tone has no key of its own")
        XCTAssertEqual(c.reading, "ㄨㄛ")
        _ = c.tone(.third)
        XCTAssertEqual(c.space(), .insert("我"))
        XCTAssertEqual(c.stage, .idle)
    }

    func testSpaceOnATonedSyllableCommitsTheWholeBuffer() {
        var c = composer()
        for symbol in "ㄋㄧㄏㄠ" { _ = c.symbol(symbol) }
        _ = c.tone(.third)
        // `best` mixes the two lookups: the untoned ㄋㄧ answers its `~` row and
        // the toned ㄏㄠˇ answers its own.
        XCTAssertEqual(c.space(), .insert("你好"), "confirm takes everything pending")
        XCTAssertEqual(c.stage, .idle)
    }

    func testSpaceWithNothingPendingIsJustASpace() {
        var c = composer()
        XCTAssertEqual(c.space(), .passThrough)
    }

    func testStartingTheNextSyllableJoinsTheBufferRatherThanCommitting() {
        // This used to auto-commit, which is what forced a tone after every
        // character. Now the syllables queue up and one confirm takes them all.
        var c = composer()
        _ = c.symbol("ㄨ")
        _ = c.symbol("ㄛ")
        _ = c.tone(.third)
        XCTAssertEqual(c.symbol("ㄇ"), .handled)
        XCTAssertEqual(c.reading, "ㄨㄛˇ ㄇ", "the new symbol starts the next syllable")
        _ = c.symbol("ㄣ")
        _ = c.tone(.neutral)
        XCTAssertEqual(c.space(), .insert("我們"))
    }

    func testPickingACandidateCommitsIt() {
        var c = composer()
        _ = c.symbol("ㄉ")
        _ = c.symbol("ㄜ")
        _ = c.tone(.neutral)
        XCTAssertEqual(c.pick("地"), .insert("地"))
        XCTAssertEqual(c.stage, .idle)
        XCTAssertTrue(c.candidates.isEmpty)
    }

    func testARetypedToneRequeries() {
        // 「ㄕˋ」when you meant 「ㄕˊ」 is the mistake everyone makes, and a second
        // tone key is a cheaper fix than delete-and-retype.
        var c = composer()
        _ = c.symbol("ㄕ")
        _ = c.tone(.fourth)
        XCTAssertEqual(c.candidates, ["是", "事"])
        _ = c.tone(.second)
        XCTAssertEqual(c.candidates, ["十", "時", "實"])
        XCTAssertEqual(c.reading, "ㄕˊ")
    }

    func testAToneOnAnEmptyBufferDoesNothing() {
        var c = composer()
        XCTAssertEqual(c.tone(.second), .passThrough)
        XCTAssertEqual(c.stage, .idle)
    }

    func testDeleteEditsTheBufferBeforeItEditsTheDocument() {
        var c = composer()
        _ = c.symbol("ㄉ")
        _ = c.symbol("ㄜ")
        _ = c.tone(.neutral)
        XCTAssertEqual(c.delete(), .handled)
        XCTAssertEqual(c.stage, .composing, "delete clears the tone first")
        XCTAssertEqual(c.reading, "ㄉㄜ")
        XCTAssertEqual(c.delete(), .handled)
        XCTAssertEqual(c.reading, "ㄉ")
        XCTAssertEqual(c.delete(), .handled)
        XCTAssertEqual(c.stage, .idle)
        XCTAssertEqual(c.delete(), .passThrough, "only now does it reach the field")
    }

    func testConfirmCommitsARawReadingRatherThanEatingIt() {
        var c = composer()
        _ = c.symbol("ㄍ")
        _ = c.symbol("ㄧ")
        _ = c.tone(.first)
        XCTAssertTrue(c.candidates.isEmpty, "nothing reads ㄍㄧ")
        XCTAssertEqual(c.confirm(), .insert("ㄍㄧ"))
    }

    func testConfirmWithNothingPendingLetsReturnBeReturn() {
        var c = composer()
        XCTAssertEqual(c.confirm(), .passThrough)
    }

    func testClearDropsEverythingSilently() {
        var c = composer()
        _ = c.symbol("ㄉ")
        _ = c.symbol("ㄜ")
        _ = c.tone(.neutral)
        c.clear()
        XCTAssertEqual(c.stage, .idle)
        XCTAssertEqual(c.reading, "")
        XCTAssertTrue(c.syllables.isEmpty)
        XCTAssertTrue(c.candidates.isEmpty)
    }

    func testANonSymbolKeyFallsThrough() {
        var c = composer()
        XCTAssertEqual(c.symbol("a"), .passThrough)
        XCTAssertEqual(c.symbol("ˊ"), .passThrough, "tones go through tone()")
    }

    /// The whole of 「我們」 through the keys a user would actually press.
    func testTypingAWordThroughTheDachenKeys() {
        var c = composer()
        var typed = ""
        // 我 = ㄨㄛˇ = j i 3, 們 = ㄇㄣ˙ = a p 7, then space to take both.
        for key in "ji3ap7 " {
            var outcome = ZhuyinComposer.Outcome.passThrough
            if key == " " {
                outcome = c.space()
            } else if let symbol = ZhuyinDachen.symbol(for: key) {
                if let tone = ZhuyinTone.mark(symbol) {
                    outcome = c.tone(tone)
                } else {
                    outcome = c.symbol(symbol)
                }
            }
            if case .insert(let text) = outcome { typed += text }
        }
        XCTAssertEqual(typed, "我們")
        XCTAssertEqual(c.stage, .idle)
    }
}

/// The phrase table: what a part-typed buffer could still become, which is the
/// whole of prediction. Fixtures for the rules, the bundled resource for the
/// claims about the data.
final class ZhuyinPhrasesTests: XCTestCase {
    /// Hand-written so the order the assertions rely on is this file's rather
    /// than the corpus's, and spelled the way the resource spells a reading.
    private let fixture = ZhuyinPhrases(entries: [
        (phrase: "你好", reading: "ㄋㄧˇ ㄏㄠˇ"),
        (phrase: "逆號", reading: "ㄋㄧˋ ㄏㄠˋ"),
        (phrase: "年會", reading: "ㄋㄧㄢˊ ㄏㄨㄟˋ"),
        (phrase: "你好嗎", reading: "ㄋㄧˇ ㄏㄠˇ ㄇㄚ˙"),
        (phrase: "很有意", reading: "ㄏㄣˇ ㄧㄡˇ ㄧˋ"),
        (phrase: "很有力", reading: "ㄏㄣˇ ㄧㄡˇ ㄌㄧˋ"),
    ])

    /// The buffer a user typing these keys would have. Built by typing rather
    /// than by `parse`, because a syllable nobody has toned has `tone == nil`
    /// and `parse` would read it as the first tone.
    static func buffer(_ symbols: String) -> [ZhuyinSyllable] {
        var composer = ZhuyinComposer(dictionary: ZhuyinDictionary(entries: [:]))
        for symbol in symbols {
            if let tone = ZhuyinTone.mark(symbol) {
                _ = composer.tone(tone)
            } else {
                _ = composer.symbol(symbol)
            }
        }
        return composer.syllables
    }

    func testTwoLoneInitialsAlreadyPredict() {
        // The product's own acceptance test, in miniature: nothing is finished,
        // no tone has been pressed, and the table still has an answer. Exact
        // matches first, then the longer one — the prediction.
        XCTAssertEqual(
            fixture.matches(Self.buffer("ㄋㄏ")).map(\.phrase),
            ["你好", "逆號", "年會", "你好嗎"])
    }

    func testAFilledSlotMustAgreeWhileTheRestIsAWildcard() {
        // A 韻母 the user has not typed is a wildcard, so ㄋㄧ is still both 你
        // (ㄋㄧˇ) and 年 (ㄋㄧㄢˊ).
        XCTAssertEqual(
            fixture.matches(Self.buffer("ㄋㄧㄏ")).map(\.phrase),
            ["你好", "逆號", "年會", "你好嗎"])
        // Typing the ㄢ settles it, and settles it both ways: 年會 stays and the
        // entries whose syllable ends at ㄋㄧ are gone.
        XCTAssertEqual(
            fixture.matches(Self.buffer("ㄋㄧㄢㄏ")).map(\.phrase), ["年會"])
    }

    func testATypedToneMustMatchWhileAnUntypedOneIsAWildcard() {
        XCTAssertEqual(
            fixture.matches(Self.buffer("ㄋㄧㄏㄠ")).map(\.phrase),
            ["你好", "逆號", "你好嗎"])
        // 逆號 is ㄋㄧˋ ㄏㄠˋ: the same slots as 你好 and different tones, so it
        // is exactly what typing the tones has to remove.
        XCTAssertEqual(
            fixture.matches(Self.buffer("ㄋㄧˇㄏㄠˇ")).map(\.phrase),
            ["你好", "你好嗎"])
    }

    func testASyllableWithNoInitialDoesNotMatchOneThatHasIt() {
        // The third syllable is a bare 介音: `ㄧ` has no 聲母 at all, so an entry
        // whose syllable is ㄌㄧˋ cannot be what the user is typing. Equal
        // *including nil* is the rule; a slot is only a wildcard once it is past
        // the last one they filled.
        XCTAssertEqual(
            fixture.matches(Self.buffer("ㄏㄣㄧㄡㄧ")).map(\.phrase), ["很有意"])
    }

    func testAPhraseShorterThanTheBufferCoversItsFront() {
        // Typed ahead of the word: the exact-length match comes first, then the
        // ones that answer only the front of the buffer.
        XCTAssertEqual(
            fixture.matches(Self.buffer("ㄋㄧㄏㄠㄇㄚ")).map(\.phrase),
            ["你好嗎", "你好", "逆號"])
    }

    func testTheSpanIsTheCharacterCount() {
        let matches = fixture.matches(Self.buffer("ㄋㄏ"))
        for match in matches {
            XCTAssertEqual(match.span, match.phrase.unicodeScalars.count, match.phrase)
        }
        XCTAssertEqual(matches.first { $0.phrase == "你好嗎" }?.span, 3)
    }

    func testOneSyllableIsTheDictionarysQuestionRatherThanThisOne() {
        XCTAssertTrue(fixture.matches(Self.buffer("ㄋ")).isEmpty)
        XCTAssertTrue(fixture.matches([]).isEmpty)
    }

    func testTheBarIsCapped() {
        // A bucket can hold thousands; past forty the user retypes faster than
        // they read.
        let many = ZhuyinPhrases(
            entries: (0..<(ZhuyinPhrases.matchLimit + 20)).map {
                (phrase: "\(Character(UnicodeScalar(0x4E00 + $0)!))好", reading: "ㄘˊ ㄏㄠˇ")
            })
        XCTAssertEqual(many.matches(Self.buffer("ㄘㄏ")).count, ZhuyinPhrases.matchLimit)
    }

    func testAMissingResourceIsSilentRatherThanFatal() {
        let missing = ZhuyinPhrases(url: nil)
        XCTAssertTrue(missing.matches(Self.buffer("ㄋㄏ")).isEmpty)
    }

    // MARK: the bundled resource

    func testTheBundledTableAnswersTwoLoneInitials() {
        let phrases = ZhuyinPhrases.bundled.matches(Self.buffer("ㄋㄏ")).map(\.phrase)
        XCTAssertFalse(phrases.isEmpty, "the resource didn't load")
        guard let rank = phrases.firstIndex(of: "你好") else {
            return XCTFail("ㄋㄏ does not offer 你好")
        }
        // By raw corpus count 你好 was twelfth here — the corpus is written text,
        // and 女孩, 年後, 男孩, 南韓, 內涵 all outnumber a greeting in the news.
        // The generator's conversational floor and character-frequency term
        // exist so that the owner's own example comes out the way the system
        // keyboard has it: first.
        XCTAssertEqual(rank, 0, "你好 is not first for ㄋㄏ: \(phrases.prefix(6))")
    }

    func testTheBundledTableRanksTheWholeReadingFirst() {
        let matches = ZhuyinPhrases.bundled.matches(Self.buffer("ㄋㄧㄏㄠ"))
        XCTAssertEqual(matches.first?.phrase, "你好")
        // The prediction: a phrase longer than anything typed, offered after the
        // exact-length ones.
        XCTAssertEqual(matches.first { $0.phrase == "你好嗎" }?.span, 3)
    }

    func testTheBundledTableDropsThePhrasesWhoseTonesDisagree() {
        let toneless = ZhuyinPhrases.bundled.matches(Self.buffer("ㄋㄧㄏㄠ")).map(\.phrase)
        let toned = ZhuyinPhrases.bundled.matches(Self.buffer("ㄋㄧˇㄏㄠˇ")).map(\.phrase)
        XCTAssertEqual(toned.first, "你好")
        // 逆號 is ㄋㄧˋ ㄏㄠˋ — the same symbols as 你好 and different tones, so it
        // is offered until the tones are typed and not after.
        XCTAssertTrue(toneless.contains("逆號"))
        XCTAssertFalse(toned.contains("逆號"))
        XCTAssertFalse(toned.contains("年號"))
    }

    func testWarmingOffTheMainThreadYieldsTheSameTable() {
        let cold = ZhuyinPhrases(url: ZhuyinPhrases.bundledURL)
        let warmed = ZhuyinPhrases(url: ZhuyinPhrases.bundledURL)
        XCTAssertFalse(warmed.isWarm)
        warmed.warm()
        let landed = expectation(description: "warm lands on the main queue")
        func poll() {
            if warmed.isWarm { return landed.fulfill() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.02, execute: poll)
        }
        poll()
        wait(for: [landed], timeout: 5)
        XCTAssertEqual(
            warmed.matches(Self.buffer("ㄋㄏ")), cold.matches(Self.buffer("ㄋㄏ")))
    }
}

/// The composer with a phrase table in front of the dictionary. The composer's
/// other tests run without one on purpose: nothing about the per-syllable
/// behaviour may change because this exists.
final class ZhuyinComposerPhraseTests: XCTestCase {
    private func composer() -> ZhuyinComposer {
        ZhuyinComposer(
            dictionary: ZhuyinDictionary(entries: [
                "~ㄋㄧ": "你尼",
                "~ㄏㄠ": "好號",
                "~ㄇㄚ": "嗎媽",
            ]),
            phrases: ZhuyinPhrases(entries: [
                (phrase: "你好", reading: "ㄋㄧˇ ㄏㄠˇ"),
                (phrase: "你好嗎", reading: "ㄋㄧˇ ㄏㄠˇ ㄇㄚ˙"),
            ]))
    }

    func testTheBarOffersPhrasesBeforeSingleCharacters() {
        var c = composer()
        for symbol in "ㄋㄧ" { _ = c.symbol(symbol) }
        XCTAssertEqual(c.candidates, ["你", "尼"], "one syllable is the dictionary's")
        _ = c.symbol("ㄏ")
        XCTAssertEqual(
            c.candidates, ["你好", "你好嗎", "你", "尼"],
            "phrases first, then the first syllable's characters")
    }

    func testPickingAPhraseTakesOneSyllablePerCharacter() {
        var c = composer()
        for symbol in "ㄋㄧㄏㄠㄇㄚ" { _ = c.symbol(symbol) }
        XCTAssertEqual(c.syllables.count, 3)
        XCTAssertEqual(c.pick("你好"), .insert("你好"))
        XCTAssertEqual(c.syllables.count, 1, "two characters took two syllables")
        XCTAssertEqual(c.reading, "ㄇㄚ")
        XCTAssertEqual(c.candidates, ["嗎", "媽"])
    }

    func testPickingAPredictionLongerThanTheBufferClearsIt() {
        var c = composer()
        for symbol in "ㄋㄧㄏㄠ" { _ = c.symbol(symbol) }
        XCTAssertTrue(c.candidates.contains("你好嗎"), "the prediction is offered")
        XCTAssertEqual(c.pick("你好嗎"), .insert("你好嗎"))
        XCTAssertEqual(c.stage, .idle, "a word the user hadn't finished takes the whole buffer")
        XCTAssertTrue(c.candidates.isEmpty)
    }

    func testBestWalksTheBufferGreedily() {
        // 我是台灣人, typed without a single tone key. Greedy left to right: the
        // longest phrase that exactly covers what is in front of it, then one
        // character for what is left.
        var c = ZhuyinComposer(dictionary: .bundled, phrases: ZhuyinPhrases.bundled)
        for symbol in "ㄨㄛㄕㄊㄞㄨㄢㄖㄣ" { _ = c.symbol(symbol) }
        XCTAssertEqual(c.reading, "ㄨㄛ ㄕ ㄊㄞ ㄨㄢ ㄖㄣ")
        XCTAssertEqual(c.best, "我是台灣人")
        XCTAssertTrue(c.best.contains("台灣"), "台灣 is one word, not two guesses")
        XCTAssertEqual(c.confirm(), .insert("我是台灣人"))
    }

    func testTheBundledTablePutsThePhraseAtTheFrontOfTheBar() {
        var c = ZhuyinComposer(dictionary: .bundled, phrases: ZhuyinPhrases.bundled)
        for symbol in "ㄋㄧㄏㄠ" { _ = c.symbol(symbol) }
        XCTAssertEqual(c.candidates.first, "你好")
        // The single characters are still there, after the phrases — nothing the
        // per-syllable bar could do is lost.
        XCTAssertTrue(c.candidates.contains("你"))
    }
}

final class TypingKeyboardsTests: XCTestCase {
    func testTraditionalChineseTurnsZhuyinOnByDefault() {
        for languages in [
            ["zh-Hant"], ["zh-Hant-TW"], ["zh-TW"], ["zh-Hant-HK"], ["zh-MO"],
            ["en-US", "zh-Hant-TW"],
        ] {
            XCTAssertEqual(
                TypingKeyboards.defaultEnabled(preferredLanguages: languages),
                [.english, .zhuyin], "\(languages)")
        }
    }

    func testEverybodyElseGetsEnglishOnly() {
        for languages in [["en-US"], ["ja-JP"], ["zh-Hans-CN"], ["zh-CN"], []] {
            XCTAssertEqual(
                TypingKeyboards.defaultEnabled(preferredLanguages: languages),
                [.english], "\(languages)")
        }
    }
}
