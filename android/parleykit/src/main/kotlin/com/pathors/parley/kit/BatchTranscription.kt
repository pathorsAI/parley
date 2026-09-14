package com.pathors.parley.kit

import java.io.File
import kotlinx.coroutines.delay
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.descriptors.element
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull

/**
 * Hosted batch transcription through Parley Cloud (`POST /stt/batch`).
 *
 * The desktop already walks this endpoint in `src-tauri/src/replay.rs`
 * (`parley_batch`) and iOS in `ParleyKit/BatchTranscription.swift`; this is the
 * same four steps in Kotlin — upload, poll, fetch, delete — so the same file
 * transcribes identically on Android, on the phone and on the Mac. Where the
 * three could drift the Rust is the reference: the token grouping below is a
 * line-for-line port of `group_tokens`, and the poll cadence and cap are the
 * same numbers.
 *
 * Two deliberate deviations from the Swift:
 *
 * - The audio travels as a [File], not as a byte array. iOS reads the whole Ogg
 *   into `Data`; an hour of meeting is tens of megabytes and Android has no
 *   reason to hold it in the heap when OkHttp will stream a file body straight
 *   off disk.
 * - The user-facing wording for a failed request is **not** here. iOS can reach
 *   a localized bundle from its kit; this module has no resources, so the
 *   classification lives in `cloud/BatchTranscriptionFailure.kt` in the app and
 *   the copy lives in both `strings.xml` files, which is where every other
 *   Android string in this app lives.
 */

// ── wire shapes ──────────────────────────────────────────────────────────────

/**
 * One token from the cloud transcript.
 *
 * The decoding is permissive on purpose: the upstream vendor omits `speaker` on
 * control and spacing tokens, and sends it as a string in some responses and a
 * number in others (see `SpeakerId` in `replay.rs`), so a token that decoded
 * strictly would decode nothing at all.
 */
@Serializable(with = BatchTokenSerializer::class)
data class BatchToken(
    val text: String,
    val startMs: Long,
    val endMs: Long,
    /**
     * `null` means the token carried no speaker — which is not the same as
     * speaker 0. [groupBatchTokens] keeps such tokens in the current run.
     */
    val speaker: Int?,
)

/**
 * Hand-written because kotlinx.serialization cannot express "this field is an
 * Int, or a String holding an Int, or absent, and the difference between the
 * last one and zero matters".
 */
internal object BatchTokenSerializer : KSerializer<BatchToken> {

    override val descriptor: SerialDescriptor =
        buildClassSerialDescriptor("com.pathors.parley.kit.BatchToken") {
            element<String>("text")
            element<Long>("startMs")
            element<Long>("endMs")
            element<Int>("speaker", isOptional = true)
        }

    override fun deserialize(decoder: Decoder): BatchToken {
        val input = requireNotNull(decoder as? JsonDecoder) {
            "BatchToken is only ever decoded from JSON"
        }
        val obj = input.decodeJsonElement() as? JsonObject ?: JsonObject(emptyMap())
        return BatchToken(
            text = (obj["text"] as? JsonPrimitive)?.takeIf { it.isString }?.content.orEmpty(),
            startMs = obj.millis("startMs"),
            endMs = obj.millis("endMs"),
            speaker = obj.speaker(),
        )
    }

    override fun serialize(encoder: Encoder, value: BatchToken) {
        val output = requireNotNull(encoder as? JsonEncoder) {
            "BatchToken is only ever encoded to JSON"
        }
        output.encodeJsonElement(
            buildJsonObject {
                put("text", JsonPrimitive(value.text))
                put("startMs", JsonPrimitive(value.startMs))
                put("endMs", JsonPrimitive(value.endMs))
                value.speaker?.let { put("speaker", JsonPrimitive(it)) }
            }
        )
    }

    /**
     * A timestamp the provider may write as an integer or as a fractional
     * number of milliseconds. Anything that is not a number at all reads as 0
     * rather than failing the whole response — one unparseable token must not
     * cost the transcript it is in.
     */
    private fun JsonObject.millis(key: String): Long {
        val primitive = this[key] as? JsonPrimitive ?: return 0
        if (primitive.isString) return 0
        return primitive.doubleOrNull?.toLong() ?: 0
    }

    private fun JsonObject.speaker(): Int? {
        val element = this["speaker"]
        if (element == null || element is JsonNull) return null
        val primitive = element as? JsonPrimitive ?: return null
        // A string speaker that is not a number is treated as 0, matching the
        // Rust's `parse().unwrap_or(0)` — an unparseable label still means
        // "somebody spoke", so dropping the token would lose words.
        if (primitive.isString) return primitive.content.trim().toIntOrNull() ?: 0
        return primitive.intOrNull ?: primitive.doubleOrNull?.toInt()
    }
}

/** `GET /stt/batch/{id}/transcript`. */
@Serializable
data class BatchTranscriptResponse(
    val tokens: List<BatchToken> = emptyList(),
)

/**
 * A job's state as the cloud reports it. [status] is left as the raw string
 * rather than an enum: the cloud normalizes several upstream vocabularies into
 * `queued` / `processing` / `completed` / `error`, and a value we don't know yet
 * has to read as "still working", not as a decode failure.
 *
 * [durationMs] is a `Double?` rather than a `Long?` for the same tolerance: the
 * field is milliseconds and every known server writes an integer, but a
 * fractional one must not throw a whole transcription away.
 */
@Serializable
data class BatchJobStatus(
    val status: String,
    val errorMessage: String? = null,
    val durationMs: Double? = null,
) {
    /** The reported length in whole milliseconds, never negative. */
    val durationMsOrZero: Long get() = durationMs?.coerceAtLeast(0.0)?.toLong() ?: 0L
}

// ── the service ──────────────────────────────────────────────────────────────

/**
 * The four calls [BatchTranscriber] needs. `CloudClient` implements it; tests
 * use a fake. Splitting them out keeps the polling loop testable without a
 * network — `:parleykit` cannot see OkHttp's mock server and does not want to.
 */
interface BatchTranscriptionService {

    suspend fun startBatchJob(
        audio: File,
        diarization: Boolean,
        languageHints: List<String>,
    ): String

    suspend fun batchJobStatus(id: String): BatchJobStatus

    suspend fun batchTranscript(id: String): BatchTranscriptResponse

    /**
     * Best effort, and deliberately not declared to throw: by the time this runs
     * the transcript is already in hand, so a failed cleanup must not fail the
     * transcription.
     */
    suspend fun deleteBatchJob(id: String)
}

// ── errors ───────────────────────────────────────────────────────────────────

/**
 * Failures that belong to the job rather than to the HTTP call. Transport and
 * status-code failures still surface as the app's `CloudException`; see
 * `BatchTranscriptionFailure` for how those are turned into wording a user can
 * act on.
 *
 * The messages here are diagnostics, not display copy — this module has no
 * string resources, and Parley does not ship English-only text to users.
 */
sealed class BatchTranscriptionException(message: String) : Exception(message) {

    /** The cloud reported `status: "error"`; [reason] is its `errorMessage`. */
    class JobFailed(val reason: String) :
        BatchTranscriptionException("batch transcription failed: $reason")

    /** The poll cap was exhausted with the job still unsettled. */
    class TimedOut(val polls: Int) :
        BatchTranscriptionException("batch transcription did not settle after $polls polls")

    companion object {
        /** What a job that errored without saying why is recorded as. */
        const val UNKNOWN_REASON = "unknown error"
    }
}

// ── grouping ─────────────────────────────────────────────────────────────────

/**
 * Group a flat token stream into speaker runs. A change of speaker closes the
 * current run and starts a new one; whitespace is preserved as the provider
 * supplies it. Empty / whitespace-only runs are dropped.
 *
 * Port of `group_tokens` in `src-tauri/src/replay.rs` — behaviour must match it
 * exactly, or the same file transcribed on Android and on the Mac would come
 * back split into different speakers.
 */
fun groupBatchTokens(tokens: List<BatchToken>, source: String): List<TranscriptSegment> {
    val segments = mutableListOf<TranscriptSegment>()
    var segIndex = 0

    // -1 is "no run open yet", which is why this is signed and the trailing
    // emit clamps it back to 0.
    var curSpeaker = -1
    var curText = StringBuilder()
    var curStart = 0L
    var curEnd = 0L

    for (token in tokens) {
        // Skip control / endpoint markers that some models emit.
        if (token.text == "<end>" || token.text == "<fin>") continue

        // Tokens without a speaker (e.g. some punctuation/spacing tokens) should
        // stay in the CURRENT speaker's run — snapping them to speaker 0 would
        // close the run and fragment the transcript into spurious extra speakers.
        val speaker = token.speaker ?: if (curSpeaker >= 0) curSpeaker else 0

        if (curSpeaker == -1) {
            curSpeaker = speaker
            curStart = token.startMs
        } else if (speaker != curSpeaker) {
            if (curText.isNotBlank()) {
                segments += TranscriptSegment(
                    id = "$source-$segIndex",
                    source = source,
                    speaker = curSpeaker,
                    text = curText.toString(),
                    isFinal = true,
                    startMs = curStart,
                    endMs = curEnd,
                )
                segIndex++
            }
            curSpeaker = speaker
            curText = StringBuilder()
            curStart = token.startMs
        }
        curText.append(token.text)
        curEnd = token.endMs
    }

    if (curText.isNotBlank()) {
        segments += TranscriptSegment(
            id = "$source-$segIndex",
            source = source,
            speaker = maxOf(curSpeaker, 0),
            text = curText.toString(),
            isFinal = true,
            startMs = curStart,
            endMs = curEnd,
        )
    }

    return segments
}

// ── the transcriber ──────────────────────────────────────────────────────────

data class BatchTranscriptionResult(
    val segments: List<TranscriptSegment>,
    val durationMs: Long,
)

/**
 * Drives one hosted transcription from a file on disk to grouped segments.
 *
 * The cadence — sleep first, then poll, 1500 ms apart, at most 800 times — is
 * the desktop's, which puts the ceiling a little over 20 minutes of waiting.
 */
class BatchTranscriber(
    private val service: BatchTranscriptionService,
    private val pollIntervalMs: Long = DEFAULT_POLL_INTERVAL_MS,
    private val maxPolls: Int = DEFAULT_MAX_POLLS,
) {

    /** Upload → poll → fetch → group → best-effort delete. */
    suspend fun transcribe(
        audio: File,
        diarization: Boolean = true,
        languageHints: List<String> = emptyList(),
    ): BatchTranscriptionResult {
        val jobId = service.startBatchJob(audio, diarization, languageHints)

        // The cloud normalizes upstream states into the four handled here, so a
        // status we don't recognize is treated as "still working" rather than a
        // hard failure.
        var reportedDurationMs: Long? = null
        for (poll in 0 until maxPolls) {
            delay(pollIntervalMs)
            val job = service.batchJobStatus(jobId)
            if (job.status == STATUS_COMPLETED) {
                reportedDurationMs = job.durationMsOrZero
                break
            }
            if (job.status == STATUS_ERROR) {
                throw BatchTranscriptionException.JobFailed(
                    job.errorMessage?.takeIf { it.isNotEmpty() }
                        ?: BatchTranscriptionException.UNKNOWN_REASON
                )
            }
        }
        val audioDurationMs = reportedDurationMs
            ?: throw BatchTranscriptionException.TimedOut(maxPolls)

        val transcript = service.batchTranscript(jobId)

        // Fire and forget so the cloud isn't left holding the audio.
        service.deleteBatchJob(jobId)

        val segments = groupBatchTokens(transcript.tokens, SOURCE)
        // The job's own duration can undershoot the transcript (a trailing token
        // may end past it) and can be absent entirely, so take whichever is
        // longer — the same reconciliation the Rust does.
        val durationMs = maxOf(segments.maxOfOrNull { it.endMs } ?: 0L, audioDurationMs)

        return BatchTranscriptionResult(segments = segments, durationMs = durationMs)
    }

    companion object {
        /**
         * A phone records one mixed stream, so every segment it produces carries
         * this source (see the doc comment on [TranscriptSegment]).
         */
        const val SOURCE = "mix"

        const val DEFAULT_POLL_INTERVAL_MS = 1_500L
        const val DEFAULT_MAX_POLLS = 800

        private const val STATUS_COMPLETED = "completed"
        private const val STATUS_ERROR = "error"
    }
}
