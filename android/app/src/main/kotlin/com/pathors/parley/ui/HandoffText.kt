package com.pathors.parley.ui

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentSender
import android.app.PendingIntent
import android.icu.text.ListFormatter
import com.pathors.parley.R
import com.pathors.parley.cloud.RecordingMeta
import com.pathors.parley.cloud.TranscriptSegmentDto
import com.pathors.parley.kit.GettingStartedStep
import com.pathors.parley.kit.HandoffPrompt
import com.pathors.parley.parleyContainer
import java.text.DateFormat
import java.util.Date
import kotlinx.serialization.json.JsonPrimitive

/**
 * [HandoffPrompt] for a recording as the detail screen holds it: the final
 * segments, the names the meta assigns, and the meeting context if the desktop
 * (or the sample) recorded one — iOS `HandoffPrompt.build(summary:meta:)`.
 *
 * Everything locale-shaped is resolved here, in the app's language: the copy
 * from resources, the date through [DateFormat], and the speaker list through
 * ICU's [ListFormatter] — "You and Mr. Lin", "你和林經理" — which is the same
 * CLDR data iOS's `.list(type: .and)` formats with.
 */
object HandoffText {

    /** The three questions any meeting can answer. The sample asks its own. */
    fun genericQuestions(context: Context): List<String> = listOf(
        context.getString(R.string.handoff_question_summary),
        context.getString(R.string.handoff_question_commitments),
        context.getString(R.string.handoff_question_missed),
    )

    fun strings(context: Context): HandoffPrompt.Strings = HandoffPrompt.Strings(
        preamble = context.getString(R.string.handoff_preamble),
        closing = context.getString(R.string.handoff_closing),
        meeting = context.getString(R.string.handoff_meeting),
        context = context.getString(R.string.handoff_context),
        contextMissing = context.getString(R.string.handoff_context_missing),
        speakers = context.getString(R.string.handoff_speakers),
        transcriptHeader = context.getString(R.string.handoff_transcript_header),
        line = context.getString(R.string.handoff_line),
    )

    /**
     * The whole paste. [questions] is null for the generic three — the sample
     * passes the ones written for its script.
     */
    fun build(context: Context, meta: RecordingMeta, questions: List<String>?): String {
        val segments = meta.segments.filter { it.isFinal }
        val label = { segment: TranscriptSegmentDto ->
            speakerLabel(context, segment, meta.speakerName(segment))
        }
        val locale = context.resources.configuration.locales[0]
        val names = HandoffPrompt.distinctSpeakers(segments, label)
        return HandoffPrompt.build(
            strings(context),
            HandoffPrompt.Meeting(
                title = meta.title.ifEmpty { context.getString(R.string.recording_untitled) },
                date = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT, locale)
                    .format(Date(meta.createdAt.toLong())),
                context = (meta.raw["meetingContext"] as? JsonPrimitive)
                    ?.takeIf { it.isString }?.content.orEmpty(),
                speakers = ListFormatter.getInstance(locale).format(names),
                turns = segments.map { HandoffPrompt.Turn(label(it), it.startMs, it.text) },
                questions = questions?.takeIf { it.isNotEmpty() } ?: genericQuestions(context),
            ),
        )
    }
}

/**
 * Hears that the share sheet actually sent the hand-off somewhere, which is what
 * ticks the checklist's last item — iOS ticks on `UIActivityViewController`'s
 * `completed`, and the Android equivalent is the chooser's callback. A share
 * sheet that was opened and backed out of is not a hand-off.
 *
 * The chooser fires [intentSender] only once a target has been picked. Immutable,
 * because nothing here reads what the chooser would add to it: the broadcast
 * arriving is the whole message.
 */
class HandoffShareReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        context.parleyContainer.gettingStarted.mark(GettingStartedStep.SHARED_TO_AI)
    }

    companion object {
        private const val REQUEST_CODE = 460

        fun intentSender(context: Context): IntentSender = PendingIntent.getBroadcast(
            context,
            REQUEST_CODE,
            Intent(context, HandoffShareReceiver::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        ).intentSender
    }
}
