package com.pathors.parley.feedback

import com.pathors.parley.cloud.CloudException
import com.pathors.parley.cloud.CloudJson
import com.pathors.parley.util.deleteQuietly
import java.io.File
import java.io.IOException
import kotlinx.serialization.Serializable

/**
 * How many times in a row each queued recording has failed to sync, and how
 * the last attempt failed — what the `sync_failed` prompt and the
 * `syncLastError` diagnostic are read from.
 *
 * The upload queue itself only knows *that* a recording is still waiting; it
 * cannot tell "waiting for the network to come back" from "the server has
 * refused this one three times", and the second is the one worth a report.
 * One entry per recording, cleared the moment it syncs (or is dropped), so
 * "in a row" means what it says.
 *
 * Counted per drain pass, not per HTTP attempt: `MeetingUploader` already
 * retries inside a pass, and a pass that gives up is one failure from where
 * the user stands.
 *
 * Blocking file I/O; callers dispatch.
 */
class SyncFailureLedger(private val file: File) {

    @Serializable
    data class Entry(val consecutiveFailures: Int = 0, val lastError: String = "")

    @Serializable
    data class State(val entries: Map<String, Entry> = emptyMap(), val lastError: String? = null)

    private val lock = Any()

    fun read(): State = synchronized(lock) { readUnlocked() }

    fun failed(id: String, error: Throwable) = synchronized(lock) {
        val state = readUnlocked()
        val code = codeOf(error)
        val entry = state.entries[id] ?: Entry()
        write(
            state.copy(
                entries = state.entries + (id to entry.copy(consecutiveFailures = entry.consecutiveFailures + 1, lastError = code)),
                lastError = code,
            ),
        )
    }

    /** [id] synced, or left the queue for good: its streak is over. */
    fun clear(id: String) = synchronized(lock) {
        val state = readUnlocked()
        if (id in state.entries) write(state.copy(entries = state.entries - id))
    }

    private fun readUnlocked(): State =
        runCatching { CloudJson.decodeFromString(State.serializer(), file.readText()) }.getOrDefault(State())

    private fun write(state: State) {
        val directory = file.parentFile
        directory?.mkdirs()
        val temp = File(directory, "${file.name}.tmp")
        runCatching {
            temp.writeText(CloudJson.encodeToString(State.serializer(), state))
            if (!temp.renameTo(file)) {
                temp.copyTo(file, overwrite = true)
                temp.deleteQuietly()
            }
        }.onFailure { temp.deleteQuietly() }
    }

    companion object {
        /**
         * `http_503`, `network`, or the exception's class — short, and free of
         * anything the server said, which can quote the request back.
         */
        fun codeOf(error: Throwable): String = when {
            error is CloudException && error.status > 0 -> "http_${error.status}"
            error is CloudException -> error.code ?: "client_error"
            error is IOException -> "network"
            else -> error.javaClass.simpleName.ifEmpty { "error" }
        }
    }
}
