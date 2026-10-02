import Foundation

// Personal-dictionary sync with Parley Cloud — the phone's half of what the
// desktop does in `src/lib/cloud/dictionarySync.ts`, over the same contract
// (`GET` / `PUT /v1/dictionary`, parley-internal `apps/cloud/src/dictionary.ts`).
//
// The cloud keeps one entry per PHRASE: the correct written form plus the
// misheard forms that get rewritten into it. The phone's lexicon has no such
// entries, so it is projected into them (`project`):
//
//   - a term the user added → an entry with no variants, source `manual`;
//   - a CONFIRMED correction (count ≥ `Lexicon.autoApplyThreshold`) → its
//     `original` becomes a variant of the entry whose phrase is its
//     `replacement`, source `learned`;
//   - a term and corrections that share a phrase are one entry.
//
// Never projected, so never sent: corrections still being learned (one
// sighting is a guess, not a rule), and `Lexicon.systemTerms` — the names the
// keyboard read from Contacts and Text Replacement are the system's, not the
// user's, and contacts do not leave the phone.
//
// Changes are found by diffing that projection against a snapshot of the
// cloud's state and of how much of it this phone held
// (`DictionarySyncState.synced`), so an edit made by the keyboard in its own
// process is picked up by the app the same way as one made on the dictionary
// screen.
//
// The one rule that keeps a phone from costing the account data: it only ever
// removes what it held and the user removed. The phone cannot always hold a
// whole phrase — the lexicon's caps, or a variant it refuses as a correction —
// so every push carries the variants it never held unchanged, a phrase it never
// held is never pushed or deleted, and a phrase the user removed here is a
// tombstone only if the phone held all of it.
//
// Everything here is Foundation-only and free of I/O except `run`, which takes
// its network (`DictionarySyncTransport`) and its files (`DictionarySyncStorage`)
// as arguments, so the whole thing is exercised by `swift test`.

/// An entry as `GET` / `PUT /v1/dictionary` exchange it.
public struct CloudDictionaryEntry: Codable, Equatable, Sendable {
    public var id: String
    public var phrase: String
    public var variants: [String]
    /// `manual` | `learned` | `imported`.
    public var source: String
    public var confirmed: Bool
    /// Epoch ms of the last change — the last-write-wins clock.
    public var updatedAt: Int64
    /// Epoch ms of the deletion; nil = live.
    public var deletedAt: Int64?

    public init(
        id: String, phrase: String, variants: [String], source: String, confirmed: Bool = true,
        updatedAt: Int64, deletedAt: Int64? = nil
    ) {
        self.id = id
        self.phrase = phrase
        self.variants = variants
        self.source = source
        self.confirmed = confirmed
        self.updatedAt = updatedAt
        self.deletedAt = deletedAt
    }
}

/// One refused entry of a PUT; `index` is its position in that request.
public struct CloudDictionaryRejection: Codable, Equatable, Sendable {
    public var index: Int
    public var id: String
    public var error: String

    public init(index: Int, id: String, error: String) {
        self.index = index
        self.id = id
        self.error = error
    }
}

public struct DictionaryPullResponse: Codable, Equatable, Sendable {
    public var entries: [CloudDictionaryEntry]
    /// Server time — the `since` of the next pull.
    public var now: Int64

    public init(entries: [CloudDictionaryEntry], now: Int64) {
        self.entries = entries
        self.now = now
    }
}

public struct DictionaryPushResponse: Codable, Equatable, Sendable {
    public var entries: [CloudDictionaryEntry]
    public var rejected: [CloudDictionaryRejection]

    public init(entries: [CloudDictionaryEntry], rejected: [CloudDictionaryRejection] = []) {
        self.entries = entries
        self.rejected = rejected
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        entries = try c.decodeIfPresent([CloudDictionaryEntry].self, forKey: .entries) ?? []
        rejected = try c.decodeIfPresent([CloudDictionaryRejection].self, forKey: .rejected) ?? []
    }
}

/// The two calls sync makes. `CloudClient` is the real one; tests use a fake.
public protocol DictionarySyncTransport: Sendable {
    func pullDictionary(since: Int64?) async throws -> DictionaryPullResponse
    func pushDictionary(_ entries: [CloudDictionaryEntry]) async throws -> DictionaryPushResponse
}

/// What sync remembers between runs, per account.
public struct DictionarySyncState: Codable, Equatable, Sendable {
    /// The cloud's state of a phrase as of the last sync, and how much of it
    /// this phone holds.
    ///
    /// The phone cannot always hold all of a phrase: a variant may be one it
    /// refuses as a correction (a single CJK character), or the lexicon's caps
    /// (200 terms, 500 pairs) may have evicted part or all of it. The rule that
    /// keeps that from costing the account data: **the phone only ever removes
    /// what it held and the user removed.** So the snapshot keeps the FULL
    /// variant list the cloud has, and separately what the phone held of it;
    /// every push carries the variants it never held unchanged, and a phrase it
    /// never held is never pushed or tombstoned.
    public struct Synced: Codable, Equatable, Sendable {
        public var id: String
        /// Every variant the cloud has for the phrase.
        public var variants: [String]
        /// The subset of `variants` this phone held as confirmed corrections.
        public var held: [String]
        /// Whether this phone held the phrase at all (a term or a correction).
        public var heldPhrase: Bool
        /// The cloud's `source`, sent back on a deletion.
        public var source: String

        public init(
            id: String, variants: [String], held: [String]? = nil, heldPhrase: Bool = true,
            source: String = "manual"
        ) {
            self.id = id
            self.variants = variants
            self.held = held ?? variants
            self.heldPhrase = heldPhrase
            self.source = source
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            variants = (try? c.decodeIfPresent([String].self, forKey: .variants)) ?? []
            held = (try? c.decodeIfPresent([String].self, forKey: .held)) ?? variants
            heldPhrase = (try? c.decodeIfPresent(Bool.self, forKey: .heldPhrase)) ?? true
            source = (try? c.decodeIfPresent(String.self, forKey: .source)) ?? "manual"
        }
    }

    /// The account the snapshot belongs to — another account starts over.
    public var userId: String?
    /// The previous successful pull's `now`; nil = never synced.
    public var cursor: Int64?
    public var synced: [String: Synced]
    /// phrase → when this phone first noticed it gone (not yet confirmed).
    public var pendingDeletes: [String: Int64]
    /// phrase → fingerprint of a local form the cloud refused for good.
    public var parked: [String: String]
    /// When the user last chose "Clear the dictionary", until a sync carries it
    /// out. Lets a deliberate clear through the empty-dictionary guard.
    public var clearedAt: Int64?
    /// When the last run finished cleanly, for the status line.
    public var lastSyncedAt: Int64?
    /// Whether the most recent run failed.
    public var lastFailed: Bool

    public init(userId: String?) {
        self.userId = userId
        cursor = nil
        synced = [:]
        pendingDeletes = [:]
        parked = [:]
        clearedAt = nil
        lastSyncedAt = nil
        lastFailed = false
    }

    /// Tolerant like the lexicon: a field missing from an older or hand-edited
    /// file falls back to its empty value instead of costing the snapshot.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        userId = try? c.decodeIfPresent(String.self, forKey: .userId)
        cursor = try? c.decodeIfPresent(Int64.self, forKey: .cursor)
        synced = (try? c.decodeIfPresent([String: Synced].self, forKey: .synced)) ?? [:]
        pendingDeletes = (try? c.decodeIfPresent([String: Int64].self, forKey: .pendingDeletes)) ?? [:]
        parked = (try? c.decodeIfPresent([String: String].self, forKey: .parked)) ?? [:]
        clearedAt = try? c.decodeIfPresent(Int64.self, forKey: .clearedAt)
        lastSyncedAt = try? c.decodeIfPresent(Int64.self, forKey: .lastSyncedAt)
        lastFailed = (try? c.decodeIfPresent(Bool.self, forKey: .lastFailed)) ?? false
    }
}

/// Where `run` reads and writes. `LexiconSyncStore` is the real one.
public protocol DictionarySyncStorage {
    func loadLexicon() -> Lexicon
    func saveLexicon(_ lexicon: Lexicon)
    func loadState() -> DictionarySyncState?
    func saveState(_ state: DictionarySyncState)
}

public enum DictionarySync {
    /// The server's per-request cap.
    public static let pushBatch = 500
    /// An empty projection where the snapshot remembers at least this many
    /// phrases is taken for a lost file, not a wipe — same rule as the desktop.
    public static let resetGuardMin = 10
    /// Refusals that go away on their own; any other code means the cloud will
    /// never take this form of the entry.
    static let transientRejections: Set<String> = ["conflict", "entry_limit"]

    // MARK: projection

    /// One phrase as the phone holds it.
    public struct Projected: Equatable, Sendable {
        public var phrase: String
        /// Sorted, so the comparison with the snapshot ignores order.
        public var variants: [String]
        public var source: String
        public var updatedAt: Int64
    }

    /// The lexicon as cloud entries, keyed by phrase. See the file header for
    /// what is and is not included.
    public static func project(_ lexicon: Lexicon) -> [String: Projected] {
        var out: [String: Projected] = [:]
        for term in lexicon.terms {
            let phrase = term.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !phrase.isEmpty else { continue }
            let at = ms(term.updatedAt)
            if var p = out[phrase] {
                p.updatedAt = max(p.updatedAt, at)
                out[phrase] = p
            } else {
                out[phrase] = Projected(phrase: phrase, variants: [], source: "manual", updatedAt: at)
            }
        }
        for pair in lexicon.pairs where pair.count >= Lexicon.autoApplyThreshold {
            let phrase = pair.replacement.trimmingCharacters(in: .whitespacesAndNewlines)
            let original = pair.original.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !phrase.isEmpty, !original.isEmpty, original != phrase else { continue }
            var p =
                out[phrase] ?? Projected(phrase: phrase, variants: [], source: "learned", updatedAt: 0)
            if !p.variants.contains(original) { p.variants.append(original) }
            p.updatedAt = max(p.updatedAt, ms(pair.updatedAt))
            out[phrase] = p
        }
        for key in out.keys { out[key]?.variants.sort() }
        return out
    }

    /// Whether the phone can hold `variant → phrase` as a correction. The
    /// desktop has no such rules, so a variant it learned can be one the phone
    /// refuses (a single CJK character, say); those are carried through
    /// untouched rather than read as deleted.
    public static func representable(_ variant: String, for phrase: String) -> Bool {
        Lexicon.problem(original: variant, replacement: phrase) == nil
    }

    static func fingerprint(_ p: Projected?) -> String {
        guard let p else { return "-" }
        return "+" + p.variants.joined(separator: "\u{1F}")
    }

    /// The fingerprint a phrase has locally when nothing changed here since the
    /// last sync: absent if the phone did not hold it, else what it held.
    static func syncedFingerprint(_ state: DictionarySyncState, _ phrase: String) -> String {
        guard let s = state.synced[phrase], s.heldPhrase else { return "-" }
        return "+" + s.held.sorted().joined(separator: "\u{1F}")
    }

    // MARK: outgoing

    public struct Outgoing: Equatable, Sendable {
        public var entries: [CloudDictionaryEntry]
        /// phrase → fingerprint of the local state the entry was built from.
        public var sentFrom: [String: String]
        public var pendingDeletes: [String: Int64]
        /// Phrases the user removed here that still carry variants this phone
        /// never held: they go up live with only those, and the phone lets go
        /// of them rather than writing them back.
        public var released: Set<String>
        /// The empty-dictionary guard set the snapshot aside.
        public var reset: Bool
    }

    /// What has to go up: one entry per phrase that is new or changed here, and
    /// one per phrase the user removed here.
    ///
    /// Every entry is built by the rule on `DictionarySyncState.Synced`: the
    /// variants held here as they are now, plus every variant the cloud has that
    /// the phone never held. A removed phrase is a tombstone only when the phone
    /// held all of it; otherwise it goes up live with just the variants the
    /// phone never held, so a deletion here cannot reach past what the user saw.
    /// A phrase the phone never held is skipped entirely.
    ///
    /// Guard: a dictionary that is suddenly EMPTY while the snapshot remembers
    /// `resetGuardMin` or more phrases held here is a lost or restored-without-it
    /// file far more often than a deliberate wipe, and pushing it as deletions
    /// would empty the desktop too. Unless the user chose "Clear the dictionary"
    /// (`clearedAt`), the snapshot is set aside and the merge brings the entries
    /// back.
    public static func outgoing(
        _ projection: [String: Projected], state: DictionarySyncState, now: Int64,
        newId: () -> String = { UUID().uuidString.lowercased() }
    ) -> Outgoing {
        let heldCount = state.synced.values.filter(\.heldPhrase).count
        let reset = projection.isEmpty && heldCount >= resetGuardMin && state.clearedAt == nil
        var entries: [CloudDictionaryEntry] = []
        var sentFrom: [String: String] = [:]

        for phrase in projection.keys.sorted() {
            let p = projection[phrase]!
            let fp = fingerprint(p)
            if fp == syncedFingerprint(state, phrase) || state.parked[phrase] == fp { continue }
            let synced = state.synced[phrase]
            entries.append(
                CloudDictionaryEntry(
                    id: synced?.id ?? newId(), phrase: phrase,
                    variants: merged(local: p.variants, synced: synced),
                    source: p.source, updatedAt: p.updatedAt))
            sentFrom[phrase] = fp
        }

        var pendingDeletes: [String: Int64] = [:]
        var released: Set<String> = []
        if !reset {
            for phrase in state.synced.keys.sorted() where projection[phrase] == nil {
                let synced = state.synced[phrase]!
                guard synced.heldPhrase else { continue }
                let at = state.pendingDeletes[phrase] ?? state.clearedAt ?? now
                pendingDeletes[phrase] = at
                let unheld = merged(local: [], synced: synced)
                if unheld.isEmpty {
                    entries.append(
                        CloudDictionaryEntry(
                            id: synced.id, phrase: phrase, variants: [], source: synced.source,
                            updatedAt: at, deletedAt: at))
                } else {
                    entries.append(
                        CloudDictionaryEntry(
                            id: synced.id, phrase: phrase, variants: unheld, source: synced.source,
                            updatedAt: at))
                    released.insert(phrase)
                }
                sentFrom[phrase] = "-"
            }
        }
        return Outgoing(
            entries: entries, sentFrom: sentFrom, pendingDeletes: pendingDeletes,
            released: released, reset: reset)
    }

    /// The variants to send for a phrase: what is held here now, then every
    /// variant the cloud had that the phone never held — in the cloud's order.
    /// The only variants that can drop out are ones the phone held and no
    /// longer does, which is exactly what the user removed.
    static func merged(local: [String], synced: DictionarySyncState.Synced?) -> [String] {
        var out = local
        if let synced {
            let held = Set(synced.held)
            for v in synced.variants where !held.contains(v) && !out.contains(v) {
                out.append(v)
            }
        }
        return out
    }

    // MARK: applying

    /// The result of one exchange with the cloud.
    public struct Exchange: Equatable, Sendable {
        /// Rows from the pull: other devices' changes, plus echoes of ours.
        public var pulled: [CloudDictionaryEntry]
        /// The merged rows the pushes answered with.
        public var pushed: [CloudDictionaryEntry]
        /// Refusals, resolved back to their phrase.
        public var rejected: [(phrase: String, error: String)]

        public init(
            pulled: [CloudDictionaryEntry], pushed: [CloudDictionaryEntry],
            rejected: [(phrase: String, error: String)] = []
        ) {
            self.pulled = pulled
            self.pushed = pushed
            self.rejected = rejected
        }

        public static func == (a: Exchange, b: Exchange) -> Bool {
            a.pulled == b.pulled && a.pushed == b.pushed
                && a.rejected.map { "\($0.phrase)\u{1F}\($0.error)" }
                    == b.rejected.map { "\($0.phrase)\u{1F}\($0.error)" }
        }
    }

    /// Fold an exchange into the CURRENT lexicon (re-read after the network
    /// round trip — the keyboard may have written in the meantime) and the
    /// snapshot. Returns the new lexicon, or nil when the file needs no write.
    ///
    /// A pulled row only touches a phrase still untouched here; a pushed row
    /// only one that looks exactly as it did when it was sent. Anything edited
    /// in between is left for the next run.
    public static func apply(
        _ lexicon: Lexicon, state: DictionarySyncState, outgoing: Outgoing, exchange: Exchange
    ) -> (lexicon: Lexicon?, state: DictionarySyncState) {
        let projection = project(lexicon)
        func current(_ phrase: String) -> String { fingerprint(projection[phrase]) }

        var next = state
        if outgoing.reset { next.synced = [:] }
        next.pendingDeletes = outgoing.pendingDeletes

        var rows: [String: CloudDictionaryEntry] = [:]
        for row in exchange.pulled {
            if outgoing.sentFrom[row.phrase] != nil { continue }
            if current(row.phrase) != syncedFingerprint(next, row.phrase) { continue }
            // Nothing new: an echo of what is already agreed (our own push, or
            // the overlap window). Re-applying it would bring back a phrase the
            // phone let go of, or re-run caps that already evicted it.
            if let known = next.synced[row.phrase], row.deletedAt == nil, known.id == row.id,
                Set(known.variants) == Set(row.variants)
            {
                continue
            }
            rows[row.phrase] = row
        }
        for row in exchange.pushed where outgoing.sentFrom[row.phrase] == current(row.phrase) {
            rows[row.phrase] = row
        }
        for (phrase, error) in exchange.rejected where !transientRejections.contains(error) {
            guard let fp = outgoing.sentFrom[phrase], fp == current(phrase) else { continue }
            if projection[phrase] != nil {
                next.parked[phrase] = fp
            } else {
                next.synced[phrase] = nil
                next.pendingDeletes[phrase] = nil
            }
        }
        guard !rows.isEmpty else { return (nil, next) }

        var lex = lexicon
        for phrase in rows.keys.sorted() {
            let row = rows[phrase]!
            next.pendingDeletes[phrase] = nil
            next.parked[phrase] = nil
            if row.deletedAt != nil {
                lex.terms.removeAll { $0.text == phrase }
                lex.pairs.removeAll {
                    $0.replacement == phrase && $0.count >= Lexicon.autoApplyThreshold
                }
            } else if !outgoing.released.contains(phrase) {
                // A released phrase is one the user removed here; what is left
                // of it in the cloud is not written back.
                write(row, into: &lex)
            }
        }
        // Caps, as every other write to the lexicon is held to them.
        lex.evict()

        // The snapshot keeps the cloud's whole row, and records what the phone
        // actually ended up holding of it — so neither a refused variant nor
        // one the caps evicted can ever be read as a deletion made here.
        let after = project(lex)
        for (phrase, row) in rows {
            guard row.deletedAt == nil else {
                next.synced[phrase] = nil
                continue
            }
            let held = after[phrase]?.variants.filter { row.variants.contains($0) } ?? []
            next.synced[phrase] = DictionarySyncState.Synced(
                id: row.id, variants: row.variants, held: held, heldPhrase: after[phrase] != nil,
                source: row.source)
        }
        return (lex == lexicon ? nil : lex, next)
    }

    /// Make the lexicon hold `row`: its variants as confirmed corrections, and
    /// a term when the row is a plain term, was typed in by hand, or carries
    /// nothing the phone can hold as a correction.
    static func write(_ row: CloudDictionaryEntry, into lex: inout Lexicon) {
        let phrase = row.phrase
        let date = date(row.updatedAt)
        var variants: [String] = []
        for v in row.variants where representable(v, for: phrase) && !variants.contains(v) {
            variants.append(v)
        }
        // Confirmed corrections into this phrase that the row no longer has.
        // Ones still being learned are left: they are this phone's guesses and
        // never went up.
        lex.pairs.removeAll {
            $0.replacement == phrase && $0.count >= Lexicon.autoApplyThreshold
                && !variants.contains($0.original)
        }
        for v in variants {
            if let i = lex.pairs.firstIndex(where: { $0.original == v }) {
                if lex.pairs[i].replacement == phrase {
                    lex.pairs[i].count = max(lex.pairs[i].count, Lexicon.autoApplyThreshold)
                } else {
                    // The cloud's mapping wins over this phone's for the same
                    // misheard form — it is the newer word on the matter.
                    lex.pairs[i] = LexiconPair(
                        original: v, replacement: phrase, count: Lexicon.autoApplyThreshold,
                        updatedAt: date)
                }
            } else {
                lex.pairs.append(
                    LexiconPair(
                        original: v, replacement: phrase, count: Lexicon.autoApplyThreshold,
                        updatedAt: date))
            }
        }
        let hasTerm = lex.terms.contains { $0.text == phrase }
        if !hasTerm && (variants.isEmpty || row.source == "manual") {
            lex.terms.append(LexiconTerm(text: phrase, updatedAt: date))
        }
    }

    // MARK: running

    public enum Outcome: Equatable, Sendable {
        case synced(pulled: Int, pushed: Int, refused: Int)
        case failed(String)
    }

    /// Whether the lexicon differs from what was last synced — cheap enough to
    /// ask after every local write, before scheduling a run.
    public static func hasLocalChanges(storage: DictionarySyncStorage, userId: String) -> Bool {
        let state = loadState(storage, userId: userId)
        return !outgoing(project(storage.loadLexicon()), state: state, now: 0).entries.isEmpty
    }

    static func loadState(_ storage: DictionarySyncStorage, userId: String) -> DictionarySyncState {
        guard let saved = storage.loadState() else { return DictionarySyncState(userId: userId) }
        if saved.userId == userId { return saved }
        // Another account: start over, but a clear the user asked for is
        // still theirs to carry out.
        var fresh = DictionarySyncState(userId: userId)
        fresh.clearedAt = saved.clearedAt
        return fresh
    }

    /// One full sync: pull, push, fold the result in, save. A failure writes
    /// nothing to the lexicon and keeps the cursor, so the next trigger simply
    /// tries again.
    public static func run(
        userId: String, transport: DictionarySyncTransport, storage: DictionarySyncStorage,
        now: () -> Date = Date.init
    ) async -> Outcome {
        var state = loadState(storage, userId: userId)
        let clearedAtStart = state.clearedAt
        let out = outgoing(project(storage.loadLexicon()), state: state, now: ms(now()))
        // Pinned before the network, so a failed run retries with the same times.
        state.pendingDeletes = out.pendingDeletes
        storage.saveState(state)

        do {
            let pulled = try await transport.pullDictionary(since: out.reset ? nil : state.cursor)
            var pushed: [CloudDictionaryEntry] = []
            var rejected: [(phrase: String, error: String)] = []
            var start = 0
            while start < out.entries.count {
                let batch = Array(out.entries[start..<min(start + pushBatch, out.entries.count)])
                let response = try await transport.pushDictionary(batch)
                pushed += response.entries
                for r in response.rejected where batch.indices.contains(r.index) {
                    rejected.append((batch[r.index].phrase, r.error))
                }
                start += pushBatch
            }

            let applied = apply(
                storage.loadLexicon(), state: state, outgoing: out,
                exchange: Exchange(pulled: pulled.entries, pushed: pushed, rejected: rejected))
            if let lexicon = applied.lexicon { storage.saveLexicon(lexicon) }
            var next = applied.state
            next.cursor = pulled.now
            next.lastSyncedAt = ms(now())
            next.lastFailed = false
            // The clear this run carried out is done; one made while it was in
            // flight still has to go up next time.
            let latestClear = storage.loadState()?.clearedAt
            next.clearedAt = latestClear == clearedAtStart ? nil : latestClear
            storage.saveState(next)
            return .synced(
                pulled: pulled.entries.count, pushed: out.entries.count, refused: rejected.count)
        } catch {
            state.lastFailed = true
            storage.saveState(state)
            return .failed(String(describing: error))
        }
    }

    // MARK: time

    static func ms(_ date: Date) -> Int64 {
        let v = (date.timeIntervalSince1970 * 1000).rounded(.down)
        return v.isFinite && v > 0 ? Int64(v) : 0
    }

    static func date(_ ms: Int64) -> Date {
        Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
    }
}

/// The sync snapshot on disk: `lexicon-sync.json`, next to `lexicon.json` in the
/// App Group container. Beside the lexicon on purpose — a container that loses
/// one loses both, so a snapshot can never outlive the dictionary it describes
/// and read the loss as a thousand deletions. Only the app reads or writes it;
/// the keyboard never networks.
public struct LexiconSyncStore: DictionarySyncStorage {
    public static let fileName = "lexicon-sync.json"

    public init() {}

    public func loadLexicon() -> Lexicon { LexiconStore.load() }
    public func saveLexicon(_ lexicon: Lexicon) { LexiconStore.save(lexicon) }

    public func loadState() -> DictionarySyncState? {
        guard let url = Self.url, let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(DictionarySyncState.self, from: data)
    }

    public func saveState(_ state: DictionarySyncState) {
        guard let url = Self.url, let data = try? JSONEncoder().encode(state) else { return }
        try? data.write(to: url, options: .atomic)
    }

    /// The user chose "Clear the dictionary": remember it, so the next sync
    /// carries the clear out instead of the empty-dictionary guard undoing it.
    public func noteCleared(now: Date = Date()) {
        var state = loadState() ?? DictionarySyncState(userId: nil)
        state.clearedAt = DictionarySync.ms(now)
        saveState(state)
    }

    private static var url: URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: DictationChannel.appGroup)?
            .appendingPathComponent(fileName)
    }
}
