package com.pathors.parley.upload

import android.content.Context
import com.pathors.parley.cloud.CloudClient
import com.pathors.parley.cloud.CloudException
import com.pathors.parley.cloud.RecordingMeta
import com.pathors.parley.cloud.RecordingSource
import com.pathors.parley.cloud.RecordingSummary
import com.pathors.parley.cloud.TranscriptSegmentDto
import com.pathors.parley.cloud.msPrimitive
import com.pathors.parley.playback.AudioRetention
import com.pathors.parley.playback.LocalAudioStore
import com.pathors.parley.util.deleteQuietly
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

/**
 * One finished recording being handed to [MeetingUploader.enqueue].
 *
 * The recording's parameters travel as one object rather than as a long
 * argument list: they describe a single thing, they are always passed together,
 * and the defaults (a fresh id, "now", a live capture) are the same at every
 * call site.
 *
 * [audio] is MOVED into the queue directory by [MeetingUploader.enqueue]; the
 * caller must not touch it afterwards.
 */
data class EnqueueRequest(
    val audio: File,
    val title: String,
    val durationMs: Double,
    val segments: List<TranscriptSegmentDto> = emptyList(),
    val startedAtMs: Long = System.currentTimeMillis(),
    val source: String = RecordingSource.LIVE,
    val id: String = MeetingUploader.newRecordingId(),
    val folderId: String? = null,
)

/** What one [MeetingUploader.drain] pass achieved. */
data class DrainResult(
    /** Recordings fully uploaded (audio + summary/meta) and removed from the queue. */
    val uploaded: Int,
    /** Still waiting after the pass — what a "N waiting to upload" badge shows. */
    val remaining: Int,
    /**
     * Recordings dropped from the queue because they can never be uploaded:
     * the audio blob is gone or empty, or the server refused the upload in a
     * way it will refuse identically forever (see [UploadFailureDisposition]).
     */
    val discarded: Int = 0,
    /**
     * Why the pass stopped early, or the last refusal it dropped a recording
     * over on the way through. Null means nothing went wrong at all.
     */
    val failure: Throwable? = null,
    /**
     * The recordings this pass dropped because the server refused them for
     * good, by id, with the refusal. A caller that just queued a recording
     * checks here before telling anyone it was saved.
     */
    val refused: Map<String, Throwable> = emptyMap(),
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
 * [drain] runs on app start, after sign-in, when a validated network returns and
 * when the app comes back to the foreground (see [AutoSync]); it is safe to call
 * concurrently (passes are serialized by an internal mutex).
 */
class MeetingUploader(
    private val cloud: CloudClient,
    private val queue: PendingUploadQueue,
    /**
     * Where a recording goes when its transcript does not account for its audio.
     *
     * Null means this uploader has no safety net and retires every Ogg the
     * moment the cloud has it — the pre-backfill behaviour, kept as the default
     * so a test that is asking about upload retries does not have to hand one
     * over. [create] wires the real queue.
     */
    private val backfills: PendingBackfillQueue? = null,
    /**
     * Where a kept recording's audio goes once the cloud has it. Null means this
     * uploader has nowhere to keep audio and always deletes — which is what the
     * upload tests want, and nothing else.
     */
    private val localAudio: LocalAudioStore? = null,
    /**
     * The "keep audio on this phone" setting, read at retirement time rather
     * than captured at construction: the switch can be flipped between a
     * recording finishing and its upload finally going through.
     */
    private val keepsAudioOnPhone: suspend () -> Boolean = { false },
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
     * Hand a finished recording to the durable queue. [EnqueueRequest.audio] is
     * MOVED into the queue directory, so the caller must not use it afterwards.
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
    suspend fun enqueue(request: EnqueueRequest): String? = withContext(Dispatchers.IO) {
        if (request.source == RecordingSource.LIVE &&
            request.durationMs < MIN_LIVE_DURATION_MS
        ) {
            request.audio.deleteQuietly()
            return@withContext null
        }
        val pending = PendingUpload(
            id = request.id,
            title = request.title,
            source = request.source,
            startedAtMs = request.startedAtMs,
            durationMs = request.durationMs,
            segments = request.segments.filter { it.isFinal && !it.id.endsWith(TAIL_SUFFIX) },
            folderId = request.folderId,
        )
        queue.enqueue(pending, request.audio)
        request.id
    }

    /**
     * [enqueue] then immediately try to upload — what the "stop recording" path
     * calls. Returns null when the recording was dropped as too short.
     */
    suspend fun finishAndUpload(request: EnqueueRequest): DrainResult? {
        enqueue(request) ?: return null
        return drain()
    }

    /**
     * Upload everything waiting, oldest first.
     *
     * Each recording gets [maxAttempts] tries with exponential backoff for
     * transient failures (network drop, 5xx, 408, 429). What happens when those
     * are spent, or on a failure retrying cannot fix, is iOS
     * `MeetingUploader.syncPending`'s rule with one deliberate exception (402,
     * below) — see [dispositionOf]:
     *
     * - a refusal the server will repeat forever (most 4xx) **drops that
     *   recording** and the pass carries on with the next one. Leaving it at the
     *   head of an oldest-first queue would jam every recording behind it on
     *   every future pass;
     * - anything a later event can clear (sign in again, the quota resetting,
     *   wait, the network coming back, the server recovering) **stops the pass**
     *   with the queue untouched, because the next recording would fail the same
     *   way. Nothing in that class is retried within the pass beyond what
     *   [CloudException.isRetryable] allows — a 402 gets exactly one request.
     */
    suspend fun drain(): DrainResult = drainMutex.withLock {
        val pending = withContext(Dispatchers.IO) { queue.list() }
        var uploaded = 0
        var discarded = 0
        var failure: Throwable? = null
        val refused = LinkedHashMap<String, Throwable>()

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
                // The cloud now holds everything, so the *queue's* copy has done
                // its job — unless the transcript that went up does not account
                // for the audio that went with it, in which case the Ogg is the
                // only thing that can still fix it and is handed to the backfill
                // queue instead of retired.
                if (!handOffForBackfill(item, audio)) {
                    retireAudio(item.id, audio)
                }
                withContext(Dispatchers.IO) { queue.remove(item.id) }
                uploaded++
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                failure = e
                when (dispositionOf(e)) {
                    UploadFailureDisposition.DROP -> {
                        withContext(Dispatchers.IO) { queue.remove(item.id) }
                        discarded++
                        refused[item.id] = e
                    }
                    UploadFailureDisposition.STOP_PASS -> break
                }
            }
        }

        DrainResult(
            uploaded = uploaded,
            remaining = withContext(Dispatchers.IO) { queue.count() },
            discarded = discarded,
            failure = failure,
            refused = refused,
        )
    }

    /**
     * The end of an Ogg's life in the upload queue, for every path that reaches
     * it: a live meeting, an import, and a queued upload that finally synced.
     *
     * One function because the setting has to mean the same thing down all of
     * them — a "keep audio on this phone" that only held live recordings would
     * be a setting nobody could predict. (iOS makes the same argument in
     * `MeetingUploader.retireAudio`.)
     *
     * A failed move deletes instead. The cloud already has the file, so the cost
     * is a recording that has to be downloaded to play back; leaving it in a
     * queue directory that nothing reads any more would cost the same bytes
     * forever with no way to see or clear them.
     *
     * The one path deliberately NOT routed through here is the too-short live
     * capture dropped by [enqueue]: a two-second misfire was never a recording,
     * it is not in the cloud, and keeping it would put a row of noise in the
     * storage total that no screen could explain.
     */
    /**
     * Give the Ogg to the backfill queue when the transcript that just went up
     * leaves too much of the recording unaccounted for.
     *
     * Deliberately quiet about its own failures. The recording is safely in the
     * cloud with the transcript it has by the time this runs; failing to queue a
     * backfill costs quality, not the meeting, and must not surface as an upload
     * failure. A failure here falls through to the ordinary retirement, which is
     * exactly what would have happened before there was a safety net.
     *
     * @return whether the backfill queue now owns the file. False means the
     *   caller still has to retire it.
     */
    private suspend fun handOffForBackfill(pending: PendingUpload, audio: File): Boolean {
        val queue = backfills ?: return false
        if (!TranscriptBackfiller.coverage(pending).needsBackfill()) return false
        return withContext(Dispatchers.IO) {
            runCatching {
                queue.enqueueMoving(
                    BackfillRequest(pending = pending, folderId = pending.folderId),
                    audio,
                )
            }.isSuccess
        }
    }

    private suspend fun retireAudio(id: String, audio: File) = withContext(Dispatchers.IO) {
        if (!audio.isFile) return@withContext
        val store = localAudio
        if (store != null && keepsAudioOnPhone() && store.put(id, audio)) return@withContext
        audio.deleteQuietly()
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
        /**
         * What a failed upload means for the recording it was carrying — iOS
         * `MeetingUploader.isTerminal`, with one deliberate difference.
         *
         * | Status | Disposition | Why |
         * |---|---|---|
         * | 401 | stop the pass | signing in again clears it |
         * | 402 | stop the pass | the quota resets; the recording must survive until it does |
         * | 403 | stop the pass | being granted access clears it |
         * | 408, 425, 429 | stop the pass | waiting clears it |
         * | any other 4xx (400, 404, 413, …) | **drop** the recording | refused identically forever |
         * | 5xx, 0, a bare [IOException], anything else | stop the pass | the server or the network recovers |
         *
         * The difference is 402. iOS drops it — while its own importer tells the
         * user "the recording is safe on this phone and will sync once the quota
         * resets". That promise is the contract; the drop is the bug (iOS should
         * get the same fix). Out of quota is a wait measured in weeks, not a
         * refusal, so the recording stays queued, manifest and audio, and the
         * pass stops rather than failing every recording behind it.
         */
        fun dispositionOf(failure: Throwable): UploadFailureDisposition {
            val status = (failure as? CloudException)?.status ?: return UploadFailureDisposition.STOP_PASS
            return when (status) {
                401, 402, 403, 408, 425, 429 -> UploadFailureDisposition.STOP_PASS
                in 400..499 -> UploadFailureDisposition.DROP
                else -> UploadFailureDisposition.STOP_PASS
            }
        }

        /** Live captures shorter than this are treated as a misfire (iOS parity). */
        const val MIN_LIVE_DURATION_MS = 2_000.0

        /** The id suffix the live transcriber uses for its tentative segment. */
        const val TAIL_SUFFIX = "-tail"

        /** Audio file name recorded inside the meta JSON, as on desktop and iOS. */
        const val AUDIO_FILE_NAME = "audio.ogg"

        /** Lowercase UUID — the same id shape every Parley client generates. */
        fun newRecordingId(): String = UUID.randomUUID().toString().lowercase(Locale.ROOT)

        fun create(context: Context, cloud: CloudClient): MeetingUploader {
            val retention = AudioRetention(context)
            return MeetingUploader(
                cloud = cloud,
                queue = PendingUploadQueue.default(context),
                backfills = PendingBackfillQueue.default(context),
                localAudio = LocalAudioStore.default(context),
                keepsAudioOnPhone = retention::keepsAudioOnPhoneNow,
            )
        }

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

/** What [MeetingUploader.drain] does with a recording whose upload failed. */
enum class UploadFailureDisposition {
    /**
     * The server will refuse this recording the same way forever: remove it
     * (manifest and audio) and carry on with the rest of the queue.
     */
    DROP,

    /** Worth trying again later: keep it, and stop this pass. */
    STOP_PASS,
}
