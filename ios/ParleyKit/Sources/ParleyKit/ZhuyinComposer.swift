import Foundation

/// 傳統注音 input, one syllable at a time.
///
/// Taps accumulate into a `ZhuyinSyllable`; a tone key (or space, which is the
/// first tone) finalizes it and asks the dictionary for candidates; a candidate
/// commits. The rule that makes it feel like a Chinese keyboard rather than a
/// two-step form is the last one: **starting the next syllable commits the
/// current best guess**, so an ordinary sentence is typed without ever touching
/// the candidate bar.
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
        /// Commit this text to the document. The buffer is empty again except
        /// where a symbol key started the next syllable.
        case insert(String)
        /// Nothing was pending, so the key means whatever it normally means —
        /// space types a space, delete deletes a character.
        case passThrough
    }

    public enum Stage: Sendable, Equatable {
        /// Nothing pending. Every key falls through to the document.
        case idle
        /// Symbols in the buffer, no tone yet.
        case composing
        /// Finalized: a reading with a tone, and a candidate bar on screen.
        case choosing
    }

    private let dictionary: ZhuyinDictionary

    public private(set) var syllable = ZhuyinSyllable()
    /// Non-empty only while `stage == .choosing` — and possibly empty even then,
    /// for a reading nothing is pronounced as.
    public private(set) var candidates: [String] = []

    public init(dictionary: ZhuyinDictionary) {
        self.dictionary = dictionary
    }

    public var stage: Stage {
        if syllable.isEmpty { return .idle }
        return syllable.tone == nil ? .composing : .choosing
    }

    /// What the user is part-way through typing, shown above the keys.
    public var reading: String { syllable.text }

    /// What space and the next syllable commit. Falls back to the reading
    /// itself: a syllable with no characters is still something the user typed,
    /// and eating it would be worse than inserting `ㄍㄧ`.
    public var best: String {
        candidates.first ?? syllable.text
    }

    // MARK: keys

    /// A bopomofo symbol. Replaces whatever is in its slot — or, if a syllable
    /// is already waiting to be chosen, commits that one first and starts a new
    /// buffer with this symbol in it.
    public mutating func symbol(_ symbol: Character) -> Outcome {
        guard ZhuyinSyllable.slot(of: symbol) != nil else { return .passThrough }
        if stage == .choosing {
            let committed = best
            syllable = ZhuyinSyllable()
            syllable.place(symbol)
            candidates = []
            return .insert(committed)
        }
        syllable.place(symbol)
        return .handled
    }

    /// A tone key. Finalizes the buffer — or re-tones a syllable already on the
    /// candidate bar, which is the cheap fix for the tone everyone gets wrong
    /// (`ㄕˋ` when they meant `ㄕˊ`) and costs nothing to allow.
    public mutating func tone(_ tone: ZhuyinTone) -> Outcome {
        guard !syllable.isEmpty else { return .passThrough }
        syllable.tone = tone
        candidates = dictionary.candidates(for: syllable)
        return .handled
    }

    /// Space: the first tone while composing, "yes, that one" while choosing,
    /// and an ordinary space when there is nothing pending.
    public mutating func space() -> Outcome {
        switch stage {
        case .idle: return .passThrough
        case .composing: return tone(.first)
        case .choosing: return pick(best)
        }
    }

    /// Delete edits the buffer before it edits the document: it backs out of the
    /// candidate bar first, then takes the syllable apart slot by slot, and only
    /// reaches the field once there is nothing left of either.
    public mutating func delete() -> Outcome {
        switch stage {
        case .idle:
            return .passThrough
        case .composing:
            syllable.removeLast()
            return .handled
        case .choosing:
            candidates = []
            syllable.tone = nil
            return .handled
        }
    }

    /// Commit a candidate the user tapped.
    public mutating func pick(_ candidate: String) -> Outcome {
        clear()
        return .insert(candidate)
    }

    /// Commit whatever is pending, whatever state it is in — the return key, and
    /// leaving the pane. A syllable that never got a tone commits as the raw
    /// 注音, because the alternative is silently throwing away keys the user
    /// pressed.
    public mutating func confirm() -> Outcome {
        guard stage != .idle else { return .passThrough }
        return pick(best)
    }

    /// Drop everything without touching the document. Used when the keyboard
    /// comes back to a *different* field, where a half-typed syllable from the
    /// last one has no business being committed.
    public mutating func clear() {
        syllable = ZhuyinSyllable()
        candidates = []
    }
}
