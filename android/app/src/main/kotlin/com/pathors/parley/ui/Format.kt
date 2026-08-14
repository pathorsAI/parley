package com.pathors.parley.ui

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import com.pathors.parley.AppContainer
import com.pathors.parley.R
import com.pathors.parley.cloud.TranscriptSegmentDto
import com.pathors.parley.kit.TranscriptSegment
import com.pathors.parley.parleyContainer
import java.text.DateFormat
import java.util.Date
import java.util.Locale

/** The process-wide service locator, for composables that need a repository. */
@Composable
fun rememberContainer(): AppContainer = LocalContext.current.parleyContainer

/** `m:ss`, or `h:mm:ss` past an hour — the same shape as iOS and the desktop. */
fun formatDuration(ms: Double): String {
    val total = (ms / 1000.0).toLong().coerceAtLeast(0L)
    val hours = total / 3600
    val minutes = (total % 3600) / 60
    val seconds = total % 60
    return if (hours > 0) {
        String.format(Locale.US, "%d:%02d:%02d", hours, minutes, seconds)
    } else {
        String.format(Locale.US, "%d:%02d", minutes, seconds)
    }
}

/** A transcript timestamp, always `m:ss`. */
fun formatClock(ms: Long): String {
    val total = (ms / 1000).coerceAtLeast(0L)
    return String.format(Locale.US, "%d:%02d", total / 60, total % 60)
}

/** A recording's creation time, in the device's locale and format. */
fun formatTimestamp(epochMs: Double): String =
    DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(epochMs.toLong()))

/** A date only — used for the quota period reset. */
fun formatDate(epochMs: Double): String =
    DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(epochMs.toLong()))

/** Metered seconds, shown as minutes once there are enough of them to matter. */
fun formatSeconds(seconds: Double): String {
    val whole = seconds.toLong().coerceAtLeast(0L)
    return if (whole < 120) {
        String.format(Locale.getDefault(), "%d s", whole)
    } else {
        String.format(Locale.getDefault(), "%d min", whole / 60)
    }
}

fun formatCredits(credits: Double): String =
    String.format(Locale.getDefault(), "%.1f", credits)

/**
 * The speaker label for a live segment. Diarization reports 0 when it cannot
 * tell people apart, which is one unnamed speaker rather than "Speaker 0".
 */
fun speakerLabel(context: Context, speaker: Int): String =
    if (speaker <= 0) {
        context.getString(R.string.speaker_unknown)
    } else {
        context.getString(R.string.speaker_label, speaker)
    }

/** Same rule for a stored segment, preferring the name the user assigned. */
fun speakerLabel(context: Context, segment: TranscriptSegmentDto, assigned: String?): String =
    assigned?.takeIf { it.isNotEmpty() } ?: speakerLabel(context, segment.speaker)

/** Whether this segment is the tentative tail (rendered dimmed, never persisted). */
fun TranscriptSegment.isTail(): Boolean = id.endsWith("-tail")
