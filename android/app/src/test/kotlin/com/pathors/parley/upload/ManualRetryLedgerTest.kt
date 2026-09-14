package com.pathors.parley.upload

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The ledger is the only thing that remembers a re-transcription happened: the
 * queue entry that carried the request is deleted the moment the run succeeds,
 * so a count kept there would reset the budget every time somebody used it.
 */
class ManualRetryLedgerTest {

    @get:Rule
    val temporary = TemporaryFolder()

    private fun ledger(name: String = "ManualRetries.json") =
        ManualRetryLedger(File(temporary.root, name))

    @Test
    fun `a spend survives the process that made it`() {
        val file = File(temporary.root, "ledger.json")
        ManualRetryLedger(file).spend("rec-1")

        // A second instance over the same file is what a relaunch looks like.
        assertEquals(1, ManualRetryLedger(file).read().spentCount("rec-1"))
        assertEquals(2, ManualRetryLedger(file).read().remaining("rec-1"))
    }

    @Test
    fun `a ledger that has never been written reads as nothing spent`() {
        val budget = ledger().read()

        assertEquals(3, budget.remaining("rec-1"))
        assertTrue(budget.allowsRetry("rec-1"))
    }

    /**
     * The failure mode that matters is not losing a spend — it is refusing
     * somebody a transcript they are entitled to because a file would not parse.
     */
    @Test
    fun `an unreadable ledger reads as empty rather than locking anybody out`() {
        val file = File(temporary.root, "corrupt.json").apply { writeText("{ half a wri") }

        assertTrue(ManualRetryLedger(file).read().allowsRetry("rec-1"))
    }

    @Test
    fun `spending the cap closes the entry point and stays closed`() {
        val ledger = ledger()
        repeat(3) { ledger.spend("rec-1") }

        assertFalse(ledger.read().allowsRetry("rec-1"))
        // And a fourth spend cannot push the stored count past the cap.
        ledger.spend("rec-1")
        assertEquals(3, ledger.read().spentCount("rec-1"))
    }

    @Test
    fun `recordings do not share a budget`() {
        val ledger = ledger()
        repeat(3) { ledger.spend("rec-1") }

        assertFalse(ledger.read().allowsRetry("rec-1"))
        assertTrue(ledger.read().allowsRetry("rec-2"))
    }

    @Test
    fun `forgetting a deleted recording gives its row back`() {
        val ledger = ledger()
        ledger.spend("rec-1")

        ledger.forget("rec-1")

        assertEquals(3, ledger.read().remaining("rec-1"))
        assertEquals(emptyMap<String, Int>(), ledger.read().spent)
    }

    @Test
    fun `no temp file survives a write`() {
        // The write is temp-file-plus-rename so a crash mid-write cannot leave a
        // truncated ledger that reads back as empty and refunds every recording.
        val ledger = ledger()
        ledger.spend("rec-1")
        ledger.spend("rec-2")

        assertEquals(listOf("ManualRetries.json"), temporary.root.list()!!.toList())
    }

    @Test
    fun `clearing drops the whole ledger, for account deletion`() {
        val ledger = ledger()
        ledger.spend("rec-1")

        ledger.clear()

        assertEquals(emptyMap<String, Int>(), ledger.read().spent)
    }
}
