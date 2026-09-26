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
