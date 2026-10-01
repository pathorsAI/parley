package com.pathors.parley.feedback

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * The last few hundred lines this process logged, kept in memory for a problem
 * report — the `log` and `recentErrors` of the diagnostics.
 *
 * ## Why not read logcat
 *
 * An app may read its own logcat, but what comes back depends on the OEM's
 * buffer sizes, is shared with every other tag the process emits (the
 * framework's included), and is gone the moment the system rotates it. A ring
 * the app fills itself holds exactly Parley's own lines, as many as it decided
 * to keep, and passes every one through [LogScrubber] **on the way in** — so a
 * token is never even held in memory waiting for a report that may not come.
 *
 * Fed by [Log], the app's drop-in for `android.util.Log`; see there.
 *
 * Thread-safe: logging happens from the microphone thread, OkHttp's threads and
 * the main thread at once.
 */
class LogRing(private val capacity: Int = DEFAULT_CAPACITY) {

    /** One logged line, already scrubbed. */
    data class Entry(
        val atMs: Long,
        /** `V` `D` `I` `W` `E`, as logcat prints them. */
        val level: Char,
        val tag: String,
        val message: String,
        /** `SimpleName: message` of the throwable logged with the line, if any. */
        val error: String? = null,
        /** The throwable's top frames, one per line, if any. */
        val frames: String? = null,
    ) {
        val isProblem: Boolean get() = level == 'W' || level == 'E'
    }

    private val entries = ArrayDeque<Entry>(capacity)

    fun record(level: Char, tag: String, message: String, error: Throwable? = null, atMs: Long = System.currentTimeMillis()) {
        val entry = Entry(
            atMs = atMs,
            level = level,
            tag = tag,
            message = LogScrubber.scrub(message).take(MAX_MESSAGE_CHARS),
            error = error?.let { LogScrubber.scrub("${it.javaClass.simpleName}: ${it.message.orEmpty()}").take(MAX_MESSAGE_CHARS) },
            frames = error?.stackTrace?.take(MAX_FRAMES)?.joinToString("\n") { "    at $it" },
        )
        synchronized(entries) {
            if (entries.size >= capacity) entries.removeFirst()
            entries.addLast(entry)
        }
    }

    fun snapshot(): List<Entry> = synchronized(entries) { entries.toList() }

    /** Tests only. */
    fun clear() = synchronized(entries) { entries.clear() }

    companion object {
        const val DEFAULT_CAPACITY = 400
        private const val MAX_MESSAGE_CHARS = 500
        private const val MAX_FRAMES = 8

        /**
         * The newest lines as text, oldest first, cut from the *front* to fit
         * [maxBytes] of UTF-8 — the end of a log is where the problem is.
         */
        fun render(entries: List<Entry>, maxBytes: Int): String {
            val lines = ArrayDeque<String>()
            var bytes = 0
            for (entry in entries.asReversed()) {
                val line = format(entry)
                val size = line.toByteArray(Charsets.UTF_8).size + 1
                if (bytes + size > maxBytes) break
                lines.addFirst(line)
                bytes += size
            }
            return lines.joinToString("\n")
        }

        private fun format(entry: Entry): String = buildString {
            append(timestamp(entry.atMs)).append(' ').append(entry.level).append('/')
            append(entry.tag).append(": ").append(entry.message)
            entry.error?.let { append('\n').append("  ").append(it) }
            entry.frames?.takeIf { it.isNotEmpty() }?.let { append('\n').append(it) }
        }

        /** UTC, so a report reads the same wherever it is opened. */
        private fun timestamp(atMs: Long): String =
            SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US)
                .apply { timeZone = TimeZone.getTimeZone("UTC") }
                .format(Date(atMs))
    }
}

/**
 * The app's `Log`: every call goes to logcat exactly as `android.util.Log` would
 * send it, and is also kept in [ring] for the next problem report.
 *
 * A drop-in by design — same name, same four levels, same signatures — so that
 * adopting it was an import change at each call site and not a rewrite, and so
 * that a line added later in the usual way lands in reports too as long as the
 * file imports this `Log`. Every file under `app/` that logs does.
 *
 * What goes through here is scrubbed ([LogScrubber]) before it is stored, but
 * the rule that matters is upstream of that: **never log transcript text or
 * anything the user typed.** No pattern can take those back out.
 */
object Log {
    /** This process's recent lines. */
    val ring = LogRing()

    fun d(tag: String, message: String): Int {
        ring.record('D', tag, message)
        return android.util.Log.d(tag, message)
    }

    fun i(tag: String, message: String): Int {
        ring.record('I', tag, message)
        return android.util.Log.i(tag, message)
    }

    fun w(tag: String, message: String): Int {
        ring.record('W', tag, message)
        return android.util.Log.w(tag, message)
    }

    fun w(tag: String, message: String, error: Throwable?): Int {
        ring.record('W', tag, message, error)
        return android.util.Log.w(tag, message, error)
    }

    fun e(tag: String, message: String): Int {
        ring.record('E', tag, message)
        return android.util.Log.e(tag, message)
    }

    fun e(tag: String, message: String, error: Throwable?): Int {
        ring.record('E', tag, message, error)
        return android.util.Log.e(tag, message, error)
    }
}
