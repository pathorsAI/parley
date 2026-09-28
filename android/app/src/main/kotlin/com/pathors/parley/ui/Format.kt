package com.pathors.parley.ui

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import com.pathors.parley.AppContainer
import com.pathors.parley.R
import com.pathors.parley.cloud.TranscriptSegmentDto
import com.pathors.parley.kit.SpeakerLabel
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

/**
 * The words [SpeakerLabel] fills in, in the app's language — iOS reads the
 * same four from ParleyKit's catalogue.
 */
fun speakerStrings(context: Context): SpeakerLabel.Strings = SpeakerLabel.Strings(
    you = context.getString(R.string.speaker_you),
    youNumbered = context.getString(R.string.speaker_you_numbered),
    them = context.getString(R.string.speaker_them),
    remoteNumbered = context.getString(R.string.speaker_remote_numbered),
    lettered = context.getString(R.string.speaker_label),
)

/**
 * The label for a phone's own (`mix`) speaker: "Speaker A", "Speaker B" …, and
 * `…` while diarization has not decided (index 0) — iOS `speakerLetter`, which
 * is what the live screen and the stored transcript both show there.
 */
fun speakerLabel(context: Context, speaker: Int): String =
    SpeakerLabel.fallback(SOURCE_MIX, speaker, speakerStrings(context))

/**
 * The label for a stored segment: the name the user assigned, else the
 * desktop's rules for its source — "You" / "Them" / "Remote N" for a desktop
 * recording's two sides, letters for a phone's `mix`. iOS
 * `RecordingMeta.speakerLabel(for:)`; see [SpeakerLabel].
 */
fun speakerLabel(context: Context, segment: TranscriptSegmentDto, assigned: String?): String =
    assigned?.takeIf { it.isNotEmpty() }
        ?: SpeakerLabel.fallback(segment.source, segment.speaker, speakerStrings(context))

private const val SOURCE_MIX = "mix"

/** Whether this segment is the tentative tail (rendered dimmed, never persisted). */
fun TranscriptSegment.isTail(): Boolean = id.endsWith("-tail")
