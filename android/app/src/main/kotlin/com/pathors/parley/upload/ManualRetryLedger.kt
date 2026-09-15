package com.pathors.parley.upload

import android.content.Context
import com.pathors.parley.cloud.CloudJson
import com.pathors.parley.kit.ManualRetryBudget
import com.pathors.parley.util.deleteQuietly
import java.io.File

/**
 * Where [ManualRetryBudget] lives on disk.
 *
 * Beside the two queues rather than in a DataStore: this is a record of money
 * spent, and it belongs in the same container that survives the same events the
 * queued audio does. A `filesDir` file is also what makes "the ledger and the
 * backfill it is charging are gone together or not at all" checkable by looking
 * at one directory.
 *
 * All methods do blocking file I/O; callers dispatch them off the main thread.
 */
class ManualRetryLedger(private val file: File) {

    /**
     * An unreadable or absent ledger reads as an empty one.
     *
     * The failure mode that matters is the other direction: a ledger that could
     * not be read must not lock somebody out of a recording they have never
     * re-run. Losing the file costs at most a few re-runs nobody was charged
     * for; refusing on it costs somebody a transcript they are entitled to.
     */
    fun read(): ManualRetryBudget =
        runCatching {
            CloudJson.decodeFromString(ManualRetryBudget.serializer(), file.readText())
        }.getOrDefault(ManualRetryBudget())

    /**
     * Charge one completed re-run to this recording, and return the budget as it
     * now stands.
     *
     * Read-modify-write on every call rather than caching: re-runs are rare, the
     * file is a handful of bytes, and a cached copy that went stale would be a
     * budget that quietly refunded itself.
     */
    fun spend(id: String): ManualRetryBudget = write(read().spend(id))

    /** Give a recording its budget back — for a deletion. */
    fun forget(id: String): ManualRetryBudget = write(read().forget(id))

    /** Drop the whole ledger. Account deletion only, with the queues. */
    fun clear() {
        file.deleteQuietly()
    }

    /**
     * Atomically, via a temp file and a rename: a ledger truncated by a crash
     * mid-write would read back as empty and hand out a fresh budget for every
     * recording on the phone.
     */
    private fun write(budget: ManualRetryBudget): ManualRetryBudget {
        val directory = file.parentFile
        directory?.mkdirs()
        val temp = File(directory, "${file.name}.tmp")
        runCatching {
            temp.writeText(CloudJson.encodeToString(ManualRetryBudget.serializer(), budget))
            if (file.exists()) file.deleteQuietly()
            if (!temp.renameTo(file)) {
                temp.copyTo(file, overwrite = true)
                temp.deleteQuietly()
            }
        }.onFailure { temp.deleteQuietly() }
        return budget
    }

    companion object {
        const val FILE_NAME = "ManualRetries.json"

        fun default(context: Context): ManualRetryLedger =
            ManualRetryLedger(File(context.applicationContext.filesDir, FILE_NAME))
    }
}
