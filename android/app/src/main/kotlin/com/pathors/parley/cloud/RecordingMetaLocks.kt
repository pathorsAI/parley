package com.pathors.parley.cloud

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * One lock per recording, process-wide, around every read-modify-write of its
 * meta — the phone's twin of the desktop's per-entry queue (`history.ts`).
 *
 * A recording's meta is one JSON object the worker replaces whole, with no
 * version check. Two edits that overlap — the study's action items and its
 * delivery read finishing together, the filing pass landing beside them —
 * would each read the same meta, add their field, and push it back: the
 * second push carries a copy read before the first landed, and erases it.
 * Taken in order, each edit reads what the one before it wrote.
 *
 * Not re-entrant: a block must not ask for the same recording's lock again.
 * Entries are dropped once nobody holds or waits on them, so the map stays as
 * small as the edits in flight.
 */
object RecordingMetaLocks {
    private class Entry {
        val mutex = Mutex()
        var users = 0
    }

    private val entries = HashMap<String, Entry>()

    /** Run [block] holding [recordingId]'s lock. */
    suspend fun <T> withLock(recordingId: String, block: suspend () -> T): T {
        val entry = synchronized(entries) {
            entries.getOrPut(recordingId, ::Entry).also { it.users++ }
        }
        try {
            return entry.mutex.withLock { block() }
        } finally {
            synchronized(entries) {
                entry.users--
                if (entry.users == 0) entries.remove(recordingId)
            }
        }
    }
}
