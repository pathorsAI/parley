package com.pathors.parley.kit

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Ported from iOS `ManualRetryBudgetTests.swift`. */
class ManualRetryBudgetTest {

    private val id = "rec-1"
    private val json = Json { ignoreUnknownKeys = true }

    // ── the cap ──────────────────────────────────────────────────────────────

    @Test
    fun `a fresh recording has the whole budget`() {
        val budget = ManualRetryBudget()

        assertEquals(0, budget.spentCount(id))
        assertEquals(3, budget.remaining(id))
        assertTrue(budget.allowsRetry(id))
    }

    @Test
    fun `spending the budget closes the entry point`() {
        var budget = ManualRetryBudget()
        for (expected in listOf(2, 1, 0)) {
            assertTrue(budget.allowsRetry(id))
            budget = budget.spend(id)
            assertEquals(expected, budget.remaining(id))
        }

        assertFalse(budget.allowsRetry(id))
    }

    /**
     * The failure the ledger exists to prevent: the queue entry that carries a
     * request is deleted when the run finishes, so if the count lived there a
     * successful re-run would leave no trace and the budget would reset.
     */
    @Test
    fun `the count survives encoding and decoding`() {
        val budget = ManualRetryBudget()
            .spend(id)
            .spend("rec-2")
            .spend("rec-2")

        val round = json.decodeFromString(
            ManualRetryBudget.serializer(),
            json.encodeToString(ManualRetryBudget.serializer(), budget),
        )

        assertEquals(1, round.spentCount(id))
        assertEquals(2, round.spentCount("rec-2"))
        assertEquals(budget, round)
    }

    @Test
    fun `recordings do not share a budget`() {
        var budget = ManualRetryBudget()
        repeat(3) { budget = budget.spend(id) }

        assertFalse(budget.allowsRetry(id))
        assertTrue(budget.allowsRetry("rec-2"))
    }

    /**
     * A build that raises or lowers the cap has to read an existing ledger
     * without going negative or granting a refund it cannot account for.
     */
    @Test
    fun `a ledger over the cap reads as spent out rather than as a debt`() {
        val budget = ManualRetryBudget(mapOf(id to 9))
        val tight = TranscriptCoverage.BackfillPolicy(maxManualRetries = 1)

        assertEquals(0, budget.remaining(id, tight))
        assertFalse(budget.allowsRetry(id, tight))
    }

    @Test
    fun `spending is clamped to the cap`() {
        var budget = ManualRetryBudget()
        repeat(10) { budget = budget.spend(id) }

        assertEquals(3, budget.spentCount(id))
    }

    @Test
    fun `nothing spent is not stored as zero`() {
        assertEquals(emptyMap<String, Int>(), ManualRetryBudget.of(mapOf(id to 0)).spent)
        // And a zero that got in anyway still reads as nothing spent.
        assertEquals(0, ManualRetryBudget(mapOf(id to 0)).spentCount(id))
    }

    // ── the attempt ordinal ──────────────────────────────────────────────────

    /**
     * The ordinal stamped on the queued request. Non-zero is how a finished
     * backfill knows it was asked for by hand and should be charged; the
     * automatic one carries 0 and is not.
     */
    @Test
    fun `the first hand-triggered attempt is one, so it is never the automatic one`() {
        val budget = ManualRetryBudget()

        assertEquals(1, budget.nextAttempt(id))
        assertEquals(2, budget.spend(id).nextAttempt(id))
    }

    @Test
    fun `forgetting a recording gives its budget back`() {
        val budget = ManualRetryBudget().spend(id).forget(id)

        assertEquals(3, budget.remaining(id))
    }
}
