import Foundation

/// 傳統注音 input over a buffer of pending syllables.
///
/// Taps accumulate into the last `ZhuyinSyllable` in the buffer; a symbol that
/// cannot join it — its slot is taken, or it belongs before the slot last filled
/// — starts the next one instead, which is how a run of untoned symbols
/// segments. `ㄋㄧㄏㄠ` becomes `ㄋㄧ ㄏㄠ` with no tone key pressed anywhere,
/// exactly as the system 注音 keyboard does it, and that is the whole point:
/// the earlier one-syllable buffer made every character need a tone or a space
/// after it, because the next symbol overwrote the slot it landed in.
///
/// Tones still finalize, but they finalize the **last** syllable while the
/// candidate bar shows the **first** — the oldest pending syllable is the one
/// the user converts next, so `pick` commits that one and leaves the rest
/// pending. Nothing is committed on its own until the buffer reaches
/// `maxPending`, which is a bound on a keyboard's worth of state rather than a
/// feature.
///
/// A phrase table sits in front of the per-syllable one. Matching is by prefix
/// *within* each syllable — the slots the user filled must agree, the ones they
/// have not are wildcards — so two lone 聲母 `ㄋㄏ` already offer 你好, which is
/// what the system keyboard does and what per-syllable data alone cannot answer.
/// Phrases longer than the buffer are offered too: they are the prediction. The
/// single characters of the first syllable follow them, so nothing the old bar
/// could do is lost.
///
/// Both tables forgive one wrong symbol per syllable (`ZhuyinFuzzy`), always
/// after every exact answer, so the composer needs no rule of its own for it:
/// the bar is the tables' order, and a syllable's top is exact whenever it has
/// an exact row.
///
/// Still no user learning — the order is the corpus's, not yours — and still no
/// lattice: `best` walks the buffer greedily, longest phrase first, rather than
/// scoring whole segmentations. See `docs/design/ios-voice-keyboard.md`.
///
/// The composer never touches the document. It answers with an `Outcome` and
/// lets the keyboard do the inserting, which is what keeps it testable off a
/// device — and keeps the "what does delete delete" question answerable in one
/// place instead of two.
public struct ZhuyinComposer {
    /// What the caller should do with a key the composer has just seen.
    public enum Outcome: Equatable, Sendable {
        /// The buffer changed; the document is untouched.
        case handled
        /// Commit this text to the document. What stays pending depends on the
        /// key: `pick` leaves the syllables after the one it committed, a
        /// symbol key that overflowed the buffer leaves everything else.
        case insert(String)
        /// Nothing was pending, so the key means whatever it normally means —
        /// space types a space, delete deletes a character.
        case passThrough
    }

    public enum Stage: Sendable, Equatable {
        /// Nothing pending. Every key falls through to the document.
        case idle
        /// Symbols in the buffer, and the one being typed has no tone yet.
        case composing
        /// The syllable being typed has a tone.
        case choosing
    }

    /// How many syllables may wait before the oldest is committed for the user.
    /// Six is past any word they are mid-way through and short of a buffer that
    /// would scroll the strip; the cap exists so a pane left open on a long run
    /// of keys cannot grow without bound.
    public static let maxPending = 6

    /// The longest phrase the table holds, which is therefore the longest step
    /// `best` can take. Kept in step with `scripts/gen-zhuyin-phrases.mjs`.
    private static let maxPhrase = 4

    private let dictionary: ZhuyinDictionary
    /// Absent is a composer that behaves exactly as it did before phrases: the
    /// bar is the first syllable's characters and `best` is one per syllable.
    private let phrases: ZhuyinPhrases?

    /// Everything pending, oldest first. Never holds an empty syllable: delete
    /// drops one the moment its last slot goes.
    public private(set) var syllables: [ZhuyinSyllable] = []

    /// Candidates for the front of the buffer — what a tap on the bar converts.
    /// Phrases first, longest-matching order as `ZhuyinPhrases` returns them,
    /// then the single characters of the **first** pending syllable. Possibly
    /// empty even with something pending, for a reading nothing is pronounced
    /// as.
    public private(set) var candidates: [String] = []

    public init(dictionary: ZhuyinDictionary, phrases: ZhuyinPhrases? = nil) {
        self.dictionary = dictionary
        self.phrases = phrases
    }

    /// The syllable the keys are landing in. Kept for callers written against
    /// the single-syllable buffer; `syllables` is the state.
    public var syllable: ZhuyinSyllable { syllables.last ?? ZhuyinSyllable() }

    public var stage: Stage {
        guard let last = syllables.last else { return .idle }
        return last.tone == nil ? .composing : .choosing
    }

    /// What the user is part-way through typing, shown above the keys. Syllables
    /// are separated by a space, which is how the system keyboard shows a buffer
    /// it has segmented — without it `ㄋㄧㄏㄠ` reads as one impossible syllable.
    public var reading: String {
        syllables.map(\.text).joined(separator: " ")
    }

    /// What confirm commits, read left to right: at each position the longest
    /// phrase that covers exactly the syllables in front of it, four down to
    /// two, and otherwise that one syllable's top character. Greedy rather than
    /// a lattice — deterministic, explainable, and wrong in ways a user can see
    /// and fix by picking from the bar instead.
    ///
    /// Error tolerance is **more conservative here than in the bar**, because
    /// the bar is a list to choose from and this is text that lands unasked. An
    /// exact cover of any length beats a forgiven one of any length, so a
    /// correctly typed run commits exactly what it did before. A forgiven cover
    /// is taken only for a window holding a syllable that has **no exact row**
    /// in the dictionary — one that cannot be right as typed — and then the
    /// fewest forgiven symbols win, length breaking a tie. So `ㄓㄨㄡ ㄨㄣˊ`
    /// commits 中文, while `ㄗㄨㄥ ㄨㄣˊ`, both of whose syllables are real
    /// readings, commits one character per syllable and leaves 中文 at the front
    /// of the bar. Letting any forgiven cover beat per-syllable characters was
    /// tried and turned 他說的人 into 他說到任 and 吃飯了麼 into 吃飯老馬: two
    /// correctly typed syllables that happen not to be a phrase are exactly
    /// where a one-symbol-off phrase is always waiting.
    ///
    /// Falls back to a syllable's own reading — a syllable with no characters is
    /// still something the user typed, and eating it would be worse than
    /// inserting `ㄍㄧ`.
    public var best: String {
        guard let phrases else { return syllables.map(top(of:)).joined() }
        var out = ""
        var index = 0
        while index < syllables.count {
            let remaining = syllables.count - index
            var taken = 0
            if remaining >= 2 {
                var chosen: ZhuyinPhrases.Match?
                for span in stride(from: min(Self.maxPhrase, remaining), through: 2, by: -1) {
                    let window = Array(syllables[index..<(index + span)])
                    // Only an exact cover: a prediction longer than what is left
                    // would put characters in the document the user never typed.
                    // The bar ranks fewest errors first, so the first of this
                    // span is this span's best.
                    guard let match = phrases.matches(window).first(where: { $0.span == span })
                    else { continue }
                    if match.errors == 0 {
                        chosen = match
                        break
                    }
                    guard window.contains(where: { exactRow(of: $0).isEmpty }) else { continue }
                    // Longest first, so a shorter span only wins on fewer errors.
                    if match.errors < chosen?.errors ?? .max { chosen = match }
                }
                if let chosen {
                    out += chosen.phrase
                    taken = chosen.span
                }
            }
            if taken == 0 {
                out += top(of: syllables[index])
                taken = 1
            }
            index += taken
        }
        return out
    }

    // MARK: keys

    /// A bopomofo symbol. Joins the syllable being typed where it fits, and
    /// otherwise starts the next one — which is what lets a whole word be typed
    /// without tones.
    public mutating func symbol(_ symbol: Character) -> Outcome {
        guard let slot = ZhuyinSyllable.slot(of: symbol) else { return .passThrough }
        guard var current = syllables.last else { return start(symbol) }
        // A toned syllable is finished. So is one whose slots have caught up
        // with this symbol: `ㄅㄆ` is two syllables on the native keyboard, and
        // a 聲母 after a 韻母 can only be the next one — replacing the slot, as
        // the old buffer did, silently ate the character before it.
        guard current.tone == nil, let last = lastFilledSlot(of: current), slot > last else {
            return start(symbol)
        }
        current.place(symbol)
        syllables[syllables.count - 1] = current
        refreshCandidates()
        return .handled
    }

    /// A tone key, which finalizes the syllable being typed — or re-tones it,
    /// which is the cheap fix for the tone everyone gets wrong (`ㄕˋ` when they
    /// meant `ㄕˊ`) and costs nothing to allow.
    public mutating func tone(_ tone: ZhuyinTone) -> Outcome {
        guard !syllables.isEmpty else { return .passThrough }
        syllables[syllables.count - 1].tone = tone
        refreshCandidates()
        return .handled
    }

    /// Space: the first tone when the syllable being typed has none — 大千 has
    /// no key for it, and the system keyboard spends space the same way — and
    /// "yes, all of that" once it is toned.
    public mutating func space() -> Outcome {
        guard let last = syllables.last else { return .passThrough }
        return last.tone == nil ? tone(.first) : confirm()
    }

    /// Delete edits the buffer before it edits the document: the tone first,
    /// then the syllable slot by slot, then back into the syllable before it,
    /// and only once nothing is left does it reach the field.
    public mutating func delete() -> Outcome {
        guard var last = syllables.last else { return .passThrough }
        if last.tone != nil {
            last.tone = nil
        } else {
            last.removeLast()
        }
        if last.isEmpty {
            syllables.removeLast()
        } else {
            syllables[syllables.count - 1] = last
        }
        refreshCandidates()
        return .handled
    }

    /// Commit a candidate the user tapped. It answers the **front** of the
    /// buffer, so as many syllables leave it as the candidate has characters —
    /// one Chinese character is one syllable, which is why this needs no span
    /// argument — and the bar moves on to what is left. A prediction longer than
    /// the buffer takes all of it: the user asked for a word they had not
    /// finished typing.
    public mutating func pick(_ candidate: String) -> Outcome {
        let span = min(candidate.unicodeScalars.count, syllables.count)
        syllables.removeFirst(span)
        refreshCandidates()
        return .insert(candidate)
    }

    /// Commit everything pending, whatever state it is in — the return key, and
    /// leaving the pane. A syllable that never got a tone commits as its top
    /// toneless candidate, or as the raw 注音 when the dictionary has nothing,
    /// because the alternative is silently throwing away keys the user pressed.
    public mutating func confirm() -> Outcome {
        guard !syllables.isEmpty else { return .passThrough }
        let committed = best
        clear()
        return .insert(committed)
    }

    /// Look the pending syllables up again without changing them.
    ///
    /// For when the tables behind the composer change under it: a keystroke
    /// that beat `ZhuyinPhrases.warm(onReady:)` was answered from no table at
    /// all, and once the table lands the bar it drew is stale. The keyboard
    /// calls this from the warm's completion and republishes.
    public mutating func refresh() {
        refreshCandidates()
    }

    /// Drop everything without touching the document. Used when the keyboard
    /// comes back to a *different* field, where a half-typed syllable from the
    /// last one has no business being committed.
    public mutating func clear() {
        syllables = []
        candidates = []
    }

    // MARK: buffer

    /// Begin the next syllable. Past `maxPending` the oldest one is committed to
    /// make room — the user kept typing rather than choosing, so the best guess
    /// is the only answer available.
    private mutating func start(_ symbol: Character) -> Outcome {
        var committed: String?
        if syllables.count >= Self.maxPending {
            committed = top(of: syllables.removeFirst())
        }
        var next = ZhuyinSyllable()
        next.place(symbol)
        syllables.append(next)
        refreshCandidates()
        return committed.map(Outcome.insert) ?? .handled
    }

    /// The bar follows the front of the buffer, not the syllable under the
    /// fingers: phrases the whole buffer could still become, then the characters
    /// of its first syllable. A phrase is at least two characters and the tail
    /// is single characters, so the two halves cannot collide.
    private mutating func refreshCandidates() {
        var bar: [String] = []
        if syllables.count >= 2, let phrases {
            bar = phrases.matches(syllables).map(\.phrase)
        }
        if let first = syllables.first { bar += row(of: first) }
        candidates = bar
    }

    /// An untoned syllable is looked up toneless, which is the only way a bar
    /// can exist before a tone key is pressed.
    private func row(of syllable: ZhuyinSyllable) -> [String] {
        syllable.tone == nil
            ? dictionary.tonelessCandidates(for: syllable)
            : dictionary.candidates(for: syllable)
    }

    /// The syllable's own row with nothing forgiven — empty exactly when no
    /// character reads the way it was typed.
    private func exactRow(of syllable: ZhuyinSyllable) -> [String] {
        syllable.tone == nil
            ? dictionary.tonelessCandidates(for: syllable, fuzzy: false)
            : dictionary.candidates(for: syllable, fuzzy: false)
    }

    private func top(of syllable: ZhuyinSyllable) -> String {
        row(of: syllable).first ?? syllable.text
    }

    /// The slot the syllable has got as far as. `nil` only for an empty
    /// syllable, which the buffer never holds.
    private func lastFilledSlot(of syllable: ZhuyinSyllable) -> ZhuyinSyllable.Slot? {
        if syllable.final != nil { return .final }
        if syllable.medial != nil { return .medial }
        if syllable.initial != nil { return .initial }
        return nil
    }
}
