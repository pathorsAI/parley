import Foundation

/// What the 注音 pane has learned from the candidates the user picked by hand:
/// in *this* context, for *this* reading, when the walk said X, they wanted Y.
///
/// It is McBopomofo's user override model (`Source/Engine/UserOverrideModel`,
/// MIT — see `ios/THIRD-PARTY.md`) carried over to a keyboard that commits
/// from the front of a six-syllable buffer rather than editing a sentence in
/// place, and it keeps their key: the two words before the node, the node's
/// reading, and the value the walk had chosen for it. The previous words are
/// what makes a correction safe to repeat — 他姓**鍾** is a fact about a
/// person, not about every ㄓㄨㄥ — and the walk's value is what makes it safe
/// to apply: a remembered choice replaces exactly the answer it once replaced
/// and nothing else.
///
/// **What counts as a lesson.** Only a candidate the user tapped that differs
/// from what the walk would have committed for the front of the buffer
/// (`ZhuyinComposer.pick`). Return and space commit the walk's own answer, so
/// they teach nothing; they only `touch` a remembered choice they used, which is
/// what keeps one in daily use from ageing out.
///
/// **How sure it is.** Each choice has a count and the time it was last used,
/// and its weight is the count halved every `halfLife` (seven days) since then.
/// A choice is offered once its weight reaches `suggestionThreshold` — two
/// picks, near enough together — and forgotten once it falls below
/// `dropThreshold`. One pick is not enough because one pick is ambiguous: the
/// user may have meant that word only that once. A second pick of the same
/// word in the same place is a preference.
///
/// **How much it keeps.** At most `capacity` (500) keys, least recently used
/// out first — McBopomofo's number. Each key is a handful of short strings, so
/// a full memory is a few hundred kilobytes at most (measured in the tests).
///
/// **Where it lives.** `zhuyin-memory.json` in the App Group, so the app's
/// Settings can reset it, read lazily on a background queue when the 注音 pane
/// warms its tables and written a couple of seconds after the last change, off
/// the keystroke. Without Full Access there is no App Group to write to, and
/// the memory is kept in this process only (`persists` false). The reset is a
/// counter in the App Group's defaults rather than only a deleted file,
/// because a keyboard holding the old memory would otherwise write it straight
/// back: the keyboard checks the counter before every write and on every
/// appearance (`honourReset`).
///
/// Not thread-safe, and it doesn't need to be: keys arrive on the main thread.
/// The only work off it is reading and writing the file, handed a copy.
public final class ZhuyinMemory {
    /// Where a lesson applies: the two words committed before the node, oldest
    /// first (fewer at the start of a field), the node's reading without tones,
    /// and the value the walk had chosen for it.
    ///
    /// The reading is the syllables **as typed**, tones dropped: `ㄧㄢ ㄐㄧㄡ`
    /// and `ㄧㄢˊ ㄐㄧㄡˋ` are one lesson, but `ㄧ ㄐ` — the same word typed as
    /// two lone symbols — is another, because a key built from a part-typed
    /// buffer cannot know which full reading it would have become.
    public struct Key: Hashable, Codable, Sendable {
        public var context: [String]
        public var reading: String
        public var value: String

        public init(context: [String], reading: String, value: String) {
            self.context = Array(context.suffix(2))
            self.reading = reading
            self.value = value
        }
    }

    /// What the memory offers for a key.
    public struct Suggestion: Equatable, Sendable {
        public let value: String
        /// The user chose a longer phrase than the walk had there. McBopomofo
        /// then overrides with a score no path can beat (their
        /// `kOverrideValueWithHighScore`): a two-character phrase loses to the
        /// characters that spell it more often than it should, which is often
        /// why the walk chose those characters in the first place.
        public let longer: Bool
    }

    /// One remembered choice.
    struct Choice: Codable, Equatable {
        var value: String
        /// The weight as of `lastUsed`: a pick adds one to what is left of the
        /// old weight. A `Double` because the weight decays between picks.
        var count: Double
        var lastUsed: Date
        var longer: Bool
    }

    struct Entry: Codable, Equatable {
        var key: Key
        var choices: [Choice]
    }

    /// McBopomofo's capacity for the same model.
    public static let capacity = 500
    /// A remembered choice loses half its weight for every week it goes unused.
    public static let halfLife: TimeInterval = 7 * 24 * 60 * 60
    /// The weight at which a choice is offered: two picks, the second within
    /// about three days of the first, or more picks over a longer time.
    public static let suggestionThreshold = 1.5
    /// Below this a choice is forgotten: one pick after two weeks, two after
    /// three.
    public static let dropThreshold = 0.25

    /// The file in the App Group.
    public static let fileName = "zhuyin-memory.json"
    /// The App Group defaults key Settings bumps to reset the keyboard's
    /// memory. See `requestReset`.
    public static let resetGenerationKey = "zhuyinMemoryResetGeneration"

    /// The keyboard's memory: the App Group file, once `persists` is set.
    public static let keyboard = ZhuyinMemory(
        url: keyboardURL, defaults: UserDefaults(suiteName: DictationChannel.appGroup))

    private let url: URL?
    private let defaults: UserDefaults?

    private var entries: [Key: Entry] = [:]
    /// Recency for the LRU: a tick per use, larger is more recent.
    private var recency: [Key: UInt64] = [:]
    private var tick: UInt64 = 0
    /// How many keys carry each reading — so a refresh can tell, without
    /// walking, that nothing in the buffer could have a suggestion.
    private var readings: [String: Int] = [:]

    /// Whether the file has been read (or there is none to read).
    private var loaded = false
    private var loading = false
    private var onLoaded: [() -> Void] = []
    /// The reset counter as of the memory this process holds.
    private var generation = 0
    private var saveScheduled: DispatchWorkItem?
    /// How long after the last change the file is written.
    static let saveDelay: TimeInterval = 2
    private static let io = DispatchQueue(label: "com.pathors.parley.zhuyin-memory", qos: .utility)

    /// Whether the memory is read from and written to `url`. Off without Full
    /// Access, where the keyboard has no App Group to write to and keeps what
    /// it learns for the life of the process. Turning it on reads the file
    /// again on the next `warm`, keeping what was learned meanwhile.
    public var persists = false {
        didSet {
            guard persists, !oldValue else { return }
            loaded = false
        }
    }

    /// `url` nil is a memory that never touches a disk.
    public init(url: URL?, defaults: UserDefaults? = nil) {
        self.url = url
        self.defaults = defaults
    }

    /// The number of keys held.
    public var count: Int { entries.count }
    public var isEmpty: Bool { entries.isEmpty }

    // MARK: learning

    /// The user picked `value` where the walk had `key.value`.
    public func observe(_ key: Key, chose value: String, longer: Bool, now: Date = Date()) {
        guard value != key.value, !value.isEmpty else { return }
        var entry = entries[key] ?? Entry(key: key, choices: [])
        if let i = entry.choices.firstIndex(where: { $0.value == value }) {
            let old = entry.choices[i]
            entry.choices[i].count = Self.weight(old, at: now) + 1
            entry.choices[i].lastUsed = now
            entry.choices[i].longer = longer
        } else {
            entry.choices.append(Choice(value: value, count: 1, lastUsed: now, longer: longer))
        }
        store(entry)
        evictIfNeeded()
        scheduleSave()
    }

    /// The choice to offer for `key`, if one is sure enough — the heaviest of
    /// those past `suggestionThreshold`.
    public func suggestion(for key: Key, now: Date = Date()) -> Suggestion? {
        guard let entry = entries[key] else { return nil }
        var best: (choice: Choice, weight: Double)?
        for choice in entry.choices {
            let weight = Self.weight(choice, at: now)
            guard weight >= Self.suggestionThreshold else { continue }
            if weight > best?.weight ?? 0 { best = (choice, weight) }
        }
        return best.map { Suggestion(value: $0.choice.value, longer: $0.choice.longer) }
    }

    /// A remembered choice was committed by return or space: it is still the
    /// user's, so its age starts again. Its count does not grow — accepting
    /// what the keyboard offered is not a new lesson.
    public func touch(_ key: Key, value: String, now: Date = Date()) {
        guard var entry = entries[key],
            let i = entry.choices.firstIndex(where: { $0.value == value })
        else { return }
        entry.choices[i].lastUsed = now
        store(entry)
        scheduleSave()
    }

    /// Whether any key still remembers `value`. What the long press asks before
    /// it offers to forget one.
    public func produces(_ value: String) -> Bool {
        entries.values.contains { $0.choices.contains { $0.value == value } }
    }

    /// Forget every choice of `value`, wherever it was learned. Nothing else
    /// moves: a word the user asked never to see suggested again has no
    /// business demoting the words beside it. `true` if anything was removed.
    @discardableResult
    public func forget(_ value: String) -> Bool {
        var removed = false
        for (key, var entry) in entries {
            let before = entry.choices.count
            entry.choices.removeAll { $0.value == value }
            guard entry.choices.count != before else { continue }
            removed = true
            if entry.choices.isEmpty { remove(key) } else { entries[key] = entry }
        }
        if removed { scheduleSave() }
        return removed
    }

    /// Forget everything, and write that.
    public func removeAll() {
        entries = [:]
        recency = [:]
        readings = [:]
        scheduleSave()
    }

    /// Whether any key is for this reading. A refresh asks this of every window
    /// at the front of the buffer before it pays for a walk.
    public func knows(reading: String) -> Bool {
        readings[reading] != nil
    }

    // MARK: weight

    /// A choice's weight at `now`: its count, halved for every `halfLife` since
    /// it was last used.
    static func weight(_ choice: Choice, at now: Date) -> Double {
        let age = max(0, now.timeIntervalSince(choice.lastUsed))
        return choice.count * pow(0.5, age / halfLife)
    }

    // MARK: bookkeeping

    private func store(_ entry: Entry) {
        if entries[entry.key] == nil { readings[entry.key.reading, default: 0] += 1 }
        entries[entry.key] = entry
        tick += 1
        recency[entry.key] = tick
    }

    private func remove(_ key: Key) {
        guard entries.removeValue(forKey: key) != nil else { return }
        recency[key] = nil
        if let n = readings[key.reading], n > 1 {
            readings[key.reading] = n - 1
        } else {
            readings[key.reading] = nil
        }
    }

    /// The least recently used key goes first. A linear scan, and only when a
    /// key is added past capacity — five hundred comparisons on a pick.
    private func evictIfNeeded() {
        while entries.count > Self.capacity {
            guard let oldest = recency.min(by: { $0.value < $1.value })?.key else { return }
            remove(oldest)
        }
    }

    /// Drop every choice whose weight has fallen below `dropThreshold`, and
    /// every key left with none.
    func prune(now: Date = Date()) {
        for (key, var entry) in entries {
            entry.choices.removeAll { Self.weight($0, at: now) < Self.dropThreshold }
            if entry.choices.isEmpty { remove(key) } else { entries[key] = entry }
        }
    }

    // MARK: the file

    struct File: Codable {
        var version = 1
        /// Most recently used first, so the LRU order survives the round trip.
        var entries: [Entry]
    }

    /// The memory as it would be written: pruned, most recently used first.
    func snapshot(now: Date = Date()) -> File {
        prune(now: now)
        let ordered = entries.values.sorted {
            (recency[$0.key] ?? 0) > (recency[$1.key] ?? 0)
        }
        return File(entries: ordered)
    }

    /// Take a file's entries, keeping anything learned in this process that the
    /// file does not know — a pick that beat the read. Oldest first, so the
    /// file's own order becomes the recency order.
    func merge(_ file: File, now: Date = Date()) {
        let learned = entries.values.sorted { (recency[$0.key] ?? 0) < (recency[$1.key] ?? 0) }
        entries = [:]
        recency = [:]
        readings = [:]
        for entry in file.entries.reversed() { store(entry) }
        for entry in learned { store(entry) }
        prune(now: now)
        evictIfNeeded()
    }

    /// Read the file off the main thread, if it has not been read, and call
    /// `onReady` on the main queue once it has. Straight away when there is
    /// nothing to read. The keyboard calls this with the 注音 tables' warm.
    public func warm(onReady: (() -> Void)? = nil) {
        honourReset()
        guard persists, !loaded, let url else {
            onReady?()
            return
        }
        if let onReady { onLoaded.append(onReady) }
        guard !loading else { return }
        loading = true
        let generation = currentGeneration()
        Self.io.async {
            let file = Self.read(url)
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.loading = false
                self.loaded = true
                // A reset that landed while the file was being read wins.
                if generation == self.currentGeneration(), let file { self.merge(file) }
                self.generation = generation
                let waiting = self.onLoaded
                self.onLoaded = []
                waiting.forEach { $0() }
            }
        }
    }

    /// Read synchronously. For the tests, and for a caller that cannot wait.
    func loadNow() {
        guard let url else { return }
        loaded = true
        generation = currentGeneration()
        if let file = Self.read(url) { merge(file) }
    }

    /// If Settings reset the memory since this process last looked, forget
    /// everything held here too. Called on every appearance of the keyboard and
    /// before every write.
    public func honourReset() {
        guard persists else { return }
        let current = currentGeneration()
        guard current != generation else { return }
        generation = current
        entries = [:]
        recency = [:]
        readings = [:]
    }

    /// Write a couple of seconds after the last change, off the main thread.
    private func scheduleSave() {
        guard persists, url != nil else { return }
        saveScheduled?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.save() }
        saveScheduled = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.saveDelay, execute: work)
    }

    /// Write now, if anything is waiting to be written — for the keyboard going
    /// away, which may be the last chance this process gets.
    public func flush() {
        guard let pending = saveScheduled else { return }
        pending.cancel()
        save()
    }

    /// Hand a copy to the I/O queue. The memory is copied here, on the main
    /// thread; encoding and writing happen there. A reset that lands between
    /// the two wins: the write is skipped and the next appearance clears the
    /// copy held here.
    func save(synchronously: Bool = false) {
        saveScheduled = nil
        guard persists, let url else { return }
        honourReset()
        let file = snapshot()
        let generation = self.generation
        let defaults = self.defaults
        let write = {
            let current = defaults?.integer(forKey: Self.resetGenerationKey) ?? 0
            guard current == generation else { return }
            Self.write(file, to: url)
        }
        if synchronously { Self.io.sync(execute: write) } else { Self.io.async(execute: write) }
    }

    private func currentGeneration() -> Int {
        defaults?.integer(forKey: Self.resetGenerationKey) ?? 0
    }

    private static func read(_ url: URL) -> File? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? decoder.decode(File.self, from: data)
    }

    private static func write(_ file: File, to url: URL) {
        guard let data = try? encoder.encode(file) else { return }
        try? data.write(to: url, options: .atomic)
    }

    /// Settings' "Reset Zhuyin learning": delete the file and bump the counter,
    /// so a keyboard holding the old memory drops it rather than writing it
    /// back. Safe to call from the app at any time.
    public static func requestReset(
        url: URL? = keyboardURL, defaults: UserDefaults? = UserDefaults(suiteName: DictationChannel.appGroup)
    ) {
        if let defaults {
            defaults.set(defaults.integer(forKey: resetGenerationKey) + 1, forKey: resetGenerationKey)
        }
        if let url { try? FileManager.default.removeItem(at: url) }
    }

    /// Where the keyboard's file lives.
    public static var keyboardURL: URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: DictationChannel.appGroup)?
            .appendingPathComponent(fileName)
    }

    private static var encoder: JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .secondsSince1970
        return e
    }

    private static var decoder: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .secondsSince1970
        return d
    }
}
