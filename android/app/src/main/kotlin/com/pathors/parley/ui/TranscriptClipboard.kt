package com.pathors.parley.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import com.pathors.parley.R
import com.pathors.parley.cloud.TranscriptSegmentDto
import com.pathors.parley.kit.TranscriptSegment
import kotlinx.coroutines.delay

/**
 * Getting transcript text off the phone and into somewhere else.
 *
 * Both transcript screens show the same three facts — who spoke, when, and what
 * they said — so they share one plain-text shape instead of each inventing its
 * own. A transcript pasted into a mail draft should read the same whether it
 * was copied mid-meeting or from a recording opened a week later:
 *
 * ```
 * Speaker 1  0:12
 * Let's start with the renewal.
 *
 * Speaker 2  0:19
 * Sure — the term is the part we want to revisit.
 * ```
 *
 * This is deliberately the same shape iOS writes
 * (`ios/App/Parley/TranscriptClipboard.swift`): two spaces between the label and
 * the clock, the words on their own line, and a blank line between turns so
 * speaker turns survive being pasted into an editor that reflows paragraphs. A
 * transcript that pastes differently depending on which phone it came off is one
 * nobody can diff, quote or template against.
 *
 * The screens disagree on only one thing, how a speaker is named: the live screen
 * has nothing but diarization indices, while a synced recording may carry names
 * the desktop app assigned. So the caller supplies the label, through the same
 * [speakerLabel] helpers the rows on screen use — what gets copied can then never
 * drift from what is being read.
 */
object TranscriptClipboard {

    /** A blank line between turns. */
    private const val SEPARATOR = "\n\n"

    /** One turn: `label  m:ss` then the words. */
    fun plainText(label: String, startMs: Long, text: String): String =
        "$label  ${formatClock(startMs)}\n$text"

    fun plainText(segment: TranscriptSegment, label: String): String =
        plainText(label, segment.startMs, segment.text)

    fun plainText(segment: TranscriptSegmentDto, label: String): String =
        plainText(label, segment.startMs, segment.text)

    /**
     * The live screen's whole transcript. Named rather than overloaded because
     * the two list forms would erase to the same JVM signature.
     *
     * Whatever is on screen is what is copied, tentative tail included: the
     * reason to grab a line mid-meeting is usually that it was just said.
     */
    fun liveTranscript(
        segments: List<TranscriptSegment>,
        label: (TranscriptSegment) -> String,
    ): String = segments.joinToString(SEPARATOR) { plainText(it, label(it)) }

    /**
     * A synced recording's whole transcript. The caller filters to finals first,
     * for the same reason: the detail screen never renders the tentative tail, so
     * it must not reach the clipboard either.
     */
    fun storedTranscript(
        segments: List<TranscriptSegmentDto>,
        label: (TranscriptSegmentDto) -> String,
    ): String = segments.joinToString(SEPARATOR) { plainText(it, label(it)) }

    fun write(context: Context, text: String, clipLabel: String) {
        val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return
        clipboard.setPrimaryClip(ClipData.newPlainText(clipLabel, text))
    }

    /**
     * Hand the text to whatever the user has installed. Android's share sheet is
     * cheap and universal, and it is one of the few places this app can go past
     * the iOS build rather than catch up to it.
     */
    fun share(context: Context, text: String, title: String) {
        val send = Intent(Intent.ACTION_SEND)
            .setType("text/plain")
            .putExtra(Intent.EXTRA_TITLE, title)
            .putExtra(Intent.EXTRA_SUBJECT, title)
            .putExtra(Intent.EXTRA_TEXT, text)
        // A chooser always resolves, but a device with no share target at all (a
        // locked-down kiosk image) would otherwise take the app down with it.
        runCatching { context.startActivity(Intent.createChooser(send, title)) }
    }
}

/** How long the button admits it copied something. */
private const val COPIED_FEEDBACK_MS = 1_500L

/**
 * The "copy the whole transcript" control.
 *
 * The app has no toast layer and this is not the place to grow one, so the
 * confirmation is the button itself: the label becomes "Copied" for a moment.
 * Without it a tap on a copy-everything button gives no evidence it did
 * anything, and people tap again. The same swap reaches TalkBack through the
 * content description, which is the only signal the changed wording carries for
 * someone who is not looking at it.
 *
 * [text] is evaluated on tap rather than on every redraw — during a live meeting
 * the transcript changes several times a second.
 *
 * A word rather than a glyph because `material-icons-core` ships no copy icon,
 * and because a label is in any case unambiguous on a screen full of prose.
 */
@Composable
fun CopyTranscriptButton(
    text: () -> String,
    isEmpty: Boolean,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val clipLabel = stringResource(R.string.transcript_clip_label)

    // A tick rather than a boolean: a second tap has to restart the window
    // instead of being cut short by the first tap's pending revert, and
    // re-setting `true` would not re-launch the effect.
    var copies by remember { mutableIntStateOf(0) }
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copies) {
        if (copies == 0) return@LaunchedEffect
        copied = true
        delay(COPIED_FEEDBACK_MS)
        copied = false
    }

    val label = stringResource(if (copied) R.string.transcript_copied else R.string.action_copy)
    val spoken = stringResource(
        if (copied) R.string.transcript_copied else R.string.transcript_copy
    )
    TextButton(
        onClick = {
            val payload = text()
            if (payload.isEmpty()) return@TextButton
            TranscriptClipboard.write(context, payload, clipLabel)
            copies++
        },
        // Stays visible rather than disappearing, so the bar does not shuffle
        // when the first segment lands — but there is nothing to copy yet.
        enabled = !isEmpty,
        modifier = modifier.semantics { contentDescription = spoken },
    ) {
        Text(label)
    }
}

/** The share-sheet twin of [CopyTranscriptButton]. */
@Composable
fun ShareTranscriptButton(
    text: () -> String,
    isEmpty: Boolean,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val title = stringResource(R.string.transcript_share_title)
    IconButton(
        onClick = {
            val payload = text()
            if (payload.isNotEmpty()) TranscriptClipboard.share(context, payload, title)
        },
        enabled = !isEmpty,
        modifier = modifier,
    ) {
        Icon(Icons.Default.Share, stringResource(R.string.transcript_share))
    }
}
