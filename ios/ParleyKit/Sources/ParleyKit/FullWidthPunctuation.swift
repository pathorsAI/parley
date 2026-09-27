import Foundation

/// The punctuation the 注音 pane types: full-width, the way written Chinese
/// punctuates, where the QWERTY pane types ASCII.
///
/// Two halves. `fullWidth(_:)` is the table — an ASCII mark to the Chinese mark
/// that takes its place — and the rows below are the 注音 side of the two
/// symbol planes, laid out after the system 注音 keyboard's (iOS 26.5) and built
/// through that table wherever a key has an ASCII counterpart. Both live here
/// rather than in the keyboard target because the keyboard target has no tests,
/// and "can a 注音 typist reach 「」 at all" is a question worth a test.
///
/// Only marks with an established full-width convention in Taiwanese writing
/// are mapped. `$`, `@`, `&`, `#` and the rest have full-width forms in Unicode
/// but nobody expects them, and a `＠` in an email address is a broken
/// address — so they stay ASCII. Digits stay half-width for the same reason.
public enum FullWidthPunctuation {
    /// ASCII → the Chinese mark that replaces it on the 注音 pane.
    ///
    /// `'` → `、` is ours rather than a standard: the enumeration comma sits in
    /// the slot the apostrophe has on the QWERTY punctuation row, and a 注音
    /// typist has no use for an apostrophe there. `<` `>` give the book-title
    /// marks 《》 rather than 〈〉 because 《》 is the pair people actually type.
    private static let table: [Character: String] = [
        ",": "，",
        ".": "。",
        "?": "？",
        "!": "！",
        ":": "：",
        ";": "；",
        "(": "（",
        ")": "）",
        "[": "「",
        "]": "」",
        "'": "、",
        "~": "～",
        "<": "《",
        ">": "》",
    ]

    /// The full-width form of `c`, or `c` itself when it has no full-width
    /// convention — which is also what a mark that is already full-width gets.
    public static func fullWidth(_ c: Character) -> String {
        table[c] ?? String(c)
    }

    // MARK: the 注音 side of the symbol planes

    /// Numbers plane, second row — the system's `- / : ; ( ) $ @ 「 」`, slot
    /// for slot, with the colon, semicolon and parentheses full-width and
    /// `-` `/` `$` `@` left ASCII (see the type's comment).
    /// QWERTY's `&` and `"` give way to 「」, which is the trade the system
    /// makes too: Chinese quotes are corner brackets.
    public static let numbersMiddle: [String] = "-/:;()$@[]".map(fullWidth)

    /// Numbers plane, punctuation row: `。，、？！` and then a plain `.` — the
    /// system keeps one ASCII period here, because this is the plane with the
    /// digits on it and `3.5` needs one.
    public static let numbersPunctuation: [String] = ".,'?!".map(fullWidth) + ["."]

    /// Symbols plane, first row. ASCII, as the system has it: brackets and
    /// operators with no Chinese counterpart anyone reaches for here.
    public static let symbolsTop: [String] = "[]{}#%^*+=".map { String($0) }

    /// Symbols plane, second row — the system's `_—\|～《》¥&·`.
    public static let symbolsMiddle: [String] = "_—\\|~<>¥&·".map(fullWidth)

    /// Symbols plane, punctuation row — the system's `…，^^？！'`, with its
    /// `^^` emoticon key given to `。` so both of the sentence marks are on
    /// both planes.
    public static let symbolsPunctuation: [String] = ["…"] + ",.?!".map(fullWidth) + ["'"]
}
