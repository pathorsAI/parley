import Foundation

/// The tones 注音 writes, and the one it doesn't.
///
/// A tone mark is a **suffix** in this project's spelling — `ㄉㄜ˙`, `ㄨㄛˇ` —
/// which is how the dictionary data is keyed, so a syllable's `text` is a
/// dictionary key with no conversion step in between.
public enum ZhuyinTone: String, CaseIterable, Sendable, Hashable {
    /// 一聲, written with no mark at all. 大千 has no key for it either: the
    /// space bar is the first tone, which is why space doubles as "that is the
    /// syllable, show me the characters".
    case first = ""
    case second = "ˊ"
    case third = "ˇ"
    case fourth = "ˋ"
    /// 輕聲.
    case neutral = "˙"

    /// The mark as it appears on a key cap. First tone has no mark, so it
    /// borrows the macron the tone charts use — it is a label, never part of a
    /// reading.
    public var keyCap: String {
        self == .first ? "ˉ" : rawValue
    }

    public static func mark(_ symbol: Character) -> ZhuyinTone? {
        let tone = ZhuyinTone(rawValue: String(symbol))
        // `rawValue: ""` would answer `.first`, and an empty string is not a
        // character — but a non-tone character maps to nil, which is the case
        // this guards.
        return tone == .first ? nil : tone
    }
}

/// One 注音 syllable, as four slots rather than a string of symbols.
///
/// This is the whole reason 傳統注音 typing feels the way it does: a syllable is
/// at most one 聲母, one 介音, one 韻母 and one tone, in that order, so a symbol
/// **replaces** whatever is already in its slot instead of appending. Typing
/// `ㄅㄆ` leaves you with `ㄆ`, not with an impossible pair — which means an
/// out-of-order or doubled sequence is unrepresentable rather than something the
/// composer has to check for after the fact.
///
/// The slots also give delete a definition: it clears the last slot that was
/// filled, so backing out of `ㄅㄨㄥˊ` walks the syllable apart in the order it
/// was built.
public struct ZhuyinSyllable: Equatable, Hashable, Sendable {
    /// 聲母 — 21 of them.
    public static let initials = "ㄅㄆㄇㄈㄉㄊㄋㄌㄍㄎㄏㄐㄑㄒㄓㄔㄕㄖㄗㄘㄙ"
    /// 介音 — 3.
    public static let medials = "ㄧㄨㄩ"
    /// 韻母 — 13, `ㄦ` included.
    public static let finals = "ㄚㄛㄜㄝㄞㄟㄠㄡㄢㄣㄤㄥㄦ"

    /// The seven 聲母 that are complete syllables on their own — 知, 吃, 詩, 日,
    /// 資, 詞, 思. Every other initial needs a vowel after it.
    public static let standalone = "ㄓㄔㄕㄖㄗㄘㄙ"

    /// Which part of a syllable a symbol belongs to. `Comparable` because slot
    /// order *is* 注音 spelling order, which is what makes `parse` a one-pass
    /// check rather than a grammar.
    public enum Slot: Int, Comparable, Sendable {
        case initial
        case medial
        case final

        public static func < (a: Slot, b: Slot) -> Bool { a.rawValue < b.rawValue }
    }

    public var initial: Character?
    public var medial: Character?
    public var final: Character?
    /// `nil` while the syllable is still being typed. Setting it is what turns
    /// a buffer into a reading the dictionary can answer.
    public var tone: ZhuyinTone?

    public init(
        initial: Character? = nil, medial: Character? = nil, final: Character? = nil,
        tone: ZhuyinTone? = nil
    ) {
        self.initial = initial
        self.medial = medial
        self.final = final
        self.tone = tone
    }

    public static func slot(of symbol: Character) -> Slot? {
        if initials.contains(symbol) { return .initial }
        if medials.contains(symbol) { return .medial }
        if finals.contains(symbol) { return .final }
        return nil
    }

    /// No symbols yet. A lone tone can't get here — `place` refuses tones, and
    /// the composer ignores a tone key on an empty buffer.
    public var isEmpty: Bool {
        initial == nil && medial == nil && final == nil
    }

    /// Whether this is a syllable Mandarin actually has *structurally*: a vowel,
    /// or one of the seven initials that stand alone. It is not a claim that the
    /// combination is pronounced — `ㄍㄧ` passes this and no character reads that
    /// way — so the dictionary, not this flag, decides what a reading produces.
    public var isPronounceable: Bool {
        if medial != nil || final != nil { return true }
        guard let initial else { return false }
        return Self.standalone.contains(initial)
    }

    /// Put a symbol in its slot, replacing whatever was there. `false` for
    /// anything that isn't a 注音 symbol (tones included — set `tone`).
    @discardableResult
    public mutating func place(_ symbol: Character) -> Bool {
        switch Self.slot(of: symbol) {
        case .initial: initial = symbol
        case .medial: medial = symbol
        case .final: final = symbol
        case nil: return false
        }
        return true
    }

    /// Clear the last-filled slot, tone first. `false` when there was nothing
    /// left to clear, which is the composer's signal to let delete reach the
    /// document instead.
    @discardableResult
    public mutating func removeLast() -> Bool {
        if tone != nil { tone = nil; return true }
        if final != nil { final = nil; return true }
        if medial != nil { medial = nil; return true }
        if initial != nil { initial = nil; return true }
        return false
    }

    /// The reading as written: symbols in slot order, tone mark last. This is
    /// also the dictionary key.
    public var text: String {
        var out = ""
        if let initial { out.append(initial) }
        if let medial { out.append(medial) }
        if let final { out.append(final) }
        out.append(contentsOf: tone?.rawValue ?? "")
        return out
    }

    /// Read a reading back. `nil` for anything that isn't one — a doubled slot
    /// (`ㄅㄆ`), a slot out of order (`ㄚㄅ`), a tone that isn't last (`ˊㄅ`), a
    /// stray character, or a bare tone.
    ///
    /// A reading with no tone mark is the **first** tone, not an unfinished
    /// syllable: that is what the mark's absence means in the data. So `parse`
    /// always returns a finalized syllable, and `nil`-toned buffers only ever
    /// come from typing.
    public static func parse(_ text: String) -> ZhuyinSyllable? {
        var syllable = ZhuyinSyllable()
        var lastSlot: Slot?
        for symbol in text {
            if let tone = ZhuyinTone.mark(symbol) {
                guard syllable.tone == nil, !syllable.isEmpty else { return nil }
                syllable.tone = tone
                continue
            }
            // Nothing may follow the tone mark, and each slot is filled once.
            guard syllable.tone == nil, let slot = slot(of: symbol) else { return nil }
            if let lastSlot, slot <= lastSlot { return nil }
            syllable.place(symbol)
            lastSlot = slot
        }
        guard !syllable.isEmpty else { return nil }
        if syllable.tone == nil { syllable.tone = .first }
        return syllable
    }
}
