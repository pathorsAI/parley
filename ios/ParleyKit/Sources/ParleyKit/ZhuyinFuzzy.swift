import Foundation

/// "Could the user have meant this symbol instead" — the rules behind a
/// candidate bar that survives one wrong 注音 symbol.
///
/// The owner's report on build 34 was that one wrong symbol emptied the bar while
/// the system keyboard still guessed. Both tables matched exactly, so a syllable
/// nobody pronounces answered nothing, and a mistyped one answered a different
/// word. Two kinds of mistake account for nearly all of it, and they are the two
/// layers here:
///
/// 1. **模糊音** — pairs a Taiwanese speaker genuinely does not distinguish, or
///    was never taught to: ㄣ/ㄥ, the retroflex ㄓㄔㄕ against the flat ㄗㄘㄙ,
///    ㄈ/ㄏ, and ㄌ against both ㄋ and ㄖ. These are listed by hand because they
///    are facts about speech, not about the keyboard. ㄧㄣ/ㄧㄥ needs no entry of
///    its own: the 介音 is its own slot, so it falls out of ㄣ/ㄥ.
/// 2. **Adjacent keys** — the thumb landed one key off. These are computed from
///    `ZhuyinDachen.rows` and `ZhuyinDachen.rowOffsets` rather than written out,
///    so they are whatever the pane actually draws: left and right on the same
///    row, and on the rows above and below every key whose centre is **less than
///    one key pitch** away horizontally. With the pane's stagger (0, ⅓, ⅔, 0) that
///    is always exactly two keys: the one at the same column index, and one
///    staggered neighbour — going down onto a row shifted right, the column
///    before; going down onto the unstaggered fourth row, which steps back left,
///    the column after (and the mirror image going up). Nearest centre first,
///    which is usually the same-index key but not always: `ㄋ` sits a third of a
///    key from `ㄏ` below it and two thirds from `ㄌ`.
///
/// Both layers obey two constraints. A tone mark is never substituted and never
/// substitutes anything — a tone key is not a slip into a symbol slot, and the
/// tone rules stay exact everywhere. And a substitute must belong to the **same
/// slot** as what was typed (a 聲母 for a 聲母, and so on), because anything else
/// is a syllable the model cannot represent: `ㄋ` sits next to `ㄇ` and `ㄎ`, both
/// 聲母, but `ㄧ` sits next to `ㄗ` and `ㄛ`, and neither can replace a 介音.
///
/// At most **one** error per syllable. Two wrong symbols in a syllable is a
/// different syllable, and forgiving it would bury the bar in noise.
public enum ZhuyinFuzzy {
    /// The 模糊音 pairs, both ways round. ㄌ appears twice on purpose; the pairs
    /// are not transitive, so ㄋ and ㄖ are not each other's.
    static let pairs: [(Character, Character)] = [
        ("ㄣ", "ㄥ"), ("ㄓ", "ㄗ"), ("ㄔ", "ㄘ"), ("ㄕ", "ㄙ"), ("ㄈ", "ㄏ"), ("ㄌ", "ㄋ"),
        ("ㄖ", "ㄌ"),
    ]

    /// Every symbol the user might have meant instead of `symbol`: its 模糊音
    /// partners first, then the adjacent keys, deduplicated, each in the same
    /// slot as `symbol`. Empty for a tone mark or anything that is not a symbol.
    public static func alternatives(for symbol: Character) -> [Character] {
        table[symbol]?.all ?? []
    }

    /// Every syllable that differs from `syllable` in exactly **one filled slot**,
    /// by one of that slot's `alternatives`. The tone is untouched and an empty
    /// slot stays empty — a missing symbol is not a wrong one.
    ///
    /// Ordered by layer, then by slot: all the 模糊音 substitutions (聲母, 介音,
    /// 韻母) before any adjacent-key one, because a speaker who merges ㄣ and ㄥ
    /// does it every time and a slip is an accident. Deterministic, so the fuzzy
    /// tail of a candidate row comes out the same on every keystroke.
    public static func variants(of syllable: ZhuyinSyllable) -> [ZhuyinSyllable] {
        var out: [ZhuyinSyllable] = []
        for layer in [\Alternatives.pairs, \Alternatives.adjacent] {
            for slot in [ZhuyinSyllable.Slot.initial, .medial, .final] {
                guard let typed = syllable.symbol(in: slot), let alternatives = table[typed]
                else { continue }
                for alternative in alternatives[keyPath: layer] {
                    var variant = syllable
                    variant.place(alternative)
                    out.append(variant)
                }
            }
        }
        return out
    }

    // MARK: the table

    /// One symbol's alternatives, split by layer. `adjacent` already excludes
    /// anything in `pairs`, so `all` needs no second dedupe.
    struct Alternatives {
        var pairs: [Character] = []
        var adjacent: [Character] = []
        var all: [Character] { pairs + adjacent }
    }

    /// All 37 symbols' alternatives, built once from the pairs and the grid.
    static let table: [Character: Alternatives] = {
        var table: [Character: Alternatives] = [:]
        let symbols = ZhuyinSyllable.initials + ZhuyinSyllable.medials + ZhuyinSyllable.finals
        for symbol in symbols {
            guard let slot = ZhuyinSyllable.slot(of: symbol) else { continue }
            var entry = Alternatives()
            for (a, b) in pairs {
                let partner = a == symbol ? b : b == symbol ? a : nil
                if let partner, ZhuyinSyllable.slot(of: partner) == slot,
                    !entry.pairs.contains(partner)
                {
                    entry.pairs.append(partner)
                }
            }
            for neighbour in adjacentKeys(to: symbol) where neighbour != symbol {
                guard ZhuyinSyllable.slot(of: neighbour) == slot,
                    !entry.pairs.contains(neighbour), !entry.adjacent.contains(neighbour)
                else { continue }
                entry.adjacent.append(neighbour)
            }
            table[symbol] = entry
        }
        return table
    }()

    /// The symbols on the keys touching `symbol`'s key, tone marks filtered out
    /// but slots not yet checked: left, right, then the row above and the row
    /// below, nearest centre first within each.
    static func adjacentKeys(to symbol: Character) -> [Character] {
        guard let key = ZhuyinDachen.key(for: symbol) else { return [] }
        let rows = ZhuyinDachen.rows
        guard let row = rows.firstIndex(where: { $0.contains(key) }),
            let column = rows[row].firstIndex(of: key)
        else { return [] }
        var keys: [Character] = []
        if column > 0 { keys.append(rows[row][column - 1]) }
        if column + 1 < rows[row].count { keys.append(rows[row][column + 1]) }
        let centre = Double(column) + ZhuyinDachen.rowOffsets[row]
        for other in [row - 1, row + 1] where rows.indices.contains(other) {
            var touching: [(distance: Double, key: Character)] = []
            for (index, key) in rows[other].enumerated() {
                let distance = abs(Double(index) + ZhuyinDachen.rowOffsets[other] - centre)
                if distance < 1 { touching.append((distance, key)) }
            }
            // With this stagger two touching keys are a third and two thirds
            // away, never tied, so the order is fully determined.
            keys += touching.sorted { $0.distance < $1.distance }.map(\.key)
        }
        return keys.compactMap { key in
            guard let typed = ZhuyinDachen.symbol(for: key), ZhuyinTone.mark(typed) == nil
            else { return nil }
            return typed
        }
    }
}

extension ZhuyinSyllable {
    /// The symbol in one slot. For the rules that walk a syllable slot by slot.
    func symbol(in slot: Slot) -> Character? {
        switch slot {
        case .initial: return initial
        case .medial: return medial
        case .final: return final
        }
    }
}
