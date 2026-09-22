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
