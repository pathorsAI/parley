package com.pathors.parley.upload

import android.content.Context
import com.pathors.parley.cloud.CloudJson
import com.pathors.parley.cloud.RecordingMeta
import com.pathors.parley.cloud.RecordingSummary
import com.pathors.parley.util.deleteQuietly
import java.io.File
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * A recording whose transcript does not account for its audio, waiting for the
 * hosted transcription that will replace it.
 *
 * Its own queue entry rather than a flag on [PendingUpload], because the two
 * describe different debts. A pending upload owes the cloud a recording; a
 * pending backfill owes an *uploaded* recording a transcript it can be trusted
 * with. The upload has already succeeded by the time one of these exists — the
 * library shows the meeting and it is readable — so a backfill must never block
 * an upload or be retried in the same breath.
 */
@Serializable
data class BackfillRequest(
    /** Everything the re-push needs about the recording itself. */
    val pending: PendingUpload,
    /**
     * The personal folder the recording landed in, so the re-push files it where
     * the first push did rather than dropping it into the root.
     */
    val folderId: String? = null,
    /**
     * Which hand-triggered attempt this is: 0 for the automatic backfill that
     * queued itself, 1 for the first re-run somebody asked for.
     *
     * The *budget* those attempts come out of is
     * [com.pathors.parley.kit.ManualRetryBudget], not this number — a finished
     * backfill deletes its manifest, so a count living here could never be read
     * back after a successful run. What this is for is telling the two kinds of
     * run apart when one finishes, because only a manual one is charged.
     */
    val manualRetries: Int = 0,
    /**
     * The recording's meta exactly as it already exists, so the re-push can put
     * the new transcript *into* it instead of building a fresh entry over the
     * top of somebody's speaker names and analysis. See
     * [RecordingMeta.replacingTranscript].
     *
     * Null for the automatic path, which has nothing to preserve: the recording
     * was created seconds ago by the upload that queued this.
     */
    val existingMeta: JsonObject? = null,
    /**
     * The summary the library is already showing, for the same reason:
     * `findingsCount` and the title belong to the recording, not to the
     * transcript being replaced.
     */
    val existingSummary: RecordingSummary? = null,
) {
    val id: String get() = pending.id

    /** True when somebody asked for this run, rather than coverage queueing it. */
    val isManual: Boolean get() = manualRetries > 0

    /** The meta to edit rather than rebuild, when the request carries one. */
    fun existingRecordingMeta(): RecordingMeta? = existingMeta?.let(::RecordingMeta)
}

/**
 * The durable backfill queue: `filesDir/PendingBackfills/{id}.ogg` plus
 * `{id}.json`, deliberately the same shape as [PendingUploadQueue] rather than
 * the iOS original's spread of static functions.
 *
 * What that shape buys, and why it is worth copying rather than porting:
 *
 * - **Audio first, manifest second.** A crash mid-enqueue leaves at worst an
 *   orphan blob, never a manifest promising audio that is not there.
 * - **The manifest write is atomic** (temp file + rename), so a half-written
 *   JSON cannot be read back as a truncated request.
 * - **An orphan manifest cleans itself up.** [TranscriptBackfiller] drops any
 *   entry whose blob is gone instead of failing on it forever — the same
 *   protection [MeetingUploader.drain] has, and the reason a single broken item
 *   cannot wedge the queue head the way it can on iOS.
 *
 * All methods do blocking file I/O; [TranscriptBackfiller] is what dispatches
 * them off the main thread.
 */
class PendingBackfillQueue(private val directory: File) {

    /** The Ogg/Opus blob for [id] (may not exist yet). */
    fun audioFile(id: String): File = File(directory, "$id.ogg")

    /** The manifest for [id] (may not exist yet). */
    fun manifestFile(id: String): File = File(directory, "$id.json")

    /** Whether a re-transcription is waiting or in flight for this recording. */
    fun has(id: String): Boolean = manifestFile(id).isFile

    /**
     * Take ownership of the audio by **moving** it — for the automatic path,
     * where the file is coming out of the upload queue that is done with it.
     *
     * A move, not a copy: exactly one queue owns the file at a time, so a crash
     * between the two can leave the recording waiting or done, but never holding
     * two copies of an hour of audio.
     */
    fun enqueueMoving(request: BackfillRequest, audioSource: File) =
        enqueue(request, audioSource, move = true)

    /**
     * Take a **copy** of the audio — for a re-transcription somebody asked for.
     *
     * The file it points at is the one in
     * [com.pathors.parley.playback.LocalAudioStore] that the player on screen is
     * reading from. Moving it would stop playback mid-sentence and make the
     * recording look un-downloaded while its own re-transcription ran.
     */
    fun enqueueCopying(request: BackfillRequest, audioSource: File) =
        enqueue(request, audioSource, move = false)

    private fun enqueue(request: BackfillRequest, audioSource: File, move: Boolean) {
        directory.mkdirs()
        val destination = audioFile(request.id)
        if (audioSource.absolutePath != destination.absolutePath) {
            if (destination.exists()) destination.deleteQuietly()
            if (!move || !audioSource.renameTo(destination)) {
                // A copy because we were asked for one, or because the rename
                // crossed a filesystem (cacheDir → filesDir on some devices).
                audioSource.copyTo(destination, overwrite = true)
                if (move) audioSource.deleteQuietly()
            }
        }
        try {
            writeManifest(request)
        } catch (e: Throwable) {
            // An Ogg with no manifest beside it is invisible to `list()` and
            // would sit in filesDir for the life of the install — the one way
            // this queue could leak an hour of audio with nothing able to see
            // it, let alone clean it up. Give the file back rather than keep it.
            destination.deleteQuietly()
            throw e
        }
    }

    /**
     * Write a manifest in place, atomically.
     *
     * Over any request already sitting in the queue for this recording — there
     * is one audio file and one manifest per id, so a second request replaces
     * the first rather than racing it.
     */
    fun writeManifest(request: BackfillRequest) {
        directory.mkdirs()
        val target = manifestFile(request.id)
        val temp = File(directory, "${request.id}.json.tmp")
        temp.writeText(CloudJson.encodeToString(BackfillRequest.serializer(), request))
        if (target.exists()) target.deleteQuietly()
        if (!temp.renameTo(target)) {
            temp.copyTo(target, overwrite = true)
            temp.deleteQuietly()
        }
    }

    /**
     * Everything still waiting, oldest first. Manifests that no longer parse (a
     * truncated write, a format from a future version) are skipped rather than
     * throwing.
     */
    fun list(): List<BackfillRequest> =
        (directory.listFiles { file -> file.isFile && file.name.endsWith(".json") } ?: emptyArray())
            .mapNotNull { file ->
                runCatching {
                    CloudJson.decodeFromString(BackfillRequest.serializer(), file.readText())
                }.getOrNull()
            }
            .sortedBy { it.pending.startedAtMs }

    /** The queued request for one recording, or null if there is none. */
    fun request(id: String): BackfillRequest? =
        runCatching {
            CloudJson.decodeFromString(BackfillRequest.serializer(), manifestFile(id).readText())
        }.getOrNull()

    /** How many recordings are waiting for a better transcript. */
    fun count(): Int =
        directory.listFiles { file -> file.isFile && file.name.endsWith(".json") }?.size ?: 0

    /** Drop a recording from the queue, audio included. */
    fun remove(id: String) {
        audioFile(id).deleteQuietly()
        manifestFile(id).deleteQuietly()
    }

    /**
     * Drop the manifest but leave the audio where it is — for a run that has
     * finished and whose Ogg is about to be retired on the same terms as any
     * other recording's (kept on the phone, or deleted).
     */
    fun removeManifest(id: String) {
        manifestFile(id).deleteQuietly()
    }

    /**
     * Drop everything, blobs included. Only for account deletion, for the same
     * reason as [PendingUploadQueue.clear]: once `DELETE /me` has succeeded
     * there is nothing left to push a repaired transcript to.
     */
    fun clear() {
        directory.listFiles()?.forEach { file -> if (file.isFile) file.deleteQuietly() }
    }

    /** Total bytes the queue is holding on disk, for a storage readout. */
    fun bytesOnDisk(): Long =
        directory.listFiles()?.filter { it.isFile }?.sumOf { it.length() } ?: 0L

    companion object {
        /** Same directory name as iOS: `<app files>/PendingBackfills`. */
        const val DIRECTORY_NAME = "PendingBackfills"

        fun default(context: Context): PendingBackfillQueue =
            PendingBackfillQueue(File(context.applicationContext.filesDir, DIRECTORY_NAME))
    }
}
