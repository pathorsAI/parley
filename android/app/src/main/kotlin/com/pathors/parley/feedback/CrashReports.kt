package com.pathors.parley.feedback

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import android.util.Base64
import androidx.annotation.RequiresApi
import com.pathors.parley.cloud.CloudJson
import com.pathors.parley.util.deleteQuietly
import java.io.File
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * A crash from a previous process, as the `crash` block of a report (spec §5).
 *
 * Two sources, because each sees what the other cannot:
 *
 * - **The uncaught-exception handler** ([UncaughtCrashRecorder]), on every API
 *   level. It runs *inside* the dying process, so it has the Java stack trace —
 *   the one thing that says where a Kotlin crash happened — and writes it to a
 *   file for the next launch to find.
 * - **`ApplicationExitInfo`** ([ExitReasonReader]), API 30+. The system's own
 *   record of why the process died, which also covers what no in-process handler
 *   can: a native crash and an ANR, where the process is killed rather than
 *   given the chance to report. Its trace is the ANR's thread dump, or (API 31+)
 *   the native tombstone.
 *
 * A Java crash shows up in both, so [CrashSelection] folds them together.
 */
data class PreviousCrash(
    /** When it happened, epoch ms. */
    val timestampMs: Long,
    /** The `crash` object, already shaped for the wire. */
    val block: JsonObject,
    /** The handler's file, deleted once this crash has been dealt with; null for an exit record. */
    val file: File? = null,
)

/** One `ApplicationExitInfo` the app cares about, stripped of the platform type. */
data class ExitRecord(
    /** `crash`, `crash_native` or `anr`. */
    val reason: String,
    val timestampMs: Long,
    val description: String?,
    val importance: Int,
    val trace: String? = null,
    /** How [trace] is encoded when it is not plain text — see [ExitReasonReader]. */
    val traceFormat: String? = null,
) {
    fun toBlock(): JsonObject = buildJsonObject {
        put("reason", reason)
        description?.let { put("description", LogScrubber.scrub(it)) }
        put("timestamp", timestampMs)
        put("importance", importance)
        trace?.let { put("trace", it) }
        traceFormat?.let { put("traceFormat", it) }
    }

    companion object {
        const val CRASH = "crash"
        const val CRASH_NATIVE = "crash_native"
        const val ANR = "anr"
    }
}

/**
 * Which previous crashes to report this launch, and the new exit-info
 * watermark — pure, so the de-duplication and the watermark are unit-tested.
 *
 * ## The watermark
 *
 * The system keeps a process's last few exit records across launches (and
 * across updates), so "every crash record" would report the same crash on every
 * launch until it aged out. Only records **newer than the newest one already
 * dealt with** count, and dealing with a batch moves the watermark to its
 * newest — including records that were skipped as duplicates.
 *
 * With no watermark yet — the first launch of a build that has this feature —
 * the history is *not* reported: those crashes happened under a build that
 * never said it would send them. The watermark starts at the newest record
 * already there.
 *
 * ## Duplicates
 *
 * A Java crash is written by the handler and then recorded by the system as
 * [ExitRecord.CRASH] a moment later. The handler's copy has the stack, the
 * system's has only a description, so an exit record within [SAME_CRASH_MS] of
 * a handler file is the same crash and is dropped.
 */
object CrashSelection {

    /** How far apart the handler's file and the system's record of one crash can be. */
    const val SAME_CRASH_MS = 60_000L

    /** At most this many crashes go out per launch — a crash loop is one problem, not twenty. */
    const val MAX_PER_LAUNCH = 3

    data class Selection(
        /** Newest last. */
        val crashes: List<PreviousCrash>,
        /** The watermark to store once [crashes] have been sent or declined. */
        val watermarkMs: Long?,
        /** Every handler file seen, reported or not; all of them are done with after this. */
        val handledFiles: List<File>,
    )

    fun select(
        uncaught: List<PreviousCrash>,
        exits: List<ExitRecord>,
        watermarkMs: Long?,
    ): Selection {
        val newestExit = exits.maxOfOrNull { it.timestampMs }
        val nextWatermark = listOfNotNull(watermarkMs, newestExit).maxOrNull()
        val fresh = if (watermarkMs == null) {
            emptyList()
        } else {
            exits.filter { it.timestampMs > watermarkMs }
        }
        val fromExits = fresh
            .filterNot { exit ->
                exit.reason == ExitRecord.CRASH &&
                    uncaught.any { kotlin.math.abs(exit.timestampMs - it.timestampMs) <= SAME_CRASH_MS }
            }
            .map { PreviousCrash(timestampMs = it.timestampMs, block = it.toBlock()) }
        val all = (uncaught + fromExits).sortedBy { it.timestampMs }.takeLast(MAX_PER_LAUNCH)
        return Selection(
            crashes = all,
            watermarkMs = nextWatermark,
            handledFiles = uncaught.mapNotNull { it.file },
        )
    }
}

/**
 * The uncaught-exception half: a default handler that writes the crash to
 * `filesDir/Feedback/crashes/` and then hands the throwable on to whatever
 * handler was there before — the platform's, which shows "Parley keeps
 * stopping" and kills the process. Chaining is the whole contract: this must
 * never be the reason a crash is swallowed and the app left running in a broken
 * state.
 *
 * The write is synchronous and small, on the crashing thread, because there is
 * no "later" for a process that is about to die. Everything in it is guarded:
 * a handler that threw would lose the original crash.
 */
class UncaughtCrashRecorder(private val directory: File) {

    fun install() {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            runCatching { write(thread.name, error, System.currentTimeMillis()) }
            if (previous != null) {
                previous.uncaughtException(thread, error)
            } else {
                // No platform handler (never the case on a device): end the
                // process the way the platform would, rather than leave it
                // running without the thread that just died.
                android.os.Process.killProcess(android.os.Process.myPid())
                kotlin.system.exitProcess(EXIT_CODE)
            }
        }
    }

    /** The crash as the `crash` block the spec asks for (all API levels). */
    fun write(threadName: String, error: Throwable, nowMs: Long) {
        directory.mkdirs()
        val block = blockFor(threadName, error, nowMs)
        File(directory, "$FILE_PREFIX$nowMs.json").writeText(block.toString())
    }

    /** Crashes written by earlier processes. Unreadable files are removed. */
    fun pending(): List<PreviousCrash> =
        (directory.listFiles { file -> file.isFile && file.name.startsWith(FILE_PREFIX) } ?: emptyArray())
            .mapNotNull { file ->
                val block = runCatching { CloudJson.parseToJsonElement(file.readText()) as? JsonObject }
                    .getOrNull()
                if (block == null) {
                    file.deleteQuietly()
                    return@mapNotNull null
                }
                val at = block["timestamp"]?.jsonPrimitive?.longOrNull ?: file.lastModified()
                PreviousCrash(timestampMs = at, block = block, file = file)
            }
            .sortedBy { it.timestampMs }

    companion object {
        const val FILE_PREFIX = "uncaught-"
        private const val EXIT_CODE = 10

        /**
         * `{reason, exception, stacktrace, thread, timestamp}`. The stack is cut
         * to the spec's 48 KB, and the exception line is scrubbed: exception
         * messages are where a URL with a token in it, or a file name, turns up.
         */
        fun blockFor(threadName: String, error: Throwable, nowMs: Long): JsonObject = buildJsonObject {
            put("reason", "uncaught_exception")
            put("exception", LogScrubber.scrub("${error.javaClass.name}: ${error.message.orEmpty()}").take(1_000))
            put(
                "stacktrace",
                DiagnosticsBuilder.truncateUtf8(
                    LogScrubber.scrub(error.stackTraceToString()),
                    DiagnosticsBuilder.CRASH_TRACE_MAX_BYTES,
                ),
            )
            put("thread", threadName)
            put("timestamp", nowMs)
        }
    }
}

/**
 * The `ApplicationExitInfo` half (API 30+): this app's recent deaths by crash,
 * native crash or ANR.
 *
 * The trace, when the system kept one, comes from `getTraceInputStream()`: an
 * ANR's is the text thread dump; a native crash's (API 31+) is the tombstone,
 * which is a **binary protobuf**. That is sent base64-encoded with
 * `traceFormat: "tombstone_proto_base64"` rather than as a string of mojibake
 * or not at all — decoded with the platform's `tombstone.proto`, it is the only
 * record of where native code died. Either is cut to 48 KB of the final string.
 */
object ExitReasonReader {

    /** How many of the system's records to look through (it keeps about 16). */
    private const val MAX_RECORDS = 16

    const val TOMBSTONE_FORMAT = "tombstone_proto_base64"

    fun read(context: Context): List<ExitRecord> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return emptyList()
        return runCatching { readFromSystem(context) }
            .onFailure { Log.w(TAG, "could not read exit reasons", it) }
            .getOrDefault(emptyList())
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun readFromSystem(context: Context): List<ExitRecord> {
        val manager = context.getSystemService(ActivityManager::class.java) ?: return emptyList()
        return manager.getHistoricalProcessExitReasons(context.packageName, 0, MAX_RECORDS)
            .mapNotNull { info -> recordOf(info) }
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun recordOf(info: ApplicationExitInfo): ExitRecord? {
        val reason = when (info.reason) {
            ApplicationExitInfo.REASON_CRASH -> ExitRecord.CRASH
            ApplicationExitInfo.REASON_CRASH_NATIVE -> ExitRecord.CRASH_NATIVE
            ApplicationExitInfo.REASON_ANR -> ExitRecord.ANR
            else -> return null
        }
        val (trace, format) = traceOf(info, native = reason == ExitRecord.CRASH_NATIVE)
        return ExitRecord(
            reason = reason,
            timestampMs = info.timestamp,
            description = info.description,
            importance = info.importance,
            trace = trace,
            traceFormat = format,
        )
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun traceOf(info: ApplicationExitInfo, native: Boolean): Pair<String?, String?> {
        val max = DiagnosticsBuilder.CRASH_TRACE_MAX_BYTES
        val stream = runCatching { info.traceInputStream }.getOrNull() ?: return null to null
        return runCatching {
            stream.use { input ->
                if (native) {
                    // Base64 grows by 4/3; read only what fits once encoded.
                    val bytes = input.readNBytesCompat(max / 4 * 3)
                    Base64.encodeToString(bytes, Base64.NO_WRAP) to TOMBSTONE_FORMAT
                } else {
                    val text = String(input.readNBytesCompat(max), Charsets.UTF_8)
                    DiagnosticsBuilder.truncateUtf8(LogScrubber.scrub(text), max) to null
                }
            }
        }.getOrDefault(null to null)
    }

    /** `InputStream.readNBytes` is API 33; this is the same thing for 30+. */
    private fun java.io.InputStream.readNBytesCompat(limit: Int): ByteArray {
        val buffer = ByteArray(limit)
        var total = 0
        while (total < limit) {
            val read = read(buffer, total, limit - total)
            if (read < 0) break
            total += read
        }
        return buffer.copyOf(total)
    }

    private const val TAG = "ExitReasons"
}
