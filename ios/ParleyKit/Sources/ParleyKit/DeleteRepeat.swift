import Foundation

/// How a held delete key runs: when each repeat fires, and how much each one
/// takes.
///
/// The system key does not repeat at one steady rate. It waits half a second,
/// deletes about ten characters a second for the next second, then roughly
/// twice that, and once the user has plainly decided to clear a lot it stops
/// counting characters and takes a word at a time. The keyboard's old repeat —
/// 0.4 s, then a fixed tenth of a second forever — cleared a long sentence at a
/// crawl, which is a large part of why it did not feel like the real thing.
///
/// The schedule is a function of the repeat's number alone, so it can be tested
/// here without a clock; the keyboard's `KeyRepeater` only turns it into timers.
/// Repeat 1 is the first one after the press itself — the press deletes on
/// touch-down and is not counted.
public enum DeleteRepeat {
    /// What one repeat removes.
    public enum Unit: Equatable, Sendable {
        case character
        case word
    }

    /// From touch-down to the first repeat. Long enough that an ordinary tap
    /// never repeats, which is the only job it has.
    public static let initialDelay: TimeInterval = 0.5
    /// Between repeats for roughly the first second of repeating.
    public static let slowInterval: TimeInterval = 0.1
    /// Between character repeats after that.
    public static let fastInterval: TimeInterval = 0.05
    /// Between word repeats. Slower again than the fast character rate on
    /// purpose: a word is five or six characters, and twenty words a second is
    /// faster than anyone can let go at the right one.
    public static let wordInterval: TimeInterval = 0.1
    /// Repeats 1…`slowRepeats` run at `slowInterval`: ten of them, the first
    /// second of repeating.
    public static let slowRepeats = 10
    /// After this many single-character repeats every repeat takes a word. The
    /// twentieth lands 1.4 s into the repeat (1.9 s after touch-down), so the
    /// first word goes at 2.0 s, with 21 characters already gone.
    public static let characterRepeats = 20

    /// What repeat `n` (1-based) deletes.
    public static func unit(forRepeat n: Int) -> Unit {
        n > characterRepeats ? .word : .character
    }

    /// How long before repeat `n` (1-based) fires, measured from the one
    /// before it — or from touch-down, for the first.
    public static func delay(beforeRepeat n: Int) -> TimeInterval {
        if n <= 1 { return initialDelay }
        if unit(forRepeat: n) == .word { return wordInterval }
        return n <= slowRepeats ? slowInterval : fastInterval
    }

    /// How many characters one word repeat deletes from the end of `context`
    /// — the text before the caret — so that what is left ends on a word
    /// boundary.
    ///
    /// Trailing spaces go with the word before them, and so does punctuation
    /// stuck to its end, so holding delete over `"Hello, world. "` takes
    /// `"world. "` and then `"Hello, "`. A line break is a unit of its own: a
    /// paragraph is not merged into the one above it by a tick that was only
    /// meant to take a word. An apostrophe inside a word (`don't`) is part of it.
    ///
    /// Chinese and Japanese have no spaces to find a word by, and the extension
    /// has no segmenter it can afford to load, so a run of Han or kana is taken
    /// two characters at a time — the length of most Chinese words — rather
    /// than back to the previous punctuation, which could be a whole clause.
    ///
    /// Counted in `Character`s. If the host's `deleteBackward` removes less than
    /// a whole character per call, the next tick finishes it; counting scalars
    /// would risk the opposite — reaching into the word before.
    ///
    /// Never less than one: with no context at all (a host that reports none)
    /// the repeat still deletes, one character at a time.
    public static func wordLength(before context: String?) -> Int {
        guard let context, !context.isEmpty else { return 1 }
        let chars = Array(context)
        if chars[chars.count - 1].isNewline { return 1 }
        var i = chars.count
        while i > 0, chars[i - 1].isWhitespace, !chars[i - 1].isNewline { i -= 1 }
        while i > 0, isPunctuation(chars[i - 1]) { i -= 1 }
        if i > 0, isIdeographic(chars[i - 1]) {
            var taken = 0
            while i > 0, isIdeographic(chars[i - 1]), taken < ideographsPerWord {
                i -= 1
                taken += 1
            }
        } else {
            var sawWord = false
            while i > 0 {
                let c = chars[i - 1]
                if isWordCharacter(c) {
                    sawWord = true
                    i -= 1
                } else if sawWord, isApostrophe(c), i >= 2, isWordCharacter(chars[i - 2]) {
                    i -= 1
                } else {
                    break
                }
            }
        }
        return max(chars.count - i, 1)
    }

    /// How much of a Han or kana run one word repeat takes.
    public static let ideographsPerWord = 2

    private static func isWordCharacter(_ c: Character) -> Bool {
        !isIdeographic(c) && (c.isLetter || c.isNumber)
    }

    private static func isApostrophe(_ c: Character) -> Bool { c == "'" || c == "\u{2019}" }

    /// Anything that is neither a word character, an ideograph nor whitespace:
    /// punctuation, symbols, emoji.
    private static func isPunctuation(_ c: Character) -> Bool {
        !c.isWhitespace && !isWordCharacter(c) && !isIdeographic(c)
    }

    private static func isIdeographic(_ c: Character) -> Bool {
        guard let s = c.unicodeScalars.first else { return false }
        switch s.value {
        case 0x3040...0x30FF,  // Hiragana, Katakana
            0x3400...0x4DBF,  // CJK Extension A
            0x4E00...0x9FFF,  // CJK Unified Ideographs
            0xF900...0xFAFF,  // CJK Compatibility Ideographs
            0x20000...0x3134F:  // Extensions B–G
            return true
        default:
            return false
        }
    }
}
