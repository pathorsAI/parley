package com.pathors.parley.feedback

import com.pathors.parley.cloud.CloudException
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** Failed syncs in a row, per recording — what "keeps failing to sync" counts. */
class SyncFailureLedgerTest {

    @get:Rule
    val folder = TemporaryFolder()

    @Test
    fun `failures accumulate per recording and a success ends the streak`() {
        val ledger = SyncFailureLedger(folder.root.resolve("sync-failures.json"))
        repeat(3) { ledger.failed("a", CloudException(503, "down")) }
        ledger.failed("b", IOException("offline"))

        assertEquals(3, ledger.read().entries["a"]?.consecutiveFailures)
        assertEquals("http_503", ledger.read().entries["a"]?.lastError)
        assertEquals("network", ledger.read().lastError)

        ledger.clear("a")
        assertNull(ledger.read().entries["a"])
        assertEquals(1, ledger.read().entries["b"]?.consecutiveFailures)
    }

    @Test
    fun `error codes say what kind of failure, never what the server said`() {
        assertEquals("http_413", SyncFailureLedger.codeOf(CloudException(413, "your title 'Acme board' is too long")))
        assertEquals("bad_meta_json", SyncFailureLedger.codeOf(CloudException(0, "x", code = "bad_meta_json")))
        assertEquals("network", SyncFailureLedger.codeOf(IOException("Unable to resolve host")))
        assertEquals("IllegalStateException", SyncFailureLedger.codeOf(IllegalStateException("boom")))
    }
}
