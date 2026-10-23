package com.pathors.parley.kit

import java.io.File
import java.security.MessageDigest
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * A hosted batch job this phone already paid the upload for, remembered so the
 * next attempt at the same recording polls it instead of uploading again.
 *
 * Without this, a run that was cut short — the screen that started it closed,
 * the process frozen or killed in the background — left a job on the cloud
 * nobody would ever poll again, and the next attempt uploaded the same hour of
 * audio as a brand-new job. Seen in production as one 50-minute file uploaded
 * three times in a day, every job abandoned.
 *
 * [audioBytes] is the size of the file the job was created from: a recording
 * whose audio has since changed must not be answered with the old file's
 * transcript.
 */
@Serializable
data class PersistedBatchJob(
    val jobId: String,
    val audioBytes: Long,
    val createdAtMs: Long,
)

/**
 * Where [BatchTranscriber] keeps [PersistedBatchJob]s, keyed by recording id.
 *
 * Every method is best-effort and must not throw: a store that cannot write
 * costs a re-upload, never the transcription.
 */
interface BatchJobStore {
    fun read(key: String): PersistedBatchJob?

    fun write(key: String, job: PersistedBatchJob)

    fun clear(key: String)

    /** Forget every job — a sign-out, so one account never resumes another's. */
    fun clearAll()

    companion object {
        /** Remembers nothing: every attempt uploads. */
        val NONE: BatchJobStore = object : BatchJobStore {
            override fun read(key: String): PersistedBatchJob? = null
            override fun write(key: String, job: PersistedBatchJob) = Unit
            override fun clear(key: String) = Unit
            override fun clearAll() = Unit
        }
    }
}

/**
 * One small JSON file per recording in [directory] — the same plain-file
 * persistence the upload and backfill queues use, and deliberately not
 * DataStore: a release build once crashed on R8 renaming DataStore's shaded
 * protobuf fields, and a second store of that kind is a second chance at it.
 */
class FileBatchJobStore(private val directory: File) : BatchJobStore {

    override fun read(key: String): PersistedBatchJob? = runCatching {
        val file = fileFor(key)
        if (!file.isFile) return null
        json.decodeFromString(PersistedBatchJob.serializer(), file.readText())
    }.getOrNull()

    override fun write(key: String, job: PersistedBatchJob) {
        runCatching {
            directory.mkdirs()
            val target = fileFor(key)
            val staging = File(directory, target.name + STAGING_SUFFIX)
            staging.writeText(json.encodeToString(PersistedBatchJob.serializer(), job))
            // A rename that failed leaves the staging copy; one that will not
            // delete either is left for the JVM to clear on exit.
            if (!staging.renameTo(target) && !staging.delete()) {
                staging.deleteOnExit()
            }
        }
    }

    override fun clear(key: String) {
        runCatching { fileFor(key).delete() }
    }

    override fun clearAll() {
        runCatching { directory.listFiles()?.forEach { it.delete() } }
    }

    private fun fileFor(key: String): File = File(directory, fileName(key) + EXTENSION)

    companion object {
        private const val EXTENSION = ".json"
        private const val STAGING_SUFFIX = ".tmp"
        private val SAFE_NAME = Regex("[A-Za-z0-9_-]{1,64}")
        private val json = Json { ignoreUnknownKeys = true }

        /**
         * Recording ids are UUIDs and pass through unchanged; anything else is
         * hashed rather than trusted as a path segment.
         */
        internal fun fileName(key: String): String {
            if (SAFE_NAME.matches(key)) return key
            val digest = MessageDigest.getInstance("SHA-256").digest(key.toByteArray())
            return digest.joinToString("") { "%02x".format(it) }
        }
    }
}
