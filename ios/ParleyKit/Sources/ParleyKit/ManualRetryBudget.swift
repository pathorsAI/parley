import Foundation

/// How many hand-triggered re-transcriptions each recording has already spent.
///
/// ## Why this is not a field on the queued request
///
/// `TranscriptCoverage.BackfillPolicy.maxManualRetries` bounds how often a
/// person may ask for the same audio to be transcribed again. The obvious place
/// to keep the count is the queue entry that carries the request — and that is
/// where the *attempt ordinal* does live. It cannot be where the budget lives,
/// because a finished backfill deletes its queue entry: the moment a re-run
/// succeeds, a count kept there is gone, and the next tap would read zero spent
/// and grant a fresh budget forever.
///
/// So the budget outlives the request. This type is the whole of it: a map from
/// recording id to spends, with no behaviour beyond deciding whether one more
/// is allowed.
///
/// ## What counts as spent
///
/// Only a transcription that actually *completed* — the rule documented on
/// `maxManualRetries`. A run that dies on a flat network has cost nobody
/// anything and stays queued, so it must not be charged; a job that came back
/// empty has been paid for upstream and must be. Enforcing that is the caller's
/// job (it is the only thing that knows how the run ended); `spend(for:)` is
/// deliberately explicit rather than something `nextAttempt(for:)` does on the
/// way past.
public struct ManualRetryBudget: Codable, Equatable, Sendable {
    /// Recording id → completed manual re-runs. Ids with nothing spent are
    /// absent rather than zero, so the file stays the size of the handful of
    /// recordings anyone has actually re-run.
    public private(set) var spent: [String: Int]

    public init(spent: [String: Int] = [:]) {
        self.spent = spent.filter { $0.value > 0 }
    }

    public func spentCount(for id: String) -> Int {
        max(0, spent[id] ?? 0)
    }

    /// How many more re-runs this recording may have. Never negative: a budget
    /// written by a build with a larger cap would otherwise read as a debt.
    public func remaining(
        for id: String, policy: TranscriptCoverage.BackfillPolicy = .standard
    ) -> Int {
        max(0, policy.maxManualRetries - spentCount(for: id))
    }

    public func allowsRetry(
        for id: String, policy: TranscriptCoverage.BackfillPolicy = .standard
    ) -> Bool {
        remaining(for: id, policy: policy) > 0
    }

    /// The ordinal to stamp on the request about to be queued: 1 for the first
    /// hand-triggered run, 2 for the next. A non-zero ordinal is also how the
    /// queue tells a manual re-run from the automatic backfill that ran itself,
    /// which is why the first one is 1 and not 0.
    public func nextAttempt(for id: String) -> Int {
        spentCount(for: id) + 1
    }

    /// Charge one completed re-run to this recording.
    ///
    /// Clamped at the cap: a request queued before the cap was lowered — or two
    /// runs that somehow raced — must not push the stored count past what any
    /// build can read back as "spent out", or `remaining` would go on returning
    /// 0 while the file grew.
    public mutating func spend(
        for id: String, policy: TranscriptCoverage.BackfillPolicy = .standard
    ) {
        guard !id.isEmpty else { return }
        spent[id] = min(policy.maxManualRetries, spentCount(for: id) + 1)
    }

    /// Give a recording its budget back — for a deletion, so the ledger does
    /// not keep a row for a recording that no longer exists.
    public mutating func forget(_ id: String) {
        spent[id] = nil
    }
}
