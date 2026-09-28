package com.pathors.parley.feedback

import com.pathors.parley.cloud.CloudException
import com.pathors.parley.cloud.CloudJson
import com.pathors.parley.util.deleteQuietly
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.asRequestBody

/**
 * One report as the cloud receives it — the `payload` part of `POST /feedback`
 * (spec §3). Built once, when the report is made, and stored as-is: a report
 * that waits a day in the queue still says what the phone looked like when it
 * was made, not when the network came back.
 */
data class FeedbackPayload(
    /** Client-minted and stable across retries; the cloud dedupes on it. */
    val id: String,
    val trigger: FeedbackTrigger,
    val recordingId: String? = null,
    val message: String? = null,
    val tags: List<String> = emptyList(),
    val diagnostics: JsonObject,
) {
    /** Absent fields are left out, not sent as null — the spec's "optional". */
    fun toJson(): JsonObject = JsonObject(
        buildMap {
            put("id", JsonPrimitive(id))
            put("trigger", JsonPrimitive(trigger.wire))
            recordingId?.let { put("recordingId", JsonPrimitive(it)) }
            message?.takeIf { it.isNotBlank() }?.let { put("message", JsonPrimitive(it.take(MAX_MESSAGE_CHARS))) }
            put("tags", JsonArray(tags.take(MAX_TAGS).map { JsonPrimitive(it.take(MAX_TAG_CHARS)) }))
            put("diagnostics", diagnostics)
        },
    )

    companion object {
        /** The cloud truncates past these; cutting here keeps what is sent what is stored. */
        const val MAX_MESSAGE_CHARS = 2000
        const val MAX_TAGS = 8
        const val MAX_TAG_CHARS = 32
    }
}

/**
 * The `multipart/form-data` body of `POST /feedback`: a `payload` field holding
 * the JSON as a string, and — only when there is one — a `screenshot` file
 * part of `image/jpeg`.
 */
object FeedbackMultipart {
    const val PAYLOAD_FIELD = "payload"
    const val SCREENSHOT_FIELD = "screenshot"
    const val SCREENSHOT_FILE_NAME = "screenshot.jpg"
    val JPEG = "image/jpeg".toMediaType()

    fun build(payloadJson: String, screenshot: File?): RequestBody =
        MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart(PAYLOAD_FIELD, payloadJson)
            .apply {
                if (screenshot != null && screenshot.isFile && screenshot.length() > 0L) {
                    addFormDataPart(SCREENSHOT_FIELD, SCREENSHOT_FILE_NAME, screenshot.asRequestBody(JPEG))
                }
            }
            .build()
}

/** A report's manifest in the queue: the payload, and when it was made. */
@Serializable
data class QueuedReport(
    val id: String,
    val queuedAtMs: Long,
    val payload: JsonObject,
)

/**
 * Reports that have not reached the cloud yet: `filesDir/FeedbackQueue/{id}.json`
 * plus `{id}.jpg` when there is a screenshot.
 *
 * Written before the first attempt and removed only once the cloud has said
 * yes, so a report made offline, or in the second before the process died, is
 * sent on a later launch instead of being lost. Idempotent by id both ways:
 * enqueuing an id that is already here replaces it, and the cloud answers a
 * resent id with 200 without storing it twice — so "did the last attempt
 * land?" never has to be known.
 *
 * Bounded at [MAX_REPORTS]; past that the oldest goes. A phone that has been
 * offline long enough to pile up twenty reports gains nothing from the
 * twenty-first old one, and a queue that grew without bound would be the app
 * filling somebody's storage with its own complaints.
 *
 * Blocking file I/O except [flush]; callers dispatch.
 */
class FeedbackQueue(
    private val directory: File,
    /** Where a report dropped for good is noted. A parameter so JVM tests need no `android.util.Log`. */
    private val onDropped: (id: String, error: Throwable) -> Unit = { id, error ->
        Log.w(TAG, "feedback $id refused for good: ${error.message}")
    },
) {

    private val flushLock = Mutex()

    fun manifestFile(id: String) = File(directory, "$id.json")

    fun screenshotFile(id: String) = File(directory, "$id.jpg")

    /**
     * Keep [payload] (and its [screenshot], which is **moved** in) until it is
     * sent. Manifest last and atomically, so a crash in between leaves at worst
     * an orphan image — never a manifest promising a screenshot that is not
     * there.
     */
    fun enqueue(payload: FeedbackPayload, screenshot: File? = null, nowMs: Long = System.currentTimeMillis()) {
        directory.mkdirs()
        val image = screenshotFile(payload.id)
        if (screenshot != null && screenshot.isFile && screenshot.absolutePath != image.absolutePath) {
            if (!screenshot.renameTo(image)) {
                screenshot.copyTo(image, overwrite = true)
                screenshot.deleteQuietly()
            }
        }
        val report = QueuedReport(id = payload.id, queuedAtMs = nowMs, payload = payload.toJson())
        val target = manifestFile(payload.id)
        val temp = File(directory, "${payload.id}.json.tmp")
        temp.writeText(CloudJson.encodeToString(QueuedReport.serializer(), report))
        if (!temp.renameTo(target)) {
            temp.copyTo(target, overwrite = true)
            temp.deleteQuietly()
        }
        trim()
    }

    /** Everything waiting, oldest first. Unreadable manifests are dropped, not retried. */
    fun list(): List<QueuedReport> =
        (directory.listFiles { file -> file.isFile && file.name.endsWith(".json") } ?: emptyArray())
            .mapNotNull { file ->
                runCatching { CloudJson.decodeFromString(QueuedReport.serializer(), file.readText()) }
                    .getOrElse {
                        file.deleteQuietly()
                        null
                    }
            }
            .sortedBy { it.queuedAtMs }

    fun count(): Int = directory.listFiles { file -> file.isFile && file.name.endsWith(".json") }?.size ?: 0

    fun remove(id: String) {
        manifestFile(id).deleteQuietly()
        screenshotFile(id).deleteQuietly()
    }

    private fun trim() {
        val all = list()
        if (all.size <= MAX_REPORTS) return
        all.take(all.size - MAX_REPORTS).forEach { remove(it.id) }
    }

    /** What one [flush] did. */
    data class FlushResult(val sent: Int, val dropped: Int, val remaining: Int)

    /**
     * Send everything waiting, oldest first, through [submit] (which throws on
     * failure). Serialized — a launch drain and a network-return drain racing
     * would otherwise send one report twice (harmless, the cloud dedupes, but
     * pointless).
     *
     * A refusal the cloud will repeat forever (400, 413 — a malformed or
     * oversized report) drops that report and carries on. Anything a later
     * attempt can get past — no network, a 5xx, 429 rate limiting — stops the
     * pass with the queue intact, because the next report would fail the same
     * way.
     */
    suspend fun flush(submit: suspend (payloadJson: String, screenshot: File?) -> Unit): FlushResult =
        flushLock.withLock {
            var sent = 0
            var dropped = 0
            for (report in list()) {
                val image = screenshotFile(report.id).takeIf { it.isFile }
                val outcome = try {
                    submit(report.payload.toString(), image)
                    null
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Throwable) {
                    e
                }
                when {
                    outcome == null -> {
                        remove(report.id)
                        sent++
                    }
                    isPermanent(outcome) -> {
                        onDropped(report.id, outcome)
                        remove(report.id)
                        dropped++
                    }
                    else -> break
                }
            }
            FlushResult(sent = sent, dropped = dropped, remaining = count())
        }

    companion object {
        const val DIRECTORY_NAME = "FeedbackQueue"
        const val MAX_REPORTS = 20
        private const val TAG = "FeedbackQueue"

        /** A 4xx that retrying cannot fix. 401 included: the cloud never sends one here on purpose. */
        fun isPermanent(error: Throwable): Boolean {
            val status = (error as? CloudException)?.status ?: return false
            return status in 400..499 && status != 408 && status != 425 && status != 429
        }
    }
}
