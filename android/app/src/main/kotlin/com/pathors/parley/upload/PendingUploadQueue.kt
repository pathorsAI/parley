package com.pathors.parley.upload

import android.content.Context
import com.pathors.parley.cloud.CloudJson
import com.pathors.parley.cloud.RecordingSource
import com.pathors.parley.cloud.TranscriptSegmentDto
import com.pathors.parley.util.deleteQuietly
import java.io.File
import kotlinx.serialization.Serializable

/**
 * One finished recording waiting to reach the cloud — everything needed to
 * rebuild its summary + meta on a later app launch, with the Ogg blob sitting
 * next to it on disk.
 *
 * Mirrors the iOS `MeetingUploader.PendingUpload` manifest, with two additions
 * the phone did not need:
 *
 * - `title` is stored rather than derived. iOS formats "Meeting <date>" at upload
 *   time; Android carries the title because an imported file is titled after the
 *   file, and because display copy belongs to the (bilingual) UI layer.
 * - `source` distinguishes a live capture from an imported file — iOS only ever
 *   pushes `"live"`.
 *
 * iOS additionally stores a `defaultSave` destination (for org sharing). Android
 * does not surface organizations yet, so only the personal `folderId` is kept.
 */
@Serializable
data class PendingUpload(
    /** The recording's UUID — its global id; a push is an idempotent upsert on it. */
    val id: String,
    val title: String,
    /** [RecordingSource.LIVE] or [RecordingSource.UPLOAD]. */
    val source: String = RecordingSource.LIVE,
    /** Client-side creation time, epoch milliseconds. */
    val startedAtMs: Long,
    /** Recording length in milliseconds; fractional, since it is derived from sample counts. */
    val durationMs: Double,
    /** Final segments only — the tentative tail is dropped before enqueueing. */
    val segments: List<TranscriptSegmentDto> = emptyList(),
    /** Personal folder to file the recording under; null = the personal root. */
    val folderId: String? = null,
)

/**
 * The durable pending-upload queue: `filesDir/PendingUploads/{id}.ogg` plus
 * `{id}.json`, exactly the iOS layout (which uses Application Support because
 * that is the iOS equivalent of `filesDir`).
 *
 * Files are written before the first upload attempt and deleted only after every
 * cloud step for that recording has succeeded, so a crash, an offline phone or a
 * killed process can never lose a finished meeting.
 *
 * All methods do blocking file I/O; [MeetingUploader] is what dispatches them off
 * the main thread.
 */
class PendingUploadQueue(private val directory: File) {

    /** The Ogg/Opus blob for [id] (may not exist yet). */
    fun audioFile(id: String): File = File(directory, "$id.ogg")

    /** The manifest for [id] (may not exist yet). */
    fun manifestFile(id: String): File = File(directory, "$id.json")

    /**
     * Take ownership of a finished recording: move [audioSource] into the queue
     * and write its manifest.
     *
     * The audio is moved first and the manifest written second (atomically, via a
     * temp file + rename), so a crash mid-enqueue leaves at worst an orphan blob —
     * never a manifest that promises audio which is not there.
     */
    fun enqueue(pending: PendingUpload, audioSource: File) {
        directory.mkdirs()
        val destination = audioFile(pending.id)
        if (audioSource.absolutePath != destination.absolutePath) {
            if (destination.exists()) destination.deleteQuietly()
            if (!audioSource.renameTo(destination)) {
                // Different filesystem (cacheDir → filesDir on some devices): copy.
                audioSource.copyTo(destination, overwrite = true)
                audioSource.deleteQuietly()
            }
        }
        writeManifest(pending)
    }

    /** Re-write a manifest in place (e.g. after re-titling a queued recording). */
    fun writeManifest(pending: PendingUpload) {
        directory.mkdirs()
        val target = manifestFile(pending.id)
        val temp = File(directory, "${pending.id}.json.tmp")
        temp.writeText(CloudJson.encodeToString(PendingUpload.serializer(), pending))
        if (target.exists()) target.deleteQuietly()
        if (!temp.renameTo(target)) {
            temp.copyTo(target, overwrite = true)
            temp.deleteQuietly()
        }
    }

    /**
     * Everything still waiting, oldest first — uploads keep the order they were
     * recorded in. Manifests that no longer parse (a truncated write, a format
     * from a future version) are skipped rather than throwing.
     */
    fun list(): List<PendingUpload> =
        (directory.listFiles { file -> file.isFile && file.name.endsWith(".json") } ?: emptyArray())
            .mapNotNull { file ->
                runCatching {
                    CloudJson.decodeFromString(PendingUpload.serializer(), file.readText())
                }.getOrNull()
            }
            .sortedBy { it.startedAtMs }

    /** How many recordings are still waiting. */
    fun count(): Int =
        directory.listFiles { file -> file.isFile && file.name.endsWith(".json") }?.size ?: 0

    /** Drop a recording from the queue — called only after a fully successful upload. */
    fun remove(id: String) {
        audioFile(id).deleteQuietly()
        manifestFile(id).deleteQuietly()
    }

    /** Total bytes the queue is holding on disk, for a "waiting to upload" readout. */
    fun bytesOnDisk(): Long =
        directory.listFiles()?.filter { it.isFile }?.sumOf { it.length() } ?: 0L

    companion object {
        /** Same directory name as iOS: `<app files>/PendingUploads`. */
        const val DIRECTORY_NAME = "PendingUploads"

        fun default(context: Context): PendingUploadQueue =
            PendingUploadQueue(File(context.applicationContext.filesDir, DIRECTORY_NAME))
    }
}
