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
/// Per-syllable conversion, not phrase conversion: no lattice and no phrase
/// lexicon. See `docs/design/ios-voice-keyboard.md`.
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

    private let dictionary: ZhuyinDictionary

    /// Everything pending, oldest first. Never holds an empty syllable: delete
    /// drops one the moment its last slot goes.
    public private(set) var syllables: [ZhuyinSyllable] = []

    /// Candidates for the **first** pending syllable — the one a tap on the bar
    /// converts. Possibly empty even with something pending, for a reading
    /// nothing is pronounced as.
    public private(set) var candidates: [String] = []

    public init(dictionary: ZhuyinDictionary) {
        self.dictionary = dictionary
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

    /// What confirm commits: every pending syllable's top candidate, in order.
    /// Falls back to a syllable's own reading — a syllable with no characters is
    /// still something the user typed, and eating it would be worse than
    /// inserting `ㄍㄧ`.
    public var best: String {
        syllables.map(top(of:)).joined()
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

    /// Commit a candidate the user tapped. It answers the **first** pending
    /// syllable, so only that one leaves the buffer and the bar moves on to the
    /// next — which is what makes a multi-syllable buffer convertible at all.
    public mutating func pick(_ candidate: String) -> Outcome {
        if !syllables.isEmpty { syllables.removeFirst() }
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

    /// The bar follows the first syllable, not the one under the fingers.
    private mutating func refreshCandidates() {
        candidates = syllables.first.map(row(of:)) ?? []
    }

    /// An untoned syllable is looked up toneless, which is the only way a bar
    /// can exist before a tone key is pressed.
    private func row(of syllable: ZhuyinSyllable) -> [String] {
        syllable.tone == nil
            ? dictionary.tonelessCandidates(for: syllable)
            : dictionary.candidates(for: syllable)
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
