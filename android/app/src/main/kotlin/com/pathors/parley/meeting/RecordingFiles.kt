package com.pathors.parley.meeting

import android.content.Context
import android.util.Log
import com.pathors.parley.audio.OggOpusEncoder
import com.pathors.parley.cloud.RecordingSource
import com.pathors.parley.upload.EnqueueRequest
import com.pathors.parley.upload.MeetingUploader
import com.pathors.parley.util.deleteQuietly
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private const val TAG = "RecordingFiles"

/**
 * Where a live recording's Ogg file lives while it is being written, and how a
 * file that was still being written when the process died gets rescued.
 *
 * ## Why not `cacheDir`
 *
 * This used to be `context.cacheDir/recordings`, and that was a quietly
 * dangerous place to keep the only copy of a meeting. Android treats a cache
 * directory as disposable in three separate ways, and all three can happen
 * *while the file is open*:
 *
 * * the platform deletes cache directories when the device is low on storage,
 *   picking victims by size — and an hour of audio is a large file;
 * * "Clear cache" in system settings deletes it on the user's behalf, usually
 *   while they are trying to free space for something unrelated;
 * * some OEM "storage cleaners" do the same on a schedule.
 *
 * `filesDir` has none of those properties, costs nothing extra, and is where
 * the pending-upload queue already keeps finished recordings
 * (`PendingUploadQueue.default`). iOS is the one platform where the temporary
 * directory is defensible, because the encoder there writes and the uploader
 * adopts within the same launch; Android had no such excuse.
 *
 * Files left behind in the old cache location are swept up by [adoptOrphans],
 * which is the whole migration — there is no version flag to carry, because the
 * sweep is idempotent and the old directory simply stops being written to.
 */
object RecordingFiles {

    /** Directory name under both `filesDir` and (historically) `cacheDir`. */
    private const val DIRECTORY_NAME = "recordings"

    /** Where a live capture writes. Created if it does not exist. */
    fun directory(context: Context): File =
        File(context.applicationContext.filesDir, DIRECTORY_NAME).apply { mkdirs() }

    /**
     * The pre-move location. Read, never written: [adoptOrphans] rescues
     * anything a previous version left here.
     */
    fun legacyDirectory(context: Context): File =
        File(context.applicationContext.cacheDir, DIRECTORY_NAME)

    /** The file a capture starting at [startedAtMs] writes to. */
    fun newLiveFile(context: Context, startedAtMs: Long): File =
        File(directory(context), "meeting-$startedAtMs.ogg")

    /**
     * Rescue Ogg files left behind by a recording that never finished.
     *
     * Two things leave one:
     *
     * 1. **The process died mid-meeting** — killed for memory, force-stopped,
     *    crashed. Nothing in the app ever looked for these, so a meeting that
     *    ended that way was gone with no trace anywhere. Note that this is only
     *    worth doing at all because the encoder now hand-writes Ogg pages: a
     *    `MediaMuxer` file whose `stop()` never ran is not a valid container, so
     *    before that change there was nothing here to rescue.
     * 2. **An enqueue that failed** — the hole the first durability wave
     *    deliberately left open. `dispose()` no longer deletes the audio (that
     *    was how a saved recording used to disappear a second after it was
     *    saved), which means a recording whose `uploader.enqueue` threw stays on
     *    disk with nobody to claim it. This claims it.
     *
     * Adopted with **no transcript at all**, on purpose. The coverage check
     * reads an empty transcript as one whole-file gap and the backfill queue
     * transcribes every second of it — the same machinery as any other
     * under-transcribed recording, with nothing special-cased. Mirrors iOS
     * `App/Parley/MeetingUploader.swift:398-459`.
     *
     * Duration is estimated from the file size, because a file that was never
     * finished has no header to ask. Opus here is a constant
     * [OggOpusEncoder.DEFAULT_BITRATE], so bytes are a good enough clock for
     * the "is this a meeting or a misfire?" gate; the transcription job reports
     * the real duration later.
     *
     * ## Only safe at launch
     *
     * A live recording's Ogg file is sitting in exactly this directory being
     * written to, and adopting it would move the file out from under the
     * encoder. There is no lock to take and no flag that would survive the kill
     * this exists to recover from, so the safety comes from *when* it is called:
     * once, from `ParleyApplication.onCreate`, before any recording can have
     * started. iOS makes the same argument for the same call site
     * (`App/Parley/AppState.swift:107`).
     *
     * Never throws: a rescue that fails must not stop the app from starting.
     *
     * @return how many recordings were adopted.
     */
    suspend fun adoptOrphans(
        context: Context,
        uploader: MeetingUploader,
        title: (startedAtMs: Long) -> String,
    ): Int = withContext(Dispatchers.IO) {
        var adopted = 0
        for (directory in listOf(directory(context), legacyDirectory(context))) {
            val files = directory.listFiles { file ->
                file.isFile && file.name.endsWith(OGG_SUFFIX)
            } ?: continue
            for (file in files.sortedBy { it.lastModified() }) {
                try {
                    if (adopt(file, uploader, title)) adopted += 1
                } catch (e: CancellationException) {
                    throw e
                } catch (t: Throwable) {
                    // A single unreadable file must not cost the rest of the
                    // sweep, and none of it may cost the app its launch.
                    Log.w(TAG, "could not adopt ${file.name}", t)
                }
            }
        }
        if (adopted > 0) Log.i(TAG, "adopted $adopted orphaned recording(s)")
        adopted
    }

    private suspend fun adopt(
        file: File,
        uploader: MeetingUploader,
        title: (startedAtMs: Long) -> String,
    ): Boolean {
        val estimate = estimateDurationMs(file.length())
        val startedAtMs = startedAtMsOf(file)
        if (estimate < MeetingUploader.MIN_LIVE_DURATION_MS) {
            // Under two seconds of audio: a tap of the record button, a file the
            // encoder opened and never wrote to, or the remains of a discard.
            // `enqueue` would drop it anyway; deleting it here is what keeps the
            // directory from growing a permanent tail of scraps.
            Log.i(TAG, "dropping ${file.name}: ${estimate.toLong()} ms is not a meeting")
            file.deleteQuietly()
            return false
        }
        // `enqueue` MOVES the file into the queue directory, which is what makes
        // this idempotent: a second sweep finds nothing left to adopt.
        val id = uploader.enqueue(
            EnqueueRequest(
                audio = file,
                title = title(startedAtMs),
                durationMs = estimate,
                segments = emptyList(),
                startedAtMs = startedAtMs,
                source = RecordingSource.LIVE,
            ),
        )
        return id != null
    }

    /**
     * Milliseconds of audio [bytes] buys at the recording bitrate.
     *
     * Constant-bitrate Opus, so this is within a few percent — close enough for
     * a two-second gate and for a duration the transcription job will correct.
     * The Ogg page overhead makes this a slight over-estimate, which is the
     * harmless direction: it errs towards keeping a recording.
     */
    fun estimateDurationMs(bytes: Long): Double =
        if (bytes <= 0) 0.0 else bytes * 8_000.0 / OggOpusEncoder.DEFAULT_BITRATE

    /**
     * The `startedAtMs` encoded in a live capture's file name, falling back to
     * the file's modification time.
     *
     * Worth parsing rather than always using the timestamp: a rescued meeting
     * files itself in the library under the time it was *recorded*, and the
     * modification time of a file the process died while writing is the moment
     * of the crash — close, but the name is exact, and the name is what
     * [newLiveFile] wrote it into.
     */
    fun startedAtMsOf(file: File): Long =
        file.name.removeSuffix(OGG_SUFFIX)
            .removePrefix(NAME_PREFIX)
            .toLongOrNull()
            ?.takeIf { it > 0 }
            ?: file.lastModified().takeIf { it > 0 }
            ?: System.currentTimeMillis()

    private const val OGG_SUFFIX = ".ogg"
    private const val NAME_PREFIX = "meeting-"
}
