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
/// **`best` is a lattice, not a greedy walk.** Every way of cutting the buffer
/// into phrases and single characters is scored — a phrase by its own log
/// probability, a character by its syllable's top candidate's — and the
/// likeliest whole segmentation wins (`walk`). So `ㄎㄜㄋㄥㄏㄨㄟㄌㄞ` commits
/// 可能回來, where taking the longest phrase first committed 可能會 + 來: the
/// three-character phrase across the seam beat the two words.
///
/// **And it learns** (`ZhuyinMemory`). A candidate the user picks over what the
/// walk would have committed is remembered against the two words before it;
/// the second time it is picked there, it comes first in the bar and the walk
/// takes it. Return and space teach nothing — only a tap does. The two words
/// are the composer's `context`, the last words it committed in this field,
/// which the keyboard resets when the field changes.
///
/// **After a pick that empties the buffer** the bar becomes what usually comes
/// next (`associations`, from `ZhuyinAssociations`), until any other key.
///
/// See `docs/design/ios-voice-keyboard.md`.
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
    /// Six is past any word they are mid-way through and short of an underline
    /// too long to read back; the cap exists so a pane left open on a long run
    /// of keys cannot grow without bound.
    public static let maxPending = 6

    /// The longest phrase the table holds, which is therefore the longest step
    /// `best` can take. Kept in step with `scripts/gen-zhuyin-phrases.mjs`.
    private static let maxPhrase = 4

    /// What one forgiven symbol costs a node, in log10 units: a factor of
    /// 10²⁰, more than any difference in likelihood the tables can express
    /// across six syllables. So an exact cover always beats a forgiven one,
    /// and fewer forgiven symbols always beat more — the rules the greedy walk
    /// used to state as `if`s, kept as arithmetic.
    static let forgivenPenalty: Float = 20
    /// A syllable nothing reads as, kept as its raw 注音: below any cover that
    /// forgives up to four symbols, so it is the last resort it always was.
    static let rawScore: Float = -100
    /// A remembered choice longer than the node it replaced (McBopomofo's
    /// `kOverrideValueWithHighScore`): far above anything a real node scores,
    /// so the walk takes it whatever it would otherwise have preferred.
    static let learnedScore: Float = 42

    private let dictionary: ZhuyinDictionary
    /// Absent is a composer that behaves exactly as it did before phrases: the
    /// bar is the first syllable's characters and `best` is one per syllable.
    private let phrases: ZhuyinPhrases?
    /// Absent is a composer that never learns — the tests' default, and the
    /// behaviour of every caller written before it.
    private let memory: ZhuyinMemory?
    /// Absent is a composer that offers nothing after a pick.
    private let associationTable: ZhuyinAssociations?

    /// The last two words committed in this field, oldest first: picks, the
    /// nodes of a confirmed walk, an association. What `ZhuyinMemory` keys a
    /// lesson by. `clear()` keeps it — confirming is not leaving — and
    /// `resetContext()` drops it, which the keyboard does when the field
    /// changes or text from outside the composer lands.
    public private(set) var context: [String] = []

    /// What usually follows the word just picked, best first, shown in the bar
    /// while nothing is pending. Set by a pick that empties the buffer and by
    /// `pickAssociation`; any other key empties it.
    public private(set) var associations: [String] = []

    /// Everything pending, oldest first. Never holds an empty syllable: delete
    /// drops one the moment its last slot goes.
    public private(set) var syllables: [ZhuyinSyllable] = []

    /// Candidates for the front of the buffer — what a tap on the bar converts.
    /// Phrases first, longest-matching order as `ZhuyinPhrases` returns them,
    /// then the single characters of the **first** pending syllable. Possibly
    /// empty even with something pending, for a reading nothing is pronounced
    /// as.
    public private(set) var candidates: [String] = []

    public init(
        dictionary: ZhuyinDictionary, phrases: ZhuyinPhrases? = nil,
        memory: ZhuyinMemory? = nil, associations: ZhuyinAssociations? = nil
    ) {
        self.dictionary = dictionary
        self.phrases = phrases
        self.memory = memory
        self.associationTable = associations
    }

    /// The syllable the keys are landing in. Kept for callers written against
    /// the single-syllable buffer; `syllables` is the state.
    public var syllable: ZhuyinSyllable { syllables.last ?? ZhuyinSyllable() }

    public var stage: Stage {
        guard let last = syllables.last else { return .idle }
        return last.tone == nil ? .composing : .choosing
    }

    /// What the user is part-way through typing, exactly as the host field
    /// shows it as marked text. Syllables are separated by a space, which is how
    /// the system keyboard shows a buffer it has segmented — without it
    /// `ㄋㄧㄏㄠ` reads as one impossible syllable. The first tone has no mark of
    /// its own, so a syllable toned with space shows `ˉ` the way the system
    /// keyboard does; otherwise it would look as untoned as one still being typed.
    public var reading: String {
        syllables.map(Self.marked).joined(separator: " ")
    }

    private static func marked(_ syllable: ZhuyinSyllable) -> String {
        syllable.tone == .first ? syllable.text + "ˉ" : syllable.text
    }

    /// What confirm commits: the likeliest segmentation of the whole buffer
    /// (`walk`), with what the user has taught it applied.
    ///
    /// Error tolerance is **more conservative here than in the bar**, because
    /// the bar is a list to choose from and this is text that lands unasked. An
    /// exact cover of any length beats a forgiven one of any length, so a
    /// correctly typed run commits exactly what it would without tolerance. A
    /// forgiven cover is a node only for a window holding a syllable that has
    /// **no exact row** in the dictionary — one that cannot be right as typed —
    /// and every forgiven symbol costs it `forgivenPenalty`. So `ㄓㄨㄡ ㄨㄣˊ`
    /// commits 中文, while `ㄗㄨㄥ ㄨㄣˊ`, both of whose syllables are real
    /// readings, commits one character per syllable and leaves 中文 at the front
    /// of the bar. Letting any forgiven cover compete was tried and turned
    /// 他說的人 into 他說到任 and 吃飯了麼 into 吃飯老馬: two correctly typed
    /// syllables that happen not to be a phrase are exactly where a one-symbol-off
    /// phrase is always waiting.
    ///
    /// Falls back to a syllable's own reading — a syllable with no characters is
    /// still something the user typed, and eating it would be worse than
    /// inserting `ㄍㄧ`.
    public var best: String {
        walk(learning: true).path.map(\.value).joined()
    }

    // MARK: the lattice

    /// One edge of the lattice: syllables `start ..< start + span` read as
    /// `value`.
    struct Node: Equatable {
        let start: Int
        let span: Int
        var value: String
        var score: Float
        /// The lesson this node came from, when the memory put it here.
        var learned: ZhuyinMemory.Key?

        var end: Int { start + span }
    }

    /// The likeliest reading of the buffer, and — when the memory has something
    /// to say about the front of it — the value it wants first in the bar.
    ///
    /// The nodes: every syllable as its top character (forgiven or raw when it
    /// has to be, see `characterNode`), and every window of two to four
    /// syllables as the best phrase that covers exactly it (`phraseNode`). The
    /// walk is McBopomofo's (`ReadingGrid::walk()` in gramambular2, MIT): the
    /// lattice only points forward, so one pass in position order finds the
    /// path with the highest total score. Six syllables is at most 6 + 5 + 4
    /// + 3 nodes; the work is the dozen phrase lookups, not the walk.
    ///
    /// With `learning`, each node of that path is then looked up in the memory,
    /// left to right, against the two words before it — the path's own earlier
    /// nodes, then `context` — and a remembered choice replaces it (`teach`)
    /// before the walk is run again.
    func walk(learning: Bool) -> (path: [Node], front: String?) {
        guard !syllables.isEmpty else { return ([], nil) }
        var lattice = self.lattice()
        var path = Self.bestPath(through: lattice, count: syllables.count)
        guard learning, let memory, !memory.isEmpty, mayKnowAnything(memory) else {
            return (path, nil)
        }
        var front: String?
        var position = 0
        while let j = path.firstIndex(where: { $0.start >= position }) {
            let node = path[j]
            position = node.start + 1
            let key = ZhuyinMemory.Key(
                context: Array((context + path[..<j].map(\.value)).suffix(2)),
                reading: reading(node.start..<node.end), value: node.value)
            guard memory.knows(reading: key.reading),
                let suggestion = memory.suggestion(for: key), suggestion.value != node.value,
                let taught = teach(suggestion, key: key, at: node, in: lattice)
            else { continue }
            if node.start == 0 { front = taught.value }
            lattice[taught.start].removeAll { $0.span == taught.span }
            lattice[taught.start].append(taught)
            path = Self.bestPath(through: lattice, count: syllables.count)
        }
        return (path, front)
    }

    /// Every edge, by where it starts.
    private func lattice() -> [[Node]] {
        let count = syllables.count
        var edges = Array(repeating: [Node](), count: count)
        // Which syllables have no exact row: a forgiven phrase is a node only
        // for a window holding one of these.
        var unread = [Bool](repeating: false, count: count)
        for i in 0..<count {
            let node = characterNode(at: i)
            unread[i] = node.unread
            edges[i].append(node.node)
        }
        guard let phrases else { return edges }
        for i in 0..<count {
            for span in stride(from: 2, through: min(Self.maxPhrase, count - i), by: 1) {
                let window = Array(syllables[i..<(i + span)])
                if let match = phrases.exactCover(window) {
                    edges[i].append(Node(start: i, span: span, value: match.phrase, score: match.score))
                } else if unread[i..<(i + span)].contains(true),
                    let match = phrases.forgivenCover(window)
                {
                    edges[i].append(
                        Node(
                            start: i, span: span, value: match.phrase,
                            score: match.score - Float(match.errors) * Self.forgivenPenalty))
                }
            }
        }
        return edges
    }

    /// A syllable as one character: its top candidate, exactly what the bar
    /// would show first for it, scored as the dictionary scores it — less
    /// `forgivenPenalty` when it is a variant's, since then nothing reads the
    /// way it was typed (`unread`). A syllable with no candidate at all is its
    /// raw 注音 at `rawScore`.
    private func characterNode(at i: Int) -> (node: Node, unread: Bool) {
        let syllable = syllables[i]
        guard let top = dictionary.topCandidate(for: syllable, toneless: syllable.tone == nil)
        else {
            return (Node(start: i, span: 1, value: syllable.text, score: Self.rawScore), true)
        }
        let score = top.score - Float(top.errors) * Self.forgivenPenalty
        return (Node(start: i, span: 1, value: top.character, score: score), top.errors > 0)
    }

    /// The highest-scoring path from the first syllable to past the last, by
    /// dynamic programming over positions — McBopomofo's `walk()`. A tie keeps
    /// the path found first, which with edges relaxed shortest-first from the
    /// left is the one with the earlier, shorter step.
    static func bestPath(through lattice: [[Node]], count: Int) -> [Node] {
        var bestScore = [Float](repeating: -.infinity, count: count + 1)
        var arrivedBy = [Node?](repeating: nil, count: count + 1)
        bestScore[0] = 0
        for i in 0..<count where bestScore[i] > -.infinity {
            for node in lattice[i].sorted(by: { $0.span < $1.span }) where node.end <= count {
                let score = bestScore[i] + node.score
                if score > bestScore[node.end] {
                    bestScore[node.end] = score
                    arrivedBy[node.end] = node
                }
            }
        }
        var path: [Node] = []
        var position = count
        while position > 0, let node = arrivedBy[position] {
            path.append(node)
            position = node.start
        }
        return path.reversed()
    }

    // MARK: learning

    /// The node a remembered choice puts at `node.start`, or `nil` when the
    /// buffer cannot read that way any more — the choice is longer than what is
    /// left, or no candidate for those syllables is that word.
    ///
    /// Scored as McBopomofo scores an override: a choice longer than the node
    /// it replaced takes `learnedScore`, which no path can beat; otherwise the
    /// best score of a node over that span already, so the walk is as likely to
    /// go through it as before and only the word changes. A shorter choice —
    /// the user breaking a phrase up — therefore does not force the walk apart;
    /// it is offered first in the bar, which is where the user taught it.
    private func teach(
        _ suggestion: ZhuyinMemory.Suggestion, key: ZhuyinMemory.Key, at node: Node,
        in lattice: [[Node]]
    ) -> Node? {
        let span = suggestion.value.unicodeScalars.count
        guard span >= 1, node.start + span <= syllables.count else { return nil }
        let window = Array(syllables[node.start..<(node.start + span)])
        var score: Float
        if span == 1 {
            guard row(of: window[0]).contains(suggestion.value) else { return nil }
            score = lattice[node.start].first { $0.span == 1 }?.score ?? Self.rawScore
        } else {
            guard let match = phrases?.matches(window).first(where: {
                $0.phrase == suggestion.value && $0.span == span
            })
            else { return nil }
            score = lattice[node.start].first { $0.span == span }?.score ?? match.score
        }
        if suggestion.longer { score = Self.learnedScore }
        return Node(
            start: node.start, span: span, value: suggestion.value, score: score, learned: key)
    }

    /// Whether any window of the buffer reads the way some lesson does — the
    /// question a refresh asks before it pays for a walk. Nearly always no, so
    /// a keystroke with a memory costs what one without did.
    private func mayKnowAnything(_ memory: ZhuyinMemory) -> Bool {
        for start in syllables.indices {
            for end in (start + 1)...min(start + Self.maxPhrase, syllables.count)
            where memory.knows(reading: reading(start..<end)) {
                return true
            }
        }
        return false
    }

    /// The syllables in `range` as a lesson's reading: as typed, tone dropped,
    /// space separated.
    func reading(_ range: Range<Int>) -> String {
        syllables[range].map { syllable in
            var text = ""
            if let initial = syllable.initial { text.append(initial) }
            if let medial = syllable.medial { text.append(medial) }
            if let final = syllable.final { text.append(final) }
            return text
        }.joined(separator: " ")
    }

    /// Add committed words to `context`, keeping the last two.
    private mutating func remember(_ words: [String]) {
        context = Array((context + words.filter { !$0.isEmpty }).suffix(2))
    }

    /// Forget the words before the caret: the field changed, or text from
    /// outside the composer landed between them and whatever comes next.
    public mutating func resetContext() {
        context = []
        associations = []
    }

    // MARK: keys

    /// A bopomofo symbol. Joins the syllable being typed where it fits, and
    /// otherwise starts the next one — which is what lets a whole word be typed
    /// without tones.
    public mutating func symbol(_ symbol: Character) -> Outcome {
        guard let slot = ZhuyinSyllable.slot(of: symbol) else { return .passThrough }
        associations = []
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
        associations = []
        guard !syllables.isEmpty else { return .passThrough }
        syllables[syllables.count - 1].tone = tone
        refreshCandidates()
        return .handled
    }

    /// Space: the first tone when the syllable being typed has none — 大千 has
    /// no key for it, and the system keyboard spends space the same way — and
    /// "yes, all of that" once it is toned.
    public mutating func space() -> Outcome {
        guard let last = syllables.last else {
            resetContext()
            return .passThrough
        }
        return last.tone == nil ? tone(.first) : confirm()
    }

    /// Delete edits the buffer before it edits the document: the tone first,
    /// then the syllable slot by slot, then back into the syllable before it,
    /// and only once nothing is left does it reach the field.
    ///
    /// `refreshingCandidates: false` is for a held delete key: it unwinds the
    /// buffer up to twenty times a second, and looking the phrases up again on
    /// every tick only to redraw a bar nobody can read at that speed is wasted
    /// work. The bar keeps its last answer until the key is let go and the
    /// keyboard calls `refresh()` — except that an emptied buffer always has an
    /// empty bar, so a hold that clears the reading clears the bar with it.
    public mutating func delete(refreshingCandidates: Bool = true) -> Outcome {
        // Into the document: the word before the caret is going, so it is not
        // context any more.
        guard var last = syllables.last else {
            resetContext()
            return .passThrough
        }
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
        if refreshingCandidates {
            refreshCandidates()
        } else if syllables.isEmpty {
            candidates = []
        }
        return .handled
    }

    /// Commit a candidate the user tapped. It answers the **front** of the
    /// buffer, so as many syllables leave it as the candidate has characters —
    /// one Chinese character is one syllable, which is why this needs no span
    /// argument — and the bar moves on to what is left. A prediction longer than
    /// the buffer takes all of it: the user asked for a word they had not
    /// finished typing.
    ///
    /// **This is the one place the composer learns.** A pick that differs from
    /// the front of what the walk would have committed — without anything
    /// learned, so picking a remembered choice again strengthens it — is a
    /// lesson for `ZhuyinMemory`, keyed by `context`, the reading and value of
    /// that front node. A choice longer than the node is marked so; see
    /// `teach`. A prediction longer than the buffer teaches nothing: the walk
    /// cannot produce it, so there is nothing for it to replace.
    ///
    /// A pick that empties the buffer opens `associations` for what it
    /// committed.
    public mutating func pick(_ candidate: String) -> Outcome {
        let length = candidate.unicodeScalars.count
        if let memory, length <= syllables.count, let front = walk(learning: false).path.first,
            front.value != candidate
        {
            memory.observe(
                ZhuyinMemory.Key(
                    context: context, reading: reading(front.start..<front.end),
                    value: front.value),
                chose: candidate, longer: length > front.span)
        }
        let span = min(length, syllables.count)
        syllables.removeFirst(span)
        remember([candidate])
        refreshCandidates()
        associations =
            syllables.isEmpty ? associationTable?.continuations(after: candidate) ?? [] : []
        return .insert(candidate)
    }

    /// Commit an associated phrase from the bar, and offer what follows it in
    /// turn. It continues the word before it, so it extends that word in
    /// `context` rather than standing as one of its own: 研 then 究 is the word
    /// 研究, and the next lookup reads 研究.
    public mutating func pickAssociation(_ continuation: String) -> Outcome {
        guard syllables.isEmpty, !continuation.isEmpty else { return .passThrough }
        let word = (context.last ?? "") + continuation
        if context.isEmpty { context = [word] } else { context[context.count - 1] = word }
        associations = associationTable?.continuations(after: word) ?? []
        return .insert(continuation)
    }

    /// Commit everything pending, whatever state it is in — the return key, and
    /// leaving the pane. A syllable that never got a tone commits as its top
    /// toneless candidate, or as the raw 注音 when the dictionary has nothing,
    /// because the alternative is silently throwing away keys the user pressed.
    ///
    /// Teaches nothing — the user accepted what was offered — but a remembered
    /// choice it commits is `touch`ed, so a word in daily use does not age out
    /// of the memory just because it no longer needs picking.
    public mutating func confirm() -> Outcome {
        guard !syllables.isEmpty else {
            resetContext()
            return .passThrough
        }
        let path = walk(learning: true).path
        for node in path {
            if let key = node.learned { memory?.touch(key, value: node.value) }
        }
        clear()
        remember(path.map(\.value))
        return .insert(path.map(\.value).joined())
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
    ///
    /// Keeps `context`: confirming ends a composition, not the sentence. The
    /// keyboard calls `resetContext()` as well when the field itself changed.
    public mutating func clear() {
        syllables = []
        candidates = []
        associations = []
    }

    // MARK: buffer

    /// Begin the next syllable. Past `maxPending` the oldest one is committed to
    /// make room — the user kept typing rather than choosing, so the best guess
    /// is the only answer available.
    private mutating func start(_ symbol: Character) -> Outcome {
        var committed: String?
        if syllables.count >= Self.maxPending {
            committed = top(of: syllables.removeFirst())
            remember([committed ?? ""])
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
    ///
    /// What the user has taught comes first: when the memory has a choice for
    /// the front of the buffer in this context, it leads the bar — moved there
    /// if the bar already holds it, put there if the bar was cut before it.
    /// Nothing else moves. With nothing learned for this buffer — nearly every
    /// keystroke — the bar is exactly the tables' order, and no walk is run.
    private mutating func refreshCandidates() {
        var bar: [String] = []
        if syllables.count >= 2, let phrases {
            bar = phrases.matches(syllables).map(\.phrase)
        }
        if let first = syllables.first { bar += row(of: first) }
        if let memory, !memory.isEmpty, mayKnowAnything(memory),
            let taught = walk(learning: true).front
        {
            bar.removeAll { $0 == taught }
            bar.insert(taught, at: 0)
        }
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
