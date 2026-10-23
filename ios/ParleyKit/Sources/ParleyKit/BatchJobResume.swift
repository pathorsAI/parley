import Foundation

/// A hosted batch job that has been created and not yet collected.
///
/// Written the moment `POST /stt/batch` answers, so a poll loop that iOS
/// suspends or cancels — the user locks the phone a minute after the meeting —
/// does not throw the job away with it. The next attempt for the same
/// recording polls this id again instead of uploading the whole file a second
/// time and starting a second job (one 107-minute recording went up three
/// times in four minutes this way, every job abandoned).
public struct BatchJobRecord: Codable, Equatable, Sendable {
    public let jobId: String
    /// The size of the audio the job was made from. A recording whose audio
    /// has changed since — a different file under the same key — must not be
    /// handed a transcript of the old one.
    public let audioBytes: Int
    public let createdAt: Date

    public init(jobId: String, audioBytes: Int, createdAt: Date) {
        self.jobId = jobId
        self.audioBytes = audioBytes
        self.createdAt = createdAt
    }

    /// How long a created job is worth coming back to. The cloud keeps a job's
    /// transcript for well under this; past it a resume would only find a 404.
    public static let maximumAge: TimeInterval = 72 * 60 * 60

    /// Whether this record may stand in for an upload of `audioBytes` bytes at
    /// `now`.
    public func isResumable(audioBytes: Int, now: Date) -> Bool {
        guard self.audioBytes == audioBytes else { return false }
        let age = now.timeIntervalSince(createdAt)
        return age >= 0 && age < Self.maximumAge
    }
}

/// Where outstanding batch jobs are remembered, keyed by whatever identifies
/// the audio to the caller (a recording id). Synchronous on purpose: every
/// operation is a dictionary read or write, and the transcriber calls it
/// between awaits.
public protocol BatchJobStore: Sendable {
    func job(for key: String) -> BatchJobRecord?
    func save(_ record: BatchJobRecord, for key: String)
    func clear(_ key: String)
}

/// For tests, and for callers that have nothing worth resuming.
public final class InMemoryBatchJobStore: BatchJobStore, @unchecked Sendable {
    private let lock = NSLock()
    private var records: [String: BatchJobRecord] = [:]

    public init() {}

    public func job(for key: String) -> BatchJobRecord? {
        lock.lock()
        defer { lock.unlock() }
        return records[key]
    }

    public func save(_ record: BatchJobRecord, for key: String) {
        lock.lock()
        records[key] = record
        lock.unlock()
    }

    public func clear(_ key: String) {
        lock.lock()
        records[key] = nil
        lock.unlock()
    }
}

/// The app's store: one JSON dictionary in `UserDefaults`. It holds a handful
/// of entries at most — one per recording mid-transcription — and expired
/// ones are dropped on every write, so it cannot grow without bound.
public final class UserDefaultsBatchJobStore: BatchJobStore, @unchecked Sendable {
    public static let defaultsKey = "parley.batchJobs.v1"

    private let defaults: UserDefaults
    private let lock = NSLock()
    private let now: @Sendable () -> Date

    public init(defaults: UserDefaults = .standard, now: @escaping @Sendable () -> Date = { Date() }) {
        self.defaults = defaults
        self.now = now
    }

    public func job(for key: String) -> BatchJobRecord? {
        lock.lock()
        defer { lock.unlock() }
        return load()[key]
    }

    public func save(_ record: BatchJobRecord, for key: String) {
        mutate { $0[key] = record }
    }

    public func clear(_ key: String) {
        mutate { $0[key] = nil }
    }

    private func mutate(_ change: (inout [String: BatchJobRecord]) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        let cutoff = now().addingTimeInterval(-BatchJobRecord.maximumAge)
        var records = load().filter { $0.value.createdAt > cutoff }
        change(&records)
        guard let data = try? JSONEncoder().encode(records) else { return }
        defaults.set(data, forKey: Self.defaultsKey)
    }

    private func load() -> [String: BatchJobRecord] {
        guard let data = defaults.data(forKey: Self.defaultsKey),
            let records = try? JSONDecoder().decode([String: BatchJobRecord].self, from: data)
        else { return [:] }
        return records
    }
}

/// Where one transcription remembers its job: the store, and the key the audio
/// is known by in it.
public struct BatchResume: Sendable {
    public let store: any BatchJobStore
    public let key: String

    public init(store: any BatchJobStore, key: String) {
        self.store = store
        self.key = key
    }
}
