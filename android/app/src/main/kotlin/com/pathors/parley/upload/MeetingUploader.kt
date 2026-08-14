package com.pathors.parley.upload

import android.content.Context
import com.pathors.parley.cloud.CloudClient
import com.pathors.parley.cloud.CloudException
import com.pathors.parley.cloud.RecordingMeta
import com.pathors.parley.cloud.RecordingSource
import com.pathors.parley.cloud.RecordingSummary
import com.pathors.parley.cloud.TranscriptSegmentDto
import com.pathors.parley.cloud.msPrimitive
import java.io.File
import java.io.IOException
import java.util.Locale
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

/** What one [MeetingUploader.drain] pass achieved. */
data class DrainResult(
    /** Recordings fully uploaded (audio + summary/meta) and removed from the queue. */
    val uploaded: Int,
    /** Still waiting after the pass — what a "N waiting to upload" badge shows. */
    val remaining: Int,
    /** Manifests dropped because their audio blob was gone (unuploadable forever). */
    val discarded: Int = 0,
    /** Why the pass stopped early, if it did. Null means the queue drained clean. */
    val failure: Throwable? = null,
) {
    /** The session died mid-pass: the UI should show the signed-out state. */
    val signedOut: Boolean get() = (failure as? CloudException)?.isAuthExpired == true

    /** The hosted quota is exhausted; uploads will keep failing until it resets. */
    val quotaExhausted: Boolean get() = (failure as? CloudException)?.isQuotaExhausted == true
}

/**
 * The durable upload path for finished meetings — the Android counterpart of iOS
 * `App/Parley/MeetingUploader.swift`.
 *
 * A finished recording is written to [PendingUploadQueue] BEFORE any network call
 * and removed only once every cloud step has succeeded, so an interrupted or
 * offline upload simply waits for the next drain. The two cloud steps run in the
 * one order every Parley client uses:
 *
 * 1. `PUT /recordings/{id}/audio` — the Ogg/Opus blob.
 * 2. `POST /recordings/{id}` — `{ summary, meta }`.
 *
 * A summary claiming `hasAudio` must never reach the server before its blob, or
 * another device downloading it gets a 404.
 *
 * Call [drain] on app start and whenever connectivity returns; it is safe to call
 * concurrently (passes are serialized by an internal mutex).
 */
class MeetingUploader(
    private val cloud: CloudClient,
    private val queue: PendingUploadQueue,
    /** Attempts per recording within one drain pass, including the first. */
    private val maxAttempts: Int = 3,
    /** Backoff between attempts: 1 s, 2 s, 4 s … Injectable so tests do not sleep. */
    private val retryDelay: suspend (attempt: Int) -> Unit = { attempt ->
        delay(1_000L shl attempt.coerceAtMost(4))
    },
) {
    private val drainMutex = Mutex()

    /** How many recordings are waiting to reach the cloud. */
    suspend fun pendingCount(): Int = withContext(Dispatchers.IO) { queue.count() }

    /**
     * Hand a finished recording to the durable queue. [audio] is MOVED into the
     * queue directory, so the caller must not use it afterwards.
     *
     * Segments are filtered to the finals, dropping the tentative `"-tail"`
     * segment — the same filter iOS applies before persisting.
     *
     * A live capture shorter than [MIN_LIVE_DURATION_MS] is discarded (audio and
     * all), matching iOS: a two-second tap of the record button is a misfire, not
     * a meeting. An imported file is never discarded — importing it was explicit.
     *
     * @return the queued recording's id, or null when it was dropped as too short.
     */
    suspend fun enqueue(
        audio: File,
        title: String,
        durationMs: Double,
        segments: List<TranscriptSegmentDto>,
        startedAtMs: Long = System.currentTimeMillis(),
        source: String = RecordingSource.LIVE,
        id: String = newRecordingId(),
        folderId: String? = null,
    ): String? = withContext(Dispatchers.IO) {
        if (source == RecordingSource.LIVE && durationMs < MIN_LIVE_DURATION_MS) {
            audio.delete()
            return@withContext null
        }
        val pending = PendingUpload(
            id = id,
            title = title,
            source = source,
            startedAtMs = startedAtMs,
            durationMs = durationMs,
            segments = segments.filter { it.isFinal && !it.id.endsWith(TAIL_SUFFIX) },
            folderId = folderId,
        )
        queue.enqueue(pending, audio)
        id
    }

    /**
     * [enqueue] then immediately try to upload — what the "stop recording" path
     * calls. Returns null when the recording was dropped as too short.
     */
    suspend fun finishAndUpload(
        audio: File,
        title: String,
        durationMs: Double,
        segments: List<TranscriptSegmentDto>,
        startedAtMs: Long = System.currentTimeMillis(),
        source: String = RecordingSource.LIVE,
        id: String = newRecordingId(),
        folderId: String? = null,
    ): DrainResult? {
        enqueue(audio, title, durationMs, segments, startedAtMs, source, id, folderId)
            ?: return null
        return drain()
    }

    /**
     * Upload everything waiting, oldest first.
     *
     * Each recording gets [maxAttempts] tries with exponential backoff for
     * transient failures (network drop, 5xx, 429). A failure that retrying cannot
     * fix — a dead session (401), an exhausted quota (402), a rejected payload —
     * stops the pass immediately: iOS deliberately breaks out rather than spinning
     * a failing loop over every queued item, and the next drain retries in order.
     */
    suspend fun drain(): DrainResult = drainMutex.withLock {
        val pending = withContext(Dispatchers.IO) { queue.list() }
        var uploaded = 0
        var discarded = 0
        var failure: Throwable? = null

        for (item in pending) {
            val audio = queue.audioFile(item.id)
            if (!withContext(Dispatchers.IO) { audio.isFile && audio.length() > 0L }) {
                // The manifest outlived its blob (an interrupted enqueue, or a user
                // clearing app storage). It can never be uploaded, and keeping it
                // would block the queue head forever.
                withContext(Dispatchers.IO) { queue.remove(item.id) }
                discarded++
                continue
            }
            try {
                uploadWithRetry(item, audio)
                withContext(Dispatchers.IO) { queue.remove(item.id) }
                uploaded++
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                failure = e
                break
            }
        }

        DrainResult(
            uploaded = uploaded,
            remaining = withContext(Dispatchers.IO) { queue.count() },
            discarded = discarded,
            failure = failure,
        )
    }

    private suspend fun uploadWithRetry(pending: PendingUpload, audio: File) {
        var attempt = 0
        while (true) {
            try {
                upload(pending, audio)
                return
            } catch (e: CloudException) {
                if (!e.isRetryable || attempt >= maxAttempts - 1) throw e
            } catch (e: IOException) {
                // Socket/DNS failure that never reached the server.
                if (attempt >= maxAttempts - 1) throw e
            }
            retryDelay(attempt)
            attempt++
        }
    }

    /** Audio FIRST, then the summary+meta push — the contract's ordering. */
    private suspend fun upload(pending: PendingUpload, audio: File) {
        cloud.uploadAudio(pending.id, audio)
        cloud.pushRecording(pending.id, buildSummary(pending), buildMeta(pending))
    }

    companion object {
        /** Live captures shorter than this are treated as a misfire (iOS parity). */
        const val MIN_LIVE_DURATION_MS = 2_000.0

        /** The id suffix the live transcriber uses for its tentative segment. */
        const val TAIL_SUFFIX = "-tail"

        /** Audio file name recorded inside the meta JSON, as on desktop and iOS. */
        const val AUDIO_FILE_NAME = "audio.ogg"

        /** Lowercase UUID — the same id shape every Parley client generates. */
        fun newRecordingId(): String = UUID.randomUUID().toString().lowercase(Locale.ROOT)

        fun create(context: Context, cloud: CloudClient): MeetingUploader =
            MeetingUploader(cloud, PendingUploadQueue.default(context))

        /**
         * The full entry JSON pushed as `meta` — the desktop's `HistoryEntry`
         * restricted to what a phone can fill in. Field-for-field identical to iOS
         * `MeetingUploader.buildMeta`; see `android/docs/api-cloud.md` for the
         * documented schema.
         *
         * The analysis fields are written empty rather than omitted: the desktop
         * reads this object directly into a `HistoryEntry`, and `analyzed: false`
         * is what tells it the findings/action-items pipeline has not run yet.
         *
         * `folderId` is written only when set — an absent key means the personal
         * root, and pushing an explicit null would be a different statement.
         */
        fun buildMeta(pending: PendingUpload): RecordingMeta = RecordingMeta(
            buildJsonObject {
                put("id", pending.id)
                put("title", pending.title)
                put("source", pending.source)
                put("createdAt", pending.startedAtMs)
                put("durationMs", msPrimitive(pending.durationMs))
                putJsonArray("segments") {
                    pending.segments.forEach { segment ->
                        addJsonObject {
                            put("id", segment.id)
                            put("source", segment.source)
                            put("speaker", segment.speaker)
                            put("text", segment.text)
                            put("isFinal", true)
                            put("startMs", segment.startMs)
                            put("endMs", segment.endMs)
                        }
                    }
                }
                put("speakerNames", JsonObject(emptyMap()))
                put("findings", JsonArray(emptyList()))
                put("actionItems", JsonArray(emptyList()))
                put("meetingContext", "")
                put("meetingBatna", "")
                put("meetingTarget", "")
                put("meetingFloor", "")
                put("audio", AUDIO_FILE_NAME)
                put("analyzed", false)
                pending.folderId?.let { put("folderId", it) }
            }
        )

        /**
         * The library card pushed as `summary`. Identical to iOS
         * `MeetingUploader.buildSummary`: distinct `"{source}-{speaker}"` pairs for
         * the speaker count, the first three final lines (capped at 120 chars) for
         * the snippet, and zero analysis counts because the phone does not analyze.
         */
        fun buildSummary(pending: PendingUpload): RecordingSummary {
            val speakers = pending.segments.map { "${it.source}-${it.speaker}" }.toSet().size
            val snippet = pending.segments.take(3).joinToString(" ") { it.text }.take(120)
            return RecordingSummary(
                id = pending.id,
                title = pending.title,
                source = pending.source,
                createdAt = pending.startedAtMs.toDouble(),
                durationMs = pending.durationMs,
                speakerCount = maxOf(speakers, if (pending.segments.isEmpty()) 0 else 1),
                findingsCount = 0,
                actionItemsCount = 0,
                hasAudio = true,
                snippet = snippet,
                folderId = pending.folderId,
                updatedAt = null,
            )
        }
    }
}
