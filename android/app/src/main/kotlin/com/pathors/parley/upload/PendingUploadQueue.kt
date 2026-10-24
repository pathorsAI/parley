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
 * The save destination is flattened into three fields rather than stored as
 * iOS's nested `defaultSave`: [folderId] is where the upload itself is filed,
 * and [shareOrgId] / [shareFolderId] are the organization copy made after it.
 * All three are captured when the recording is queued, so a recording keeps the
 * destination it was made under even if the setting changes while it waits.
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
    /**
     * The organization to share a copy into once the personal upload has
     * landed (`POST /recordings/{id}/share`); null = personal only.
     */
    val shareOrgId: String? = null,
    /** The folder inside [shareOrgId] the copy goes into; null = the org's root. */
    val shareFolderId: String? = null,
    /**
     * A meta push has been attempted for this recording, so the cloud may
     * already hold it — and may hold a NEWER version of it (renamed, filed,
     * offered a filing suggestion, analysed) by the time the upload is tried
     * again. A retry then edits what the upload owns into the existing entry
     * instead of pushing a rebuilt one over it. See `MeetingUploader.pushMeta`.
     */
    val pushAttempted: Boolean = false,
    /**
     * Set once the cloud has refused this upload with a 4xx that waiting alone
     * will not clear (see `MeetingUploader.dispositionOf`). A refused upload is
     * **parked, never deleted**: the queue's Ogg is the only copy of the
     * meeting, and a 400 is also what a body cut off mid-transfer comes back as.
     * Null = an ordinary pending upload.
     */
    val parked: ParkedUpload? = null,
)

/**
 * Why and since when a [PendingUpload] is parked, and how many times it has
 * been refused — what [ParkedRetrySchedule] reads to decide when to try again.
 */
@Serializable
data class ParkedUpload(
    /** The HTTP status of the latest refusal. */
    val httpStatus: Int,
    /** When the cloud first refused it, epoch milliseconds. */
    val firstRefusedAtMs: Long,
    /** When the cloud last refused it, epoch milliseconds — the schedule's anchor. */
    val lastRefusedAtMs: Long,
    /** Refusals so far, including the first. */
    val refusals: Int = 1,
) {
    /** The same parking, refused once more at [nowMs] with [status]. */
    fun refusedAgain(status: Int, nowMs: Long): ParkedUpload =
        copy(httpStatus = status, lastRefusedAtMs = nowMs, refusals = refusals + 1)

    companion object {
        fun first(status: Int, nowMs: Long): ParkedUpload =
            ParkedUpload(httpStatus = status, firstRefusedAtMs = nowMs, lastRefusedAtMs = nowMs)
    }
}

/**
 * When a parked upload is tried again on its own: 1 h after the first refusal,
 * 6 h after the second, 24 h after the third, and after that only when someone
 * taps it. Long on purpose — a refusal that is real will be repeated, and the
 * point of retrying at all is the refusal that was not (a truncated body, a
 * server bug that has since been fixed).
 */
object ParkedRetrySchedule {
    private const val HOUR_MS = 60L * 60L * 1_000L

    /** Wait after the Nth refusal (index N-1). Past the end: manual only. */
    val DELAYS_MS: List<Long> = listOf(1 * HOUR_MS, 6 * HOUR_MS, 24 * HOUR_MS)

    /** When [parked] is next due for an automatic retry; null = manual only. */
    fun nextRetryAtMs(parked: ParkedUpload): Long? =
        DELAYS_MS.getOrNull(parked.refusals - 1)?.let { parked.lastRefusedAtMs + it }

    /** Whether [parked] should be tried in a pass running at [nowMs]. */
    fun isDue(parked: ParkedUpload, nowMs: Long): Boolean =
        nextRetryAtMs(parked)?.let { nowMs >= it } ?: false
}

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

    /**
     * Drop a recording from the queue — called only after a fully successful
     * upload, or for a manifest whose audio is already gone. Never for a
     * refusal: that parks the recording instead (see [PendingUpload.parked]).
     */
    fun remove(id: String) {
        audioFile(id).deleteQuietly()
        manifestFile(id).deleteQuietly()
    }

    /**
     * Drop everything the queue is holding, blobs included.
     *
     * Only for account deletion: once `DELETE /me` has succeeded there is no
     * account left for these to upload to, and leaving finished meeting audio on
     * disk would contradict what the confirmation dialog promised. Ordinary
     * sign-out deliberately keeps the queue — the same person usually signs back
     * in, and the recordings are still theirs.
     */
    fun clear() {
        directory.listFiles()?.forEach { file -> if (file.isFile) file.deleteQuietly() }
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
