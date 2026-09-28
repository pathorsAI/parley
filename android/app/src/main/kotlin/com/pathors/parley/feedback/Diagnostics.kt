package com.pathors.parley.feedback

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * What a report says about the recording it is about — the `context` block of
 * the diagnostics. Every field is optional and an absent one is left out of the
 * JSON rather than sent as null or zero: "we do not know" and "it was zero" are
 * different answers, and the admin view shows only what is there.
 *
 * Shape only, never content: the transcript is described by how many segments
 * it has and where the last one ends, not by a word of what it says.
 */
data class RecordingContext(
    val recordingId: String? = null,
    val recordingDurationMs: Long? = null,
    val transcriptSegments: Int? = null,
    val lastSegmentEndMs: Long? = null,
    /** `builtInMic` `bluetoothA2DP` `bluetoothHFP` `wired` `usb` `other` — see [AudioRouteLabel]. */
    val audioRoute: String? = null,
    val micRecoveries: Int? = null,
)

/**
 * Everything a report's `diagnostics` is built from, gathered by
 * [DiagnosticsCollector] on the device and turned into JSON by
 * [DiagnosticsBuilder] — split so the JSON shape, the size limit and what is
 * left out for a crash are testable without a phone.
 */
data class DiagnosticsInput(
    val appVersion: String,
    val appBuild: String,
    val osVersion: String,
    val sdkInt: Int,
    val deviceModel: String,
    val locale: String? = null,
    val timezone: String? = null,
    val recording: RecordingContext? = null,
    /** `granted` / `denied` — see [DiagnosticsCollector] for why never `undetermined`. */
    val micPermission: String? = null,
    val syncPendingCount: Int? = null,
    val syncLastError: String? = null,
    val signedIn: Boolean? = null,
    val log: List<LogRing.Entry> = emptyList(),
    /** Only for a [FeedbackTrigger.CRASH] report — see [DiagnosticsBuilder.forCrash]. */
    val crash: JsonObject? = null,
)

/**
 * The `diagnostics` JSON of spec §5, identical in shape on iOS and Android.
 *
 * Two budgets are enforced here, not left to the server's 413: the log is cut
 * to [LOG_MAX_BYTES], and the whole object to [MAX_BYTES] by trimming the log
 * further (JSON escaping makes a 50 KB log larger than 50 KB once it is a
 * string). A report the cloud refuses for size is a report that is dropped
 * from the queue and never read.
 */
object DiagnosticsBuilder {

    /** The cloud refuses a serialized `diagnostics` above 96 KB. A little headroom under it. */
    const val MAX_BYTES = 94 * 1024

    /** The log's own budget: 50 KB, per the spec. */
    const val LOG_MAX_BYTES = 50 * 1024

    /** A crash's own budget: 48 KB, per the spec. */
    const val CRASH_TRACE_MAX_BYTES = 48 * 1024

    /** How many recent warnings and errors are listed on their own. */
    const val RECENT_ERRORS = 20

    private const val RECENT_ERROR_MESSAGE_CHARS = 300

    /** A report somebody chose to send: everything in [input]. */
    fun build(input: DiagnosticsInput): JsonObject {
        var logBudget = LOG_MAX_BYTES
        while (true) {
            val json = assemble(input, logBudget)
            if (utf8Size(json) <= MAX_BYTES || logBudget == 0) return json
            logBudget = (logBudget / 2).takeIf { it >= 1024 } ?: 0
        }
    }

    /**
     * A crash report, which goes out automatically by default — so it carries
     * exactly what the settings footnote promises and nothing more: the app
     * version, the device (and the OS it runs, without which a crash location
     * cannot be read), and where it crashed. No log, no recording, no account
     * state. The crash block itself is the one field only this report has.
     */
    fun forCrash(input: DiagnosticsInput): JsonObject = buildJsonObject {
        putApp(input)
        putOs(input)
        put("device", buildJsonObject { put("model", input.deviceModel) })
        input.crash?.let { put("crash", it) }
    }

    private fun assemble(input: DiagnosticsInput, logBudget: Int): JsonObject =
        buildJsonObject {
            putApp(input)
            putOs(input)
            put(
                "device",
                buildJsonObject {
                    put("model", input.deviceModel)
                    input.locale?.let { put("locale", it) }
                    input.timezone?.let { put("timezone", it) }
                },
            )
            contextOf(input)?.let { put("context", it) }
            val errors = input.log.filter { it.isProblem }.takeLast(RECENT_ERRORS)
            if (errors.isNotEmpty()) {
                put(
                    "recentErrors",
                    buildJsonArray {
                        errors.forEach { entry ->
                            addJsonObject {
                                put("at", entry.atMs)
                                put("code", codeOf(entry))
                                put("message", (entry.error?.let { "${entry.message} — $it" } ?: entry.message).take(RECENT_ERROR_MESSAGE_CHARS))
                            }
                        }
                    },
                )
            }
            if (logBudget > 0 && input.log.isNotEmpty()) {
                put("log", LogRing.render(input.log, logBudget))
            }
            input.crash?.let { put("crash", it) }
        }

    private fun JsonObjectBuilder.putApp(input: DiagnosticsInput) {
        put(
            "app",
            buildJsonObject {
                put("version", input.appVersion)
                put("build", input.appBuild)
            },
        )
    }

    /**
     * `name` and `version` as the shared shape has them; `sdk` is an Android
     * addition — two phones on "14" can be on different API levels after a
     * QPR, and the API level is what the platform's behaviour hangs on.
     */
    private fun JsonObjectBuilder.putOs(input: DiagnosticsInput) {
        put(
            "os",
            buildJsonObject {
                put("name", "Android")
                put("version", input.osVersion)
                put("sdk", input.sdkInt)
            },
        )
    }

    private fun contextOf(input: DiagnosticsInput): JsonObject? {
        val fields = buildMap<String, JsonElement> {
            input.recording?.let { recording ->
                recording.recordingId?.let { put("recordingId", JsonPrimitive(it)) }
                recording.recordingDurationMs?.let { put("recordingDurationMs", JsonPrimitive(it)) }
                recording.transcriptSegments?.let { put("transcriptSegments", JsonPrimitive(it)) }
                recording.lastSegmentEndMs?.let { put("lastSegmentEndMs", JsonPrimitive(it)) }
                recording.audioRoute?.let { put("audioRoute", JsonPrimitive(it)) }
                recording.micRecoveries?.let { put("micRecoveries", JsonPrimitive(it)) }
            }
            input.micPermission?.let { put("micPermission", JsonPrimitive(it)) }
            input.syncPendingCount?.let { put("syncPendingCount", JsonPrimitive(it)) }
            input.syncLastError?.let { put("syncLastError", JsonPrimitive(it)) }
            input.signedIn?.let { put("signedIn", JsonPrimitive(it)) }
        }
        return if (fields.isEmpty()) null else JsonObject(fields)
    }

    /**
     * A short machine-ish code for a logged problem: the tag, and the
     * exception's class when one was logged — `MeetingSession`,
     * `MeetingUploader:SocketTimeoutException`. What the admin view groups by.
     */
    private fun codeOf(entry: LogRing.Entry): String {
        val errorClass = entry.error?.substringBefore(':')?.takeIf { it.isNotBlank() }
        return if (errorClass != null) "${entry.tag}:$errorClass" else entry.tag
    }

    fun utf8Size(json: JsonElement): Int = json.toString().toByteArray(Charsets.UTF_8).size

    /** Cut [text] to at most [maxBytes] of UTF-8 without splitting a character. */
    fun truncateUtf8(text: String, maxBytes: Int): String {
        val bytes = text.toByteArray(Charsets.UTF_8)
        if (bytes.size <= maxBytes) return text
        var end = maxBytes
        // Back off continuation bytes (10xxxxxx) so the cut lands on a boundary.
        while (end > 0 && (bytes[end].toInt() and 0xC0) == 0x80) end--
        return String(bytes, 0, end, Charsets.UTF_8)
    }
}
