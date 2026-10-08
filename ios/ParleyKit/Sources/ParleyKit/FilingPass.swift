import Foundation

/// The filing pass for one personal recording, run once and written down.
///
/// `FilingSuggester` asks the model; this decides whether to ask at all and
/// makes the answer stick. Three rules, shared with the desktop and Android:
///
/// 1. **Once per recording, whichever device.** `filingSuggested` on the synced
///    meta is the flag every platform reads. A recording that already carries
///    it is not asked about again — if its suggestion is still pending (another
///    device ran the pass and nobody has answered), that suggestion is what
///    comes back, so the phone shows the same title the Mac would.
/// 2. **Persisted the moment it exists.** A suggestion held only in memory is
///    lost the moment the user looks away, and the desktop — seeing no flag —
///    then runs its own, different pass and syncs a second title back. So a
///    successful pass is written into the meta straight away
///    (`filingSuggestion` + `filingSuggested: true`), and answering the card
///    later clears the suggestion as it always has.
/// 3. **Read-modify-write against a fresh copy.** The meta is fetched again
///    right before the push, so a rename or a move that landed while the model
///    was thinking is kept, and the summary pushed beside it is rebuilt from
///    that same copy (`CloudRecordingSummary(projecting:)`).
///
/// An actor so that two callers asking about the same recording — the upload
/// that just landed it and the record screen waiting to show a card — share
/// one pass instead of spending two.
public actor FilingPass {
    public static let shared = FilingPass()

    private var inFlight: [String: Task<FilingSuggestion?, Never>] = [:]

    public init() {}

    /// The suggestion pending on this recording once the pass has had its
    /// chance: freshly generated and persisted, or left by another device and
    /// still unanswered. nil when there is nothing to offer — the pass already
    /// ran and was answered, there was no transcript, the model had nothing,
    /// or something failed along the way (best-effort, like the pass itself).
    public func run(
        id: String, cloud: CloudClient, language: FilingSuggester.Language = .current
    ) async -> FilingSuggestion? {
        if let running = inFlight[id] { return await running.value }
        let task = Task { await Self.perform(id: id, cloud: cloud, language: language) }
        inFlight[id] = task
        let result = await task.value
        inFlight[id] = nil
        return result
    }

    /// Fire and forget, for the doors that have no card to show at that moment
    /// (an import, a queued upload that finally synced). The suggestion is in
    /// the meta afterwards, and the recording screen presents it when the
    /// recording is opened.
    public nonisolated func start(
        id: String, cloud: CloudClient, language: FilingSuggester.Language = .current
    ) {
        Task { _ = await self.run(id: id, cloud: cloud, language: language) }
    }

    static func perform(
        id: String, cloud: CloudClient, language: FilingSuggester.Language
    ) async -> FilingSuggestion? {
        do {
            let meta = try await cloud.recordingMeta(id: id)
            if meta.filingSuggested { return meta.filingSuggestion }

            let folders = try await cloud.listFolders().filter { $0.orgId == nil }
            guard
                let suggestion = try await FilingSuggester.suggest(
                    meta: meta, folders: folders, language: language, cloud: cloud)
            else { return nil }

            var fresh = try await cloud.recordingMeta(id: id)
            // Another device finished its own pass while this one ran. Its
            // answer is the one already synced, so it is the one to show.
            if fresh.filingSuggested { return fresh.filingSuggestion }
            fresh.filingSuggestion = suggestion
            fresh.filingSuggested = true
            do {
                try await cloud.pushRecording(
                    id: id, summary: CloudRecordingSummary(projecting: fresh), meta: fresh)
            } catch {
                // Still worth showing: answering the card writes the flag
                // anyway, and a suggestion lost to a flaky push is no worse
                // than the one this used to hold in memory.
            }
            return suggestion
        } catch {
            return nil
        }
    }
}
