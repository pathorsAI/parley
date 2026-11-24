package com.pathors.parley.meeting

import android.content.Context
import android.net.Uri
import com.pathors.parley.audio.AudioDecodeException
import com.pathors.parley.audio.AudioFileDecoder
import com.pathors.parley.audio.DecodeRange
import com.pathors.parley.audio.DecodeEvent
import com.pathors.parley.audio.OggOpusEncoder
import com.pathors.parley.audio.OpusEncodeException
import com.pathors.parley.auth.AuthManager
import com.pathors.parley.cloud.RecordingSource
import com.pathors.parley.cloud.TranscriptSegmentDto
import com.pathors.parley.feedback.Log
import com.pathors.parley.kit.ImportPart
import com.pathors.parley.kit.ImportSplitPlan
import com.pathors.parley.kit.SttRelayClient
import com.pathors.parley.kit.SttRelayEvent
import com.pathors.parley.kit.TranscriptSegment
import com.pathors.parley.library.SaveDestination
import com.pathors.parley.upload.EnqueueRequest
import com.pathors.parley.upload.MeetingUploader
import com.pathors.parley.upload.PendingUpload
import com.pathors.parley.upload.TranscriptBackfiller
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** Where an "import a recording" run is in its lifecycle. */
sealed interface ImportState {
    data object Idle : ImportState

    /** Probing the container for its duration and codec. */
    data object Preparing : ImportState

    /**
     * Decoding and streaming. [decodeProgress] is 0..1, or -1 when the container
     * never said how long it is; [transcribedMs] is how far the transcript has
     * got, which lags the decoder by the relay's round trip.
     */
    data class Running(
        val decodeProgress: Float,
        val transcribedMs: Long,
        val durationMs: Long,
    ) : ImportState

    data object Uploading : ImportState

    /**
     * Saved. [pendingUpload] means it is still on this phone waiting to upload;
     * [waitingForQuota] narrows that to "the cloud said 402", which a quota
     * reset clears rather than the network coming back. [transcript] says
     * whether the transcript it went up with is the whole story or is being
     * redone in the background.
     */
    data class Finished(
        val recordingId: String,
        val pendingUpload: Boolean,
        val transcript: ImportTranscript = ImportTranscript.COMPLETE,
        val waitingForQuota: Boolean = false,
        /**
         * The organization the default save location shares a copy into, or
         * null for personal only — what lets the library say "and shared to".
         */
        val sharedToOrgId: String? = null,
        /**
         * The cloud refused the upload: it is parked on this phone (never
         * deleted) and retried later or from the library. Only with
         * [pendingUpload].
         */
        val uploadRefused: Boolean = false,
    ) : ImportState

    /**
     * [part] names which part of a split import failed; the parts before it
     * are already saved and stay. Null for a file imported whole.
     */
    data class Failed(
        val reason: ImportFailure,
        val detail: String? = null,
        val part: ImportPartLabel? = null,
    ) : ImportState

    /** The user backed out; the temporary files are already gone. */
    data object Cancelled : ImportState
}

/**
 * An import that reached the cloud, as the library reports it: iOS's inline
 * "Imported “X”" / "Imported “X” and shared to “Org”" above the list.
 *
 * Android keeps a screen of its own for the progress, which closes itself on a
 * clean finish; without this the library it returns to said nothing at all
 * about what had just happened.
 */
data class ImportNotice(val title: String, val sharedToOrgId: String?) {
    companion object {
        /**
         * The notice for an import leaving the screen in [state], or null when
         * there is nothing to announce: still running, failed, cancelled, or
         * saved on the phone but not yet in the cloud — the upload queue above
         * the list is already saying that one.
         */
        fun of(title: String?, state: ImportState?): ImportNotice? {
            val finished = state as? ImportState.Finished ?: return null
            if (title == null || finished.pendingUpload) return null
            return ImportNotice(title, finished.sharedToOrgId)
        }
    }
}

/** Which part of a split import is running, 1-based: "Part [index] of [count]". */
data class ImportPartLabel(val index: Int, val count: Int)

/** Why an import ended badly. The UI owns the (bilingual) copy for each case. */
enum class ImportFailure {
    NOT_SIGNED_IN,

    /** The relay refused the session token (HTTP 401): sign in again. */
    SESSION_EXPIRED,

    /** The account's hosted transcription allowance is spent. */
    QUOTA_EXHAUSTED,
    UNREADABLE,
    NO_AUDIO_TRACK,
    UNSUPPORTED_CODEC,
    DECODE_FAILED,
    ENCODER_UNAVAILABLE,
    UPLOAD_FAILED,
    UNKNOWN,
}

private const val TAG = "ImportSession"

/**
 * The scope an import runs on when the caller does not supply one. The
 * [CoroutineExceptionHandler] keeps an unhandled throw in the relay event
 * collector off the process's default handler — a [SupervisorJob] alone does
 * not do that. See `MeetingSession` for the long version.
 */
private fun defaultImportScope(): CoroutineScope = CoroutineScope(
    SupervisorJob() + Dispatchers.IO +
        CoroutineExceptionHandler { _, t -> Log.e(TAG, "unhandled in import scope", t) },
)

/**
 * Transcribe an audio file the user already has.
 *
 * ```
 * SAF Uri ─▶ AudioFileDecoder ──ByteArray──┬─▶ OggOpusEncoder.append  ──▶ {id}.ogg
 *                                          └─▶ SttRelayClient.sendPcm ──▶ segments
 * ```
 *
 * Same two sinks as [MeetingSession], with three differences that matter:
 *
 * - the decoder runs **faster than realtime**; `sendPcm` suspends once 1 MB is
 *   queued on the socket, which is what throttles the decode to the network
 *   instead of buffering the whole file,
 * - the recording is pushed with `source = upload`,
 * - **an imported file is never dropped for being short.** Discarding a file the
 *   user deliberately picked would be a bug (see `docs/api-cloud.md`).
 *
 * What the relay does along the way is not ignored: running out of quota or
 * losing the session stops the import, and any other relay failure keeps the
 * recording but says the transcript is being finished in the background —
 * see [ImportRelayOutcome] for why the line falls there.
 *
 * No foreground service: an import is a foreground task the user is watching. If
 * the process is killed mid-import the partial upload never enqueues and the
 * temporary files are cache, so nothing is left behind.
 */
class ImportSession(
    private val context: Context,
    private val auth: AuthManager,
    private val uploader: MeetingUploader,
    val uri: Uri,
    /** Display title — the picked file's name, chosen by the UI layer. */
    val title: String,
    /**
     * Run the backfill queue. Called once the recording has been handed to the
     * uploader, so a transcript that came up short starts being redone now
     * rather than at the next launch.
     */
    private val drainBackfills: () -> Unit = {},
    private val scope: CoroutineScope = defaultImportScope(),
    /**
     * The "Default save location", read once the file is ready to queue. Read
     * here rather than left to the uploader so the finished state can say which
     * organization got a copy; the uploader honours an explicit destination
     * exactly as it would have resolved it. Null leaves it to the uploader.
     */
    private val defaultDestination: (suspend () -> SaveDestination)? = null,
    /**
     * Run the filing pass (the AI title + folder suggestion) for the recording
     * just uploaded, and persist it on the recording so its page offers it.
     * Called only for a recording that reached the personal library with
     * something said in it — the live meeting screen's rule. The callee owns
     * the scope: the import screen closes itself on a clean finish, and the
     * pass must not go with it.
     */
    private val runFilingPass: (recordingId: String) -> Unit = {},
    /** The personal dictionary's recognition terms, sent as the relay's hints. */
    private val hintTerms: () -> List<String> = { emptyList() },
    /**
     * The file is too long for one hosted session and the user agreed to
     * import it in parts (see [ImportSplit]). Null imports it whole, as before.
     */
    private val split: ImportSplitPlan? = null,
    /** The title of each part, `name（k/n）` / `name (k/n)`. Only read with [split]. */
    private val partTitle: (ImportPart) -> String = { title },
) {
    private val _state = MutableStateFlow<ImportState>(ImportState.Idle)
    val state: StateFlow<ImportState> = _state.asStateFlow()

    private val _part = MutableStateFlow<ImportPartLabel?>(null)

    /** The part running now, for a split import; null for a file imported whole. */
    val part: StateFlow<ImportPartLabel?> = _part.asStateFlow()

    private val _segments = MutableStateFlow<List<TranscriptSegment>>(emptyList())
    val segments: StateFlow<List<TranscriptSegment>> = _segments.asStateFlow()

    private var relay: SttRelayClient? = null
    private var encoder: OggOpusEncoder? = null
    private var runJob: Job? = null
    private var eventsJob: Job? = null

    private val byId = LinkedHashMap<String, TranscriptSegment>()

    /**
     * The worst thing the relay has said so far. Written from the event
     * collector, read by the decode loop, hence volatile.
     */
    @Volatile private var relayVerdict: ImportRelayVerdict = ImportRelayVerdict.Healthy

    /** Set just before `end` goes out; a close after it is the normal end. */
    @Volatile private var finishSent = false
    private var transcribedMs = 0L
    private var durationMs = -1L
    private var decodeProgress = 0f

    fun start() {
        if (_state.value !is ImportState.Idle) return
        _state.value = ImportState.Preparing
        runJob = scope.launch { run() }
    }

    /**
     * The import, with a floor under it. [runImport] maps the failures it knows
     * about; anything else becomes [ImportFailure.UNKNOWN] rather than an
     * uncaught exception that would take the process down with it.
     */
    private suspend fun run() {
        val parts: List<ImportPart?> = split?.parts ?: listOf(null)
        var finished: ImportState.Finished? = null
        for (part in parts) {
            val label = part?.let { ImportPartLabel(it.index, it.count) }
            _part.value = label
            resetForPart()
            val result = runPart(part)
            if (result == null) {
                // The part failed and [state] says why. Parts already finished
                // stay saved; nothing is retried automatically.
                val failed = _state.value as? ImportState.Failed
                if (failed != null && label != null) _state.value = failed.copy(part = label)
                return
            }
            finished = finished?.let { merge(it, result) } ?: result
        }
        // Published once, after the last part: an intermediate Finished would
        // let the screen close itself (and drop the session) after part 1.
        finished?.let { _state.value = it }
    }

    /**
     * One run of the pipeline — the whole file, or one [part] of it.
     *
     * @return the outcome, or null when it failed and [state] already says why.
     */
    private suspend fun runPart(part: ImportPart?): ImportState.Finished? =
        try {
            runImport(part)
        } catch (e: CancellationException) {
            throw e // cancel() — the user backed out, not a failure
        } catch (t: Throwable) {
            Log.e(TAG, "import failed", t)
            abandon()
            _state.value = ImportState.Failed(ImportFailure.UNKNOWN, t.message)
            null
        }

    /** Everything one part's run accumulates, cleared before the next part starts. */
    private fun resetForPart() {
        relay = null
        encoder = null
        eventsJob = null
        byId.clear()
        _segments.value = emptyList()
        relayVerdict = ImportRelayVerdict.Healthy
        finishSent = false
        transcribedMs = 0L
        durationMs = -1L
        decodeProgress = 0f
        if (_state.value !is ImportState.Idle) _state.value = ImportState.Preparing
    }

    /**
     * What a split import ends on: the last part's recording, with any caveat
     * a part had — still on the phone, waiting for quota, transcript being
     * redone — carried through, so the screen does not close itself over one.
     */
    private fun merge(soFar: ImportState.Finished, next: ImportState.Finished) = next.copy(
        pendingUpload = soFar.pendingUpload || next.pendingUpload,
        transcript = if (soFar.transcript == ImportTranscript.COMPLETES_IN_BACKGROUND) {
            ImportTranscript.COMPLETES_IN_BACKGROUND
        } else {
            next.transcript
        },
        waitingForQuota = soFar.waitingForQuota || next.waitingForQuota,
        uploadRefused = soFar.uploadRefused || next.uploadRefused,
    )

    private suspend fun runImport(part: ImportPart?): ImportState.Finished? {
        val token = auth.currentToken() ?: return failNull(ImportFailure.NOT_SIGNED_IN)

        if (part == null) {
            try {
                durationMs = AudioFileDecoder.probe(context, uri).durationMs
            } catch (e: AudioDecodeException) {
                return failNull(decodeFailure(e), e.message)
            }
        } else {
            durationMs = part.durationMs
        }

        val encoder = try {
            OggOpusEncoder.create(newAudioFile())
        } catch (e: OpusEncodeException) {
            return failNull(ImportFailure.ENCODER_UNAVAILABLE, e.message)
        }
        this.encoder = encoder

        val client = connectRelay(token)
        publishRunning()
        var decodedMs = decodeAndStream(encoder, client, part?.decodeRange()) ?: return null
        if (!drainRelayTail(client)) return null

        val audio = try {
            withContext(Dispatchers.IO) { encoder.finish() }
        } catch (e: OpusEncodeException) {
            return failNull(ImportFailure.ENCODER_UNAVAILABLE, e.message)
        }
        if (decodedMs <= 0L) decodedMs = encoder.durationMs

        return uploadAndFinish(audio, decodedMs, part?.let(partTitle) ?: title)
    }

    private fun fail(reason: ImportFailure, detail: String? = null) {
        _state.value = ImportState.Failed(reason, detail)
    }

    /** [fail], as a null outcome for `return`. */
    private fun failNull(reason: ImportFailure, detail: String? = null): ImportState.Finished? {
        fail(reason, detail)
        return null
    }

    /** Opens the relay and starts listening to it; audio goes out via [decodeAndStream]. */
    private suspend fun connectRelay(token: String): SttRelayClient {
        val client = SttRelayClient(importRelayOptions(token, hintTerms()))
        relay = client
        eventsJob = scope.launch { client.events.collect(::onRelayEvent) }
        client.connect()
        return client
    }

    /**
     * Decodes the whole file, feeding the encoder and the relay as it goes.
     *
     * @return the decoded duration in ms (0 when the decoder did not say), or
     *   null when the import failed and [state] already says why.
     */
    private suspend fun decodeAndStream(
        encoder: OggOpusEncoder,
        client: SttRelayClient,
        range: DecodeRange?,
    ): Long? {
        var decodedMs = 0L
        try {
            AudioFileDecoder.decodeWithProgress(context, uri, range = range).collect { event ->
                when (event) {
                    is DecodeEvent.Started -> {
                        if (event.info.durationMs >= 0) durationMs = event.info.durationMs
                        publishRunning()
                    }

                    is DecodeEvent.Chunk -> {
                        // Stop decoding the moment the relay says no amount of
                        // audio will be transcribed — see [ImportRelayOutcome].
                        failIfRelayFatal()
                        encoder.append(event.pcm)
                        client.sendPcm(event.pcm)
                        decodeProgress = event.progress
                        publishRunning()
                    }

                    is DecodeEvent.Completed -> {
                        // What we actually produced is authoritative, not the
                        // container's claim.
                        decodedMs = event.decodedDurationUs / 1000
                        decodeProgress = 1f
                        publishRunning()
                    }
                }
            }
        } catch (e: AudioDecodeException) {
            return abandonWith(decodeFailure(e), e.message)
        } catch (e: OpusEncodeException) {
            return abandonWith(ImportFailure.ENCODER_UNAVAILABLE, e.message)
        } catch (e: RelayFatalException) {
            return abandonWith(e.verdict.failure, e.verdict.detail)
        }
        return decodedMs
    }

    /** Tears the run down and reports [reason]; always null, for `return`. */
    private fun abandonWith(reason: ImportFailure, detail: String?): Long? {
        abandon()
        fail(reason, detail)
        return null
    }

    /**
     * Sends `end` and waits for the relay to flush what it still holds.
     *
     * @return false when the relay ended the import meanwhile and [state]
     *   already says why.
     */
    private suspend fun drainRelayTail(client: SttRelayClient): Boolean {
        finishSent = true
        runCatching { client.finish() }
        val tailArrived = withTimeoutOrNull(TAIL_TIMEOUT_MS) { eventsJob?.join(); true } ?: false
        client.cancel()
        eventsJob?.cancel()
        if (!tailArrived) {
            // The relay never finished flushing: whatever it was still holding
            // is missing from the transcript.
            noteRelay(ImportRelayVerdict.Degraded("relay tail timed out"))
        }
        // The quota can run out, or the session die, while the tail drains.
        val fatal = relayVerdict as? ImportRelayVerdict.Fatal ?: return true
        abandonWith(fatal.failure, fatal.detail)
        return false
    }

    /**
     * Queues the recording, tries to upload it now, and reports how that went.
     *
     * @return the outcome, or null when it failed and [state] already says why.
     */
    private suspend fun uploadAndFinish(
        audio: File,
        decodedMs: Long,
        recordingTitle: String,
    ): ImportState.Finished? {
        val segments = finalSegments()
        val transcript = transcriptOutcome(segments, decodedMs, recordingTitle)
        (relayVerdict as? ImportRelayVerdict.Degraded)?.let {
            Log.w(TAG, "relay stopped short (${it.detail}); transcript=$transcript")
        }

        _state.value = ImportState.Uploading
        // An unreadable setting is the personal root, as in the uploader.
        val destination = defaultDestination?.let { read ->
            try {
                read()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Throwable) {
                SaveDestination.PERSONAL_ROOT
            }
        }
        val id = try {
            uploader.enqueue(
                EnqueueRequest(
                    audio = audio,
                    title = recordingTitle,
                    durationMs = decodedMs.toDouble(),
                    segments = segments,
                    source = RecordingSource.UPLOAD,
                    destination = destination,
                )
            ) ?: return failNull(ImportFailure.UPLOAD_FAILED) // only LIVE captures are ever dropped for length
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            return failNull(ImportFailure.UPLOAD_FAILED, e.message)
        }
        val result = runCatching { uploader.drain() }.getOrNull()
        // A refusal parks the recording on the phone; it is never dropped, so
        // this is a saved-but-not-uploaded outcome, not a failure — and
        // "import it again" would only make a duplicate.
        val outcome = UploadOutcome.of(id, result)
        // A short transcript was just handed to the backfill queue by that
        // drain (or will be, by whichever drain finally uploads it). Start the
        // queue now instead of leaving it for the next launch.
        drainBackfills()
        val pending = outcome.pending
        // Imports name a recording after its file, which is the worst title of
        // all; the pass is what gives it an honest one. Only once the cloud has
        // the recording (the pass reads and writes its meta there), only in the
        // personal library (an org copy cannot be renamed or re-filed from
        // here), and only with words to read.
        if (!pending && destination?.isOrg != true && segments.isNotEmpty()) runFilingPass(id)
        return ImportState.Finished(
            recordingId = id,
            pendingUpload = pending,
            transcript = transcript,
            // A 402 keeps the recording queued (see MeetingUploader.dispositionOf);
            // say it waits for the quota, not for a network that is fine.
            waitingForQuota = pending && result?.quotaExhausted == true,
            sharedToOrgId = destination?.orgId,
            uploadRefused = outcome.refused,
        )
    }

    /**
     * The same coverage question the uploader asks before it decides whether to
     * queue a backfill, asked here so the screen can say what is about to happen.
     */
    private fun transcriptOutcome(
        segments: List<TranscriptSegmentDto>,
        durationMs: Long,
        recordingTitle: String,
    ): ImportTranscript {
        val coverage = TranscriptBackfiller.coverage(
            PendingUpload(
                id = "",
                title = recordingTitle,
                source = RecordingSource.UPLOAD,
                startedAtMs = 0L,
                durationMs = durationMs.toDouble(),
                segments = segments,
            )
        )
        return ImportRelayOutcome.transcript(relayVerdict, coverage)
    }

    /** Both the event collector and [runImport] report here, hence the lock. */
    @Synchronized
    private fun noteRelay(verdict: ImportRelayVerdict) {
        relayVerdict = ImportRelayOutcome.merge(relayVerdict, verdict)
    }

    private fun failIfRelayFatal() {
        val fatal = relayVerdict as? ImportRelayVerdict.Fatal ?: return
        throw RelayFatalException(fatal)
    }

    /** Unwinds the decode loop when the relay has ended the import. */
    private class RelayFatalException(val verdict: ImportRelayVerdict.Fatal) :
        RuntimeException(verdict.detail)

    private fun publishRunning() {
        _state.value = ImportState.Running(
            decodeProgress = decodeProgress,
            transcribedMs = transcribedMs,
            durationMs = durationMs,
        )
    }

    private fun onRelayEvent(event: SttRelayEvent) {
        when (event) {
            is SttRelayEvent.Segment -> {
                upsert(event.segment)
                if (event.segment.endMs > transcribedMs) transcribedMs = event.segment.endMs
                if (_state.value is ImportState.Running) publishRunning()
            }
            // Terminal events: remembered, and acted on by the decode loop and
            // the tail of [runImport] — never silently dropped.
            is SttRelayEvent.QuotaExceeded, is SttRelayEvent.Error, is SttRelayEvent.Closed -> {
                val verdict = ImportRelayOutcome.classify(event, finishSent)
                if (verdict != ImportRelayVerdict.Healthy) Log.w(TAG, "relay: $event")
                noteRelay(verdict)
            }
        }
    }

    private fun upsert(segment: TranscriptSegment) {
        if (segment.text.isEmpty()) {
            byId.remove(segment.id) ?: return
        } else {
            byId[segment.id] = segment
        }
        _segments.value = byId.values.toList()
    }

    /** Abort the import and delete everything it produced. Idempotent. */
    fun cancel() {
        val wasRunning = _state.value.let {
            it is ImportState.Preparing || it is ImportState.Running
        }
        abandon()
        runJob?.cancel()
        scope.coroutineContext[Job]?.cancel()
        if (wasRunning) _state.value = ImportState.Cancelled
    }

    private fun abandon() {
        eventsJob?.cancel()
        runCatching { relay?.cancel() }
        runCatching { encoder?.cancel() }
    }

    private fun finalSegments(): List<TranscriptSegmentDto> =
        byId.values
            .filter { it.isFinal && !it.id.endsWith(MeetingUploader.TAIL_SUFFIX) }
            .map {
                TranscriptSegmentDto(
                    id = it.id,
                    source = it.source,
                    speaker = it.speaker,
                    text = it.text,
                    isFinal = true,
                    startMs = it.startMs,
                    endMs = it.endMs,
                )
            }

    private fun newAudioFile(): File {
        val dir = File(context.cacheDir, RECORDINGS_DIR).apply { mkdirs() }
        return File(dir, "import-${System.currentTimeMillis()}.ogg")
    }

    private fun decodeFailure(e: AudioDecodeException): ImportFailure = when (e) {
        is AudioDecodeException.SourceUnreadable -> ImportFailure.UNREADABLE
        is AudioDecodeException.NoAudioTrack -> ImportFailure.NO_AUDIO_TRACK
        is AudioDecodeException.UnsupportedCodec -> ImportFailure.UNSUPPORTED_CODEC
        is AudioDecodeException.DecodeFailed -> ImportFailure.DECODE_FAILED
    }

    private companion object {
        const val RECORDINGS_DIR = "recordings"
        const val TAIL_TIMEOUT_MS = 15_000L
    }
}

/** The slice of the file one part decodes. The last part runs to the end of the stream. */
internal fun ImportPart.decodeRange(): DecodeRange = DecodeRange(
    startUs = startMs * 1000,
    endUs = if (isLast) null else endMs * 1000,
)

/**
 * The relay options an import opens with. An imported meeting is still a
 * meeting: same billing bucket as live capture, which is what the relay meters
 * by forwarded bytes — and the same personal-dictionary hints, as iOS
 * `RecordingImporter` passes the batch job its terms.
 */
internal fun importRelayOptions(token: String, hintTerms: List<String>): SttRelayClient.Options =
    SttRelayClient.Options(
        bearerToken = token,
        feature = SttRelayClient.Feature.MEETING,
        hintTerms = hintTerms,
    )
