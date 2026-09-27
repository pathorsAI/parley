import Foundation

/// One finished (or failed) dictation, as the app keeps it for the user to find
/// again. See `DictationHistoryStore`.
public struct DictationHistoryEntry: Codable, Identifiable, Equatable, Sendable {
    /// Which door the session came in through.
    public enum Source: String, Codable, Sendable {
        /// The Parley keyboard's microphone (`parley://dictate`, or the Darwin
        /// start request when the app was already awake).
        case keyboard
        /// The Action Button / Control Center App Intent.
        case actionButton
    }

    public var id: UUID
    /// The transcript exactly as it was handed to the keyboard — after the
    /// polish and the personal dictionary — or, for a session that failed, the
    /// words it had settled before it did.
    public var text: String
    public var startedAt: Date
    public var durationMs: Int
    public var source: Source
    /// The app the keyboard was typing into, when it could be resolved. Often
    /// `nil`: iOS 26.4 stopped handing it to keyboards (see `HostBundleID`).
    public var hostBundleID: String?

    public init(
        id: UUID = UUID(), text: String, startedAt: Date, durationMs: Int,
        source: Source, hostBundleID: String? = nil
    ) {
        self.id = id
        self.text = text
        self.startedAt = startedAt
        self.durationMs = durationMs
        self.source = source
        self.hostBundleID = hostBundleID
    }
}

/// What the user has dictated, kept on this phone so words that never landed
/// can be copied again (pathorsAI/parley#290).
///
/// Before this, a dictation's transcript existed in exactly one place once the
/// session ended: the text field it was typed into. The keyboard has four ways
/// of ending a session without inserting anything — the adoption window running
/// out, a downlink that `looksDead`, an `error`, and a field that is no longer
/// the one it started in — and every one of them used to lose the words for
/// good, precisely when something had already gone wrong.
///
/// ## Where the file lives, and where it deliberately does not
///
/// One JSON file, `dictation-history.json`, in a directory the caller passes.
/// The app passes **its own sandbox's Application Support — never the App Group
/// container.** The App Group is shared with the keyboard extension, and the
/// keyboard is the one process that must not be able to read transcript
/// history: it runs inside every app the user types into. So the keyboard
/// target does not reference this type at all, and the file is somewhere it
/// could not open even if it tried. Nothing here talks to the network either;
/// the hosted relay stores no transcript text, so this file is the only record.
///
/// ## Retention
///
/// The most recent `maxEntries` entries, **and** nothing older than `maxAge` —
/// whichever bound bites first. Pruned on every write and on every load, so an
/// entry that aged out while the app was not running is gone the moment the
/// history is looked at, not at the next dictation.
///
/// ## The switch
///
/// `isEnabled` is read on every `append`, and when it says no the append is a
/// no-op. It is enforced here rather than at the call site so the tests can
/// prove it. Turning it off keeps what is already stored; `clearAll()` is the
/// way to remove it.
///
/// Foundation only, with the directory and the clock injected, so all of the
/// above runs under `swift test` on a Mac.
public final class DictationHistoryStore: @unchecked Sendable {
    public static let fileName = "dictation-history.json"
    public static let maxEntries = 200
    public static let maxAge: TimeInterval = 30 * 24 * 60 * 60

    /// UserDefaults key for "Keep voice typing history". Lives next to the
    /// store for the same reason `LocalAudioStore.keepAudioKey` does: the
    /// coordinator writes with no view alive to have bound it.
    public static let enabledKey = "keepDictationHistory"

    /// **Defaults to true** — an unset key is "never touched", not "off".
    public static func isEnabled(in defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: enabledKey) as? Bool ?? true
    }

    public let fileURL: URL
    private let now: @Sendable () -> Date
    private let isEnabled: @Sendable () -> Bool
    private let lock = NSLock()

    /// - Parameters:
    ///   - directory: where `dictation-history.json` goes. The app passes its
    ///     sandbox's Application Support (see the type's doc comment); the
    ///     tests pass a temporary directory.
    ///   - now: the clock retention is measured against.
    ///   - isEnabled: the user's "Keep voice typing history" switch.
    public init(
        directory: URL,
        now: @escaping @Sendable () -> Date = { Date() },
        isEnabled: @escaping @Sendable () -> Bool = { true }
    ) {
        fileURL = directory.appendingPathComponent(Self.fileName)
        self.now = now
        self.isEnabled = isEnabled
    }

    /// The app sandbox's Application Support. Resolved per process, so even a
    /// keyboard that somehow built one of these would get its own empty
    /// container rather than the app's file.
    public static func defaultDirectory() -> URL {
        (try? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true))
            ?? FileManager.default.temporaryDirectory
    }

    // MARK: reading

    /// Every entry still inside retention, newest first.
    ///
    /// A missing file is an empty history, and so is one that does not decode:
    /// a history that crashes the app because the last write was torn is worse
    /// than one that starts again. If pruning dropped anything, the pruned list
    /// is written back so the file does not keep what the screen no longer
    /// shows.
    public func load() -> [DictationHistoryEntry] {
        lock.lock()
        defer { lock.unlock() }
        let stored = read()
        let kept = prune(stored)
        if kept.count != stored.count { write(kept) }
        return kept
    }

    // MARK: writing

    /// Keep one more dictation. Returns the history after the write, or `nil`
    /// when nothing was written — the switch is off, or the text is blank.
    @discardableResult
    public func append(_ entry: DictationHistoryEntry) -> [DictationHistoryEntry]? {
        guard isEnabled() else { return nil }
        guard !entry.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        lock.lock()
        defer { lock.unlock() }
        let kept = prune(read().filter { $0.id != entry.id } + [entry])
        write(kept)
        return kept
    }

    /// Remove one entry. Returns the history after the write.
    @discardableResult
    public func remove(id: UUID) -> [DictationHistoryEntry] {
        lock.lock()
        defer { lock.unlock() }
        let kept = prune(read().filter { $0.id != id })
        write(kept)
        return kept
    }

    /// "Clear all": the file goes, not just its contents.
    public func clearAll() {
        lock.lock()
        defer { lock.unlock() }
        try? FileManager.default.removeItem(at: fileURL)
    }

    // MARK: internals (lock held)

    /// Newest first, nothing older than `maxAge`, at most `maxEntries`.
    private func prune(_ entries: [DictationHistoryEntry]) -> [DictationHistoryEntry] {
        let cutoff = now().addingTimeInterval(-Self.maxAge)
        let fresh = entries.filter { $0.startedAt >= cutoff }
        let sorted = fresh.sorted { $0.startedAt > $1.startedAt }
        return Array(sorted.prefix(Self.maxEntries))
    }

    private func read() -> [DictationHistoryEntry] {
        guard let data = try? Data(contentsOf: fileURL) else { return [] }
        return (try? Self.decoder.decode([DictationHistoryEntry].self, from: data)) ?? []
    }

    private func write(_ entries: [DictationHistoryEntry]) {
        let fm = FileManager.default
        let directory = fileURL.deletingLastPathComponent()
        try? fm.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let data = try? Self.encoder.encode(entries) else { return }
        var options: Data.WritingOptions = [.atomic]
        #if os(iOS)
            // Readable after the first unlock, so a session that ends with the
            // phone locked (the Action Button works there) can still be kept.
            options.insert(.completeFileProtectionUntilFirstUserAuthentication)
        #endif
        guard (try? data.write(to: fileURL, options: options)) != nil else { return }
        // Kept out of iCloud backup: "on this phone only" is the promise the
        // privacy label makes, and a 30-day rescue buffer is not worth a copy
        // anywhere else.
        var url = fileURL
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }

    // Dates in the default encoding (seconds since the reference date, as a
    // Double) rather than ISO 8601, which would round every timestamp to the
    // second and make an entry read back unequal to the one written.
    private static let encoder = JSONEncoder()
    private static let decoder = JSONDecoder()
}
