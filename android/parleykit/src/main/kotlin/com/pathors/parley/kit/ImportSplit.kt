package com.pathors.parley.kit

/**
 * Splitting an imported file that is too long for one hosted transcription.
 *
 * The cloud caps one hosted STT session at 6 hours of audio (the relay and the
 * batch route share the cap). An import streams the whole file through one relay
 * session, so a file past the cap used to be cut off by the server partway
 * through. A file longer than [HOSTED_MAX_PART_SECONDS] is instead imported as
 * `n` equal parts, each its own recording with its own relay session, and the
 * user is asked first.
 *
 * The part length leaves ten minutes of headroom under the 6 h cap: a
 * container's declared duration is not always exact, and the relay meters what
 * it is sent, not what the file claims.
 *
 * Same rule on every platform (iOS, Android, desktop). Pure so it is tested on
 * the JVM; the app owns the dialog and the decoding.
 */
object ImportSplit {

    /** The longest part one import sends through one hosted session: 5 h 50 min. */
    const val HOSTED_MAX_PART_SECONDS: Long = 5 * 3600 + 50 * 60

    const val HOSTED_MAX_PART_MS: Long = HOSTED_MAX_PART_SECONDS * 1000

    /**
     * How many parts a file of [durationMs] is imported in: 1 up to and
     * including [HOSTED_MAX_PART_SECONDS], then one more for every started
     * multiple. Null when the duration is unknown (negative), which imports the
     * file whole, as before.
     */
    fun partCount(durationMs: Long): Int? {
        if (durationMs < 0) return null
        val parts = (durationMs + HOSTED_MAX_PART_MS - 1) / HOSTED_MAX_PART_MS
        return parts.coerceAtLeast(1L).toInt()
    }

    /**
     * The split for a file of [durationMs], or null when it is imported whole —
     * short enough for one session, or of unknown length.
     */
    fun plan(durationMs: Long): ImportSplitPlan? {
        val count = partCount(durationMs) ?: return null
        if (count <= 1) return null
        val parts = (1..count).map { k ->
            ImportPart(
                index = k,
                count = count,
                startMs = boundary(durationMs, k - 1, count),
                endMs = boundary(durationMs, k, count),
            )
        }
        return ImportSplitPlan(durationMs = durationMs, parts = parts)
    }

    /**
     * The title of part [index] of [count] of a file named [name]: `name（1/3）`
     * with full-width brackets in Chinese, `name (1/3)` otherwise.
     */
    fun partTitle(name: String, index: Int, count: Int, style: PartTitleStyle): String =
        when (style) {
            PartTitleStyle.FULL_WIDTH -> "$name（$index/$count）"
            PartTitleStyle.ASCII -> "$name ($index/$count)"
        }

    /** The [k]th of [count] equal cut points of [durationMs]; exact at both ends. */
    private fun boundary(durationMs: Long, k: Int, count: Int): Long =
        // Overflow-safe for any real duration: ms * a part count stays far
        // below Long.MAX_VALUE.
        durationMs * k / count
}

/** How a part's title is bracketed. */
enum class PartTitleStyle { FULL_WIDTH, ASCII }

/**
 * One part of a split import: `[startMs, endMs)` of the source, 1-based
 * [index] of [count].
 */
data class ImportPart(
    val index: Int,
    val count: Int,
    val startMs: Long,
    val endMs: Long,
) {
    val durationMs: Long get() = endMs - startMs

    /**
     * The last part runs to the end of the stream rather than stopping at
     * [endMs]: the container's duration is only a claim, and audio past it
     * must not be dropped.
     */
    val isLast: Boolean get() = index == count
}

/** A file split into [parts] equal parts. Only ever built with two or more. */
data class ImportSplitPlan(
    val durationMs: Long,
    val parts: List<ImportPart>,
) {
    val count: Int get() = parts.size

    /** How long each part is, as the confirmation dialog states it. */
    val partDurationMs: Long get() = durationMs / count
}
