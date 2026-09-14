package com.pathors.parley.upload

import android.content.Context
import com.pathors.parley.cloud.CloudClient
import com.pathors.parley.cloud.RecordingMeta
import com.pathors.parley.cloud.RecordingSource
import com.pathors.parley.cloud.RecordingSummary
import com.pathors.parley.cloud.toDtos
import com.pathors.parley.kit.BatchTranscriber
import com.pathors.parley.kit.ManualRetryBudget
import com.pathors.parley.kit.TranscriptCoverage
import com.pathors.parley.playback.AudioRetention
import com.pathors.parley.playback.LocalAudioStore
import com.pathors.parley.util.deleteQuietly
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** What one [TranscriptBackfiller.drain] pass achieved. */
data class BackfillResult(
    /** Recordings whose transcript was replaced (or confirmed not worth replacing). */
    val repaired: Int,
    /** Still waiting after the pass. */
    val remaining: Int,
    /** Manifests dropped because their audio blob was gone (unrunnable forever). */
    val discarded: Int = 0,
    /** Why the pass stopped early, if it did. Null means the queue drained clean. */
    val failure: Throwable? = null,
)

/**
 * A re-transcription was asked for on a recording that has already used up
 * [TranscriptCoverage.BackfillPolicy.maxManualRetries].
 *
 * A typed refusal rather than a silent no-op: the entry point is expected to be
 * disabled in that case, so reaching here means a screen was open while the last
 * run finished elsewhere, and the person deserves to be told which it was.
 */
class ManualRetryBudgetSpentException(val recordingId: String) :
    IllegalStateException("manual retry budget spent for $recordingId")

/**
 * The transcript safety net: recordings whose live transcript came up short get
 * their audio transcribed again, in full, and the thin transcript replaced.
 *
 * ## Why this exists at all
 *
 * A live relay leg can die without saying so, and until now an Android meeting
 * that lost its relay lost those minutes permanently. Nothing on the server side
 * transcribes an uploaded recording — that is a client's job on every platform,
 * and iOS has been doing it since `MeetingUploader.syncPendingBackfills`. This
 * is the Android half.
 *
 * ## Whole-file, not gap-filling
 *
 * An async job costs less than the realtime leg that already ran, so the
 * arithmetic never favours stitching. What stitching would cost instead is a
 * seam — two models, two speaker numberings and two clocks meeting in the middle
 * of a sentence — for a saving of a few cents.
 *
 * ## What a run is allowed to change
 *
 * The transcript and the duration, and on a recording that has a life of its own
 * (speaker names typed in, a desktop analysis, a brief) nothing else — see
 * [RecordingMeta.replacingTranscript]. The audio in the cloud is untouched: it
 * is the very file that was re-transcribed, so this is a metadata push only and
 * the recording keeps its id, its folder and its sharing.
 */
class TranscriptBackfiller(
    private val cloud: CloudClient,
    private val queue: PendingBackfillQueue,
    private val ledger: ManualRetryLedger,
    /** Injectable so tests drive the polling loop without a network or a clock. */
    private val transcriber: BatchTranscriber = BatchTranscriber(cloud),
    /** Where a kept recording's audio goes once a run is over. Null always deletes. */
    private val localAudio: LocalAudioStore? = null,
    /** "Keep audio on this phone", read at retirement time. See [MeetingUploader]. */
    private val keepsAudioOnPhone: suspend () -> Boolean = { false },
    private val policy: TranscriptCoverage.BackfillPolicy =
        TranscriptCoverage.BackfillPolicy.STANDARD,
) {
    private val drainMutex = Mutex()

    // ── what a screen needs to know ──────────────────────────────────────────

    /** How many recordings are waiting for a better transcript. */
    suspend fun pendingCount(): Int = withContext(Dispatchers.IO) { queue.count() }

    /**
     * Whether this recording has a re-transcription waiting or in flight, so a
     * detail screen can say so and not offer a second one.
     */
    suspend fun isQueued(id: String): Boolean = withContext(Dispatchers.IO) { queue.has(id) }

    /** How many hand-triggered re-runs this recording has left, 0…3. */
    suspend fun retriesRemaining(id: String): Int =
        withContext(Dispatchers.IO) { ledger.read().remaining(id, policy) }

    /** The whole ledger, for a screen that wants more than one recording's count. */
    suspend fun retryBudget(): ManualRetryBudget = withContext(Dispatchers.IO) { ledger.read() }

    /**
     * Forget a recording: drop anything queued for it and give its budget back.
     * For a deletion, so neither outlives the recording it belongs to.
     */
    suspend fun forget(id: String) = withContext(Dispatchers.IO) {
        queue.remove(id)
        ledger.forget(id)
        Unit
    }

    // ── asking for one by hand ───────────────────────────────────────────────

    /**
     * Queue a re-transcription somebody asked for, on a recording that is
     * already in the cloud.
     *
     * The same queue the automatic backfill uses, and deliberately so: the work
     * is identical — transcribe the whole file, push the metadata, leave the
     * audio in the cloud alone — and a second mechanism would be a second set of
     * retry, persistence and cap bugs. What differs is only how it got there,
     * which is what [BackfillRequest.manualRetries] records.
     *
     * The audio is **copied**, not moved: [audio] is the file the player on
     * screen is reading from.
     *
     * Personal scope only. The caller enforces that (the entry point is hidden
     * in org scope) because only the personal endpoints can be re-pushed from
     * the phone at all.
     *
     * @param meta the recording's full entry as the cloud holds it. Required,
     *   not optional: a request that reached the queue without it would fall
     *   through to the automatic path and rebuild the entry from the new
     *   transcript alone — wiping the analysis this whole detour exists to
     *   protect.
     * @param summary the library card, when the caller has one. A detail screen
     *   fetches only the meta, so null derives it via [RecordingSummary.fromMeta]
     *   rather than making every caller find one.
     * @throws ManualRetryBudgetSpentException when the cap is used up.
     */
    suspend fun requestRetranscription(
        meta: RecordingMeta,
        audio: File,
        summary: RecordingSummary? = null,
    ): Unit = withContext(Dispatchers.IO) {
        val resolved = summary ?: RecordingSummary.fromMeta(meta)
        val id = resolved.id.ifEmpty { meta.id }
        require(id.isNotEmpty()) { "a re-transcription needs a recording id" }
        require(audio.isFile && audio.length() > 0L) { "no audio to re-transcribe for $id" }

        val budget = ledger.read()
        if (!budget.allowsRetry(id, policy)) throw ManualRetryBudgetSpentException(id)

        val folderId = meta.folderId ?: resolved.folderId
        val createdAt = if (meta.createdAt > 0) meta.createdAt else resolved.createdAt
        val pending = PendingUpload(
            id = id,
            title = meta.title.ifEmpty { resolved.title },
            source = meta.source.ifEmpty { resolved.source.ifEmpty { RecordingSource.LIVE } },
            startedAtMs = createdAt.toLong(),
            durationMs = maxOf(meta.durationMs, resolved.durationMs),
            // What the recording reads as today. Only a fallback — the new
            // transcript replaces it — but a request carrying no transcript at
            // all would push a blank one if the job came back empty and the
            // fallback path were ever taken.
            segments = meta.segments.filter {
                it.isFinal && !it.id.endsWith(MeetingUploader.TAIL_SUFFIX)
            },
            folderId = folderId,
        )

        // Over whatever is already queued for this recording — an automatic
        // backfill, or one of these whose run never landed.
        val queued = queue.request(id)?.manualRetries ?: 0
        val request = BackfillRequest(
            pending = pending,
            folderId = folderId,
            manualRetries = maxOf(queued + 1, budget.nextAttempt(id)),
            existingMeta = meta.raw,
            existingSummary = resolved,
        )
        // A failure here leaves nothing behind — the queue gives the file back
        // rather than keep an Ogg no manifest points at — and reaches the caller,
        // because a re-transcription that was silently not queued is worse than
        // one that said so.
        queue.enqueueCopying(request, audio)
    }

    // ── running them ─────────────────────────────────────────────────────────

    /**
     * Transcribe everything queued and replace the transcripts that came up
     * short, oldest first.
     *
     * Safe to call concurrently; passes are serialized by a mutex. Never urgent:
     * one failure stops the pass, because a flat network will fail the next one
     * the same way and the recording is already safely in the cloud with the
     * transcript it has.
     */
    suspend fun drain(): BackfillResult = drainMutex.withLock {
        val requests = withContext(Dispatchers.IO) { queue.list() }
        var repaired = 0
        var discarded = 0
        var failure: Throwable? = null

        for (request in requests) {
            val audio = queue.audioFile(request.id)
            if (!withContext(Dispatchers.IO) { audio.isFile && audio.length() > 0L }) {
                // The manifest outlived its blob (an interrupted enqueue, or a
                // user clearing app storage). It can never be run, and keeping
                // it would block the queue head forever — the same protection
                // MeetingUploader.drain gives the upload queue.
                withContext(Dispatchers.IO) { queue.remove(request.id) }
                discarded++
                continue
            }
            try {
                run(request, audio)
                repaired++
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                failure = e
                break
            }
        }

        BackfillResult(
            repaired = repaired,
            remaining = withContext(Dispatchers.IO) { queue.count() },
            discarded = discarded,
            failure = failure,
        )
    }

    private suspend fun run(request: BackfillRequest, audio: File) {
        val id = request.id
        // Same call the import path makes: no language hints, so the cloud
        // auto-detects exactly as the desktop does with an empty list.
        val transcript = transcriber.transcribe(
            audio = audio,
            diarization = true,
            languageHints = emptyList(),
        )

        // The transcription has completed and been billed, so a hand-triggered
        // run is charged *here* — after the call that could have thrown, and
        // before the empty-transcript exit below. Everything above this line can
        // fail for free; nothing below it can fail in a way that gives the hour
        // back.
        if (request.isManual) withContext(Dispatchers.IO) { ledger.spend(id) }

        // A job that came back with nothing is not an improvement on a thin
        // transcript — keep what the meeting already had rather than blanking
        // it, and stop retrying audio that has now been paid for once.
        if (transcript.segments.isEmpty()) {
            finish(id, audio)
            return
        }

        val segments = transcript.segments.toDtos()
        val durationMs = maxOf(request.pending.durationMs, transcript.durationMs.toDouble())
        val existingMeta = request.existingRecordingMeta()
        val existingSummary = request.existingSummary

        val meta: RecordingMeta
        val summary: RecordingSummary
        if (existingMeta != null && existingSummary != null) {
            // A re-run of a recording that already has a life of its own: edit
            // the transcript inside what is there rather than replacing it.
            // `request.folderId` is not applied — the captured meta already
            // carries the recording's own folder, and writing the request's copy
            // over it would turn a re-transcription into a move.
            meta = existingMeta.replacingTranscript(segments, durationMs)
            summary = existingSummary.replacingTranscript(segments, durationMs)
        } else {
            // The automatic path: this recording was created by the upload that
            // queued the backfill, so there is nothing on it to preserve.
            val repaired = request.pending.copy(
                durationMs = durationMs,
                segments = segments,
                folderId = request.folderId ?: request.pending.folderId,
            )
            meta = MeetingUploader.buildMeta(repaired)
            summary = MeetingUploader.buildSummary(repaired)
        }

        // Audio is already in the cloud and unchanged, so this is a metadata
        // push only.
        cloud.pushRecording(id, summary, meta)
        finish(id, audio)
    }

    /**
     * A backfill that is over, whichever way it ended.
     *
     * The Ogg has been paid for twice by now — once live, once in the batch job
     * — so this is the last chance to keep it, and it is taken on exactly the
     * same terms as a plain upload's: into the local store if the phone keeps
     * its audio, deleted otherwise. A failed move deletes rather than leaving
     * bytes in a directory nothing reads any more.
     */
    private suspend fun finish(id: String, audio: File) = withContext(Dispatchers.IO) {
        queue.removeManifest(id)
        if (!audio.isFile) return@withContext
        val store = localAudio
        if (store != null && keepsAudioOnPhone() && store.put(id, audio)) return@withContext
        audio.deleteQuietly()
    }

    companion object {
        fun create(context: Context, cloud: CloudClient): TranscriptBackfiller {
            val retention = AudioRetention(context)
            return TranscriptBackfiller(
                cloud = cloud,
                queue = PendingBackfillQueue.default(context),
                ledger = ManualRetryLedger.default(context),
                localAudio = LocalAudioStore.default(context),
                keepsAudioOnPhone = retention::keepsAudioOnPhoneNow,
            )
        }

        /**
         * How much of [pending]'s audio its transcript accounts for.
         *
         * Here rather than in [MeetingUploader] because the DTO-to-span mapping
         * and the queue that acts on it belong to the same idea, and because a
         * test can ask this question without a cloud, a queue or a file. The
         * decision is the caller's: ask the returned report
         * [TranscriptCoverage.Report.needsBackfill].
         */
        fun coverage(pending: PendingUpload): TranscriptCoverage.Report {
            val totalMs = pending.durationMs.coerceAtLeast(0.0).toLong()
            val spans = pending.segments.mapNotNull {
                TranscriptCoverage.coverageSpan(it.id, it.isFinal, it.startMs, it.endMs, totalMs)
            }
            return TranscriptCoverage.reportOfSpans(spans, totalMs)
        }
    }
}
