import Foundation

/// The 大千 (Dachen) 注音 layout — the arrangement printed on every keyboard sold
/// in Taiwan, and the one iOS's own 注音 keyboard draws.
///
/// It is written here as **the ASCII keys it lives on** rather than as a grid of
/// bopomofo, for two reasons. It is the layout's actual definition (大千 is a
/// mapping onto a QWERTY board, which is why `ㄦ` is on `-` and not tucked at the
/// end of a row), and it is checkable: McBopomofo's `BPMFBase.txt` carries a
/// 大千 keystroke column beside every reading, so this table was verified
/// against 26,652 of their rows before it was written down.
///
/// The 41 keys are the 37 bopomofo symbols plus the 4 tone marks. That is why
/// the top row is **eleven** keys wide (`1234567890-`) while the rest are ten:
/// dropping to a tidy 4×10 would mean dropping `ㄦ`, and 兒/二/而/耳 are not
/// optional.
public enum ZhuyinDachen {
    /// The rows a keyboard draws, top to bottom, as ASCII keys.
    public static let rows: [[Character]] = [
        Array("1234567890-"),
        Array("qwertyuiop"),
        Array("asdfghjkl;"),
        Array("zxcvbnm,./"),
    ]

    /// How far each row starts to the right of the top row, in key pitches, as
    /// the 注音 pane draws it: a third in, then two thirds, then back to the left
    /// edge for the row that carries delete as its eleventh key. Kept in step with
    /// `KeyboardZhuyinPane.swift` by hand — the pane lives in the app target and
    /// this is the one number it and `ZhuyinFuzzy` must agree on, because which
    /// keys sit above and below which is what a slipping thumb actually hits.
    public static let rowOffsets: [Double] = [0, 1.0 / 3, 2.0 / 3, 0]

    /// Key → what it types. Tone marks are in here too; ask `ZhuyinTone.mark`
    /// which of the two a symbol is.
    public static let symbols: [Character: Character] = [
        "1": "ㄅ", "2": "ㄉ", "3": "ˇ", "4": "ˋ", "5": "ㄓ", "6": "ˊ",
        "7": "˙", "8": "ㄚ", "9": "ㄞ", "0": "ㄢ", "-": "ㄦ",
        "q": "ㄆ", "w": "ㄊ", "e": "ㄍ", "r": "ㄐ", "t": "ㄔ",
        "y": "ㄗ", "u": "ㄧ", "i": "ㄛ", "o": "ㄟ", "p": "ㄣ",
        "a": "ㄇ", "s": "ㄋ", "d": "ㄎ", "f": "ㄑ", "g": "ㄕ",
        "h": "ㄘ", "j": "ㄨ", "k": "ㄜ", "l": "ㄠ", ";": "ㄤ",
        "z": "ㄈ", "x": "ㄌ", "c": "ㄏ", "v": "ㄒ", "b": "ㄖ",
        "n": "ㄙ", "m": "ㄩ", ",": "ㄝ", ".": "ㄡ", "/": "ㄥ",
    ]

    public static func symbol(for key: Character) -> Character? {
        symbols[Character(key.lowercased())]
    }

    /// Where a symbol sits, for a hardware-keyboard path and for the tests that
    /// keep the two halves of the table honest about each other.
    public static func key(for symbol: Character) -> Character? {
        symbols.first { $0.value == symbol }?.key
    }
}
