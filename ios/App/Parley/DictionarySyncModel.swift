import Foundation
import ParleyKit
import os

/// Keeps the personal dictionary in step with the account, so a term added on
/// the desktop is spelled right on the phone and a correction learned here
/// reaches the desktop. The rules live in `DictionarySync` (ParleyKit); this is
/// when they run, and what the dictionary screen says about it.
///
/// Only this process networks. The keyboard writes what it learns into the App
/// Group and never syncs; its changes go up on the app's next trigger.
///
/// Triggers:
/// - the account becoming known — launch with a stored session, or a sign-in;
/// - a few seconds after this app writes the lexicon (`LexiconStore.didSave`),
///   if that write left something to send;
/// - the app coming to the foreground, at most every `foregroundInterval` —
///   which is also when the keyboard's learning is picked up.
///
/// A failed run changes nothing and is simply tried again at the next trigger.
@MainActor
final class DictionarySyncModel: ObservableObject {
    static let shared = DictionarySyncModel()

    enum Status: Equatable {
        /// Signed out, or never synced on this account.
        case idle
        /// The first run on this account is in flight.
        case syncing
        case synced(Date)
        case failed(lastSynced: Date?)
    }

    @Published private(set) var status: Status = .idle
    /// Whether there is an account to sync with — the status line hides without one.
    @Published private(set) var active = false
    /// Bumped after every successful run, so an open dictionary screen re-reads
    /// the file a sync may have just rewritten.
    @Published private(set) var revision = 0

    /// Quiet period after a local edit, so a burst of edits goes up together.
    static let debounce: Duration = .seconds(3)
    /// Foregrounding syncs no more often than this.
    static let foregroundInterval: TimeInterval = 15 * 60

    private let storage = LexiconSyncStore()
    private var cloud: CloudClient?
    private var userId: String?
    private var running: Task<Void, Never>?
    private var again = false
    private var pendingEdit: Task<Void, Never>?
    private var lastAttempt: Date = .distantPast

    /// Counts only. Dictionary content is the user's and never goes in a log.
    private let log = Logger(subsystem: ParleyLog.subsystem, category: "dictionary-sync")

    /// Listen for this process's own lexicon writes. Once, at launch, before
    /// anything writes.
    func start() {
        LexiconStore.didSave = {
            Task { @MainActor in DictionarySyncModel.shared.localChange() }
        }
    }

    /// The account the app is signed in to — nil after a sign-out. A newly
    /// known account syncs straight away.
    func accountChanged(cloud: CloudClient, userId: String?) {
        let changed = userId != self.userId
        self.cloud = cloud
        self.userId = userId
        active = userId != nil
        guard let userId else {
            pendingEdit?.cancel()
            status = .idle
            return
        }
        guard changed else { return }
        status = Self.status(from: storage.loadState(), userId: userId)
        syncNow()
    }

    func foregrounded() {
        guard userId != nil, Date().timeIntervalSince(lastAttempt) >= Self.foregroundInterval
        else { return }
        syncNow()
    }

    /// The user chose "Clear the dictionary". Recorded before the clear is
    /// written, so the sync that write schedules carries it out rather than
    /// reading an emptied file as a lost one.
    func noteCleared() {
        storage.noteCleared()
    }

    private func localChange() {
        guard let userId, DictionarySync.hasLocalChanges(storage: storage, userId: userId)
        else { return }
        pendingEdit?.cancel()
        pendingEdit = Task { [weak self] in
            try? await Task.sleep(for: Self.debounce)
            guard !Task.isCancelled else { return }
            self?.syncNow()
        }
    }

    /// Overlapping requests share one run; one that arrives mid-run makes it
    /// go round once more, so an edit made during a sync is not left behind.
    func syncNow() {
        guard userId != nil else { return }
        if running != nil {
            again = true
            return
        }
        running = Task { [weak self] in
            guard let self else { return }
            repeat {
                again = false
                await runOnce()
            } while again
            running = nil
        }
    }

    private func runOnce() async {
        guard let cloud, let userId else { return }
        lastAttempt = Date()
        if status == .idle { status = .syncing }
        let outcome = await DictionarySync.run(userId: userId, transport: cloud, storage: storage)
        guard self.userId == userId else { return }
        switch outcome {
        case .synced(let pulled, let pushed, let refused):
            status = .synced(Date())
            revision += 1
            if pulled + pushed > 0 {
                log.info(
                    "synced: pulled \(pulled, privacy: .public), pushed \(pushed, privacy: .public), refused \(refused, privacy: .public)"
                )
            }
        case .failed(let reason):
            status = .failed(lastSynced: Self.lastSynced(storage.loadState(), userId: userId))
            log.error("sync failed, will retry: \(reason, privacy: .private)")
        }
    }

    private static func lastSynced(_ state: DictionarySyncState?, userId: String) -> Date? {
        guard let state, state.userId == userId, let at = state.lastSyncedAt else { return nil }
        return Date(timeIntervalSince1970: TimeInterval(at) / 1000)
    }

    private static func status(from state: DictionarySyncState?, userId: String) -> Status {
        let last = lastSynced(state, userId: userId)
        if state?.userId == userId, state?.lastFailed == true { return .failed(lastSynced: last) }
        return last.map(Status.synced) ?? .idle
    }
}
