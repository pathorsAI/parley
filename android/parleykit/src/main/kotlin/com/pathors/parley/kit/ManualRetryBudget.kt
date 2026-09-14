package com.pathors.parley.kit

import kotlinx.serialization.Serializable

/**
 * How many hand-triggered re-transcriptions each recording has already spent.
 *
 * ## Why this is not a field on the queued request
 *
 * [TranscriptCoverage.BackfillPolicy.maxManualRetries] bounds how often a person
 * may ask for the same audio to be transcribed again. The obvious place to keep
 * the count is the queue entry that carries the request — and that is where the
 * *attempt ordinal* does live. It cannot be where the budget lives, because a
 * finished backfill deletes its queue entry: the moment a re-run succeeds, a
 * count kept there is gone, and the next tap would read zero spent and grant a
 * fresh budget forever.
 *
 * So the budget outlives the request. This type is the whole of it: a map from
 * recording id to spends, with no behaviour beyond deciding whether one more is
 * allowed. Where it is *stored* is `upload/ManualRetryLedger.kt`.
 *
 * ## What counts as spent
 *
 * Only a transcription that actually *completed* — the rule documented on
 * `maxManualRetries`. A run that dies on a flat network has cost nobody anything
 * and stays queued, so it must not be charged; a job that came back empty has
 * been paid for upstream and must be. Enforcing that is the caller's job (it is
 * the only thing that knows how the run ended); [spend] is deliberately explicit
 * rather than something [nextAttempt] does on the way past.
 *
 * Immutable, unlike the Swift original's `mutating func`: every caller here is
 * "read the ledger, change one entry, write it back", and a value that cannot be
 * half-updated is one fewer thing for the file writer to get wrong.
 */
@Serializable
data class ManualRetryBudget(
    /**
     * Recording id → completed manual re-runs. Ids with nothing spent are absent
     * rather than zero, so the file stays the size of the handful of recordings
     * anyone has actually re-run. [of] is what enforces that on the way in;
     * a map decoded from an older file is tolerated by [spentCount] instead.
     */
    val spent: Map<String, Int> = emptyMap(),
) {

    fun spentCount(id: String): Int = (spent[id] ?: 0).coerceAtLeast(0)

    /**
     * How many more re-runs this recording may have. Never negative: a budget
     * written by a build with a larger cap would otherwise read as a debt.
     */
    fun remaining(
        id: String,
        policy: TranscriptCoverage.BackfillPolicy = TranscriptCoverage.BackfillPolicy.STANDARD,
    ): Int = (policy.maxManualRetries - spentCount(id)).coerceAtLeast(0)

    fun allowsRetry(
        id: String,
        policy: TranscriptCoverage.BackfillPolicy = TranscriptCoverage.BackfillPolicy.STANDARD,
    ): Boolean = remaining(id, policy) > 0

    /**
     * The ordinal to stamp on the request about to be queued: 1 for the first
     * hand-triggered run, 2 for the next. A non-zero ordinal is also how the
     * queue tells a manual re-run from the automatic backfill that ran itself,
     * which is why the first one is 1 and not 0.
     */
    fun nextAttempt(id: String): Int = spentCount(id) + 1

    /**
     * Charge one completed re-run to this recording.
     *
     * Clamped at the cap: a request queued before the cap was lowered — or two
     * runs that somehow raced — must not push the stored count past what any
     * build can read back as "spent out", or [remaining] would go on returning 0
     * while the file grew.
     */
    fun spend(
        id: String,
        policy: TranscriptCoverage.BackfillPolicy = TranscriptCoverage.BackfillPolicy.STANDARD,
    ): ManualRetryBudget {
        if (id.isEmpty()) return this
        val next = minOf(policy.maxManualRetries, spentCount(id) + 1)
        return of(spent + (id to next))
    }

    /**
     * Give a recording its budget back — for a deletion, so the ledger does not
     * keep a row for a recording that no longer exists.
     */
    fun forget(id: String): ManualRetryBudget = of(spent - id)

    companion object {
        /**
         * The normalizing factory: entries at or below zero are dropped rather
         * than stored. Deserialization deliberately bypasses this (a file is
         * read as written), which is why every reader coerces.
         */
        fun of(spent: Map<String, Int>): ManualRetryBudget =
            ManualRetryBudget(spent.filterValues { it > 0 })
    }
}
