package com.pathors.parley.meeting

import com.pathors.parley.kit.TranscriptSegment

/**
 * A meeting that ended on the record screen and landed in the cloud, as its
 * result page needs it: the recording, plus what only the record screen knew
 * about it — whether it was named or filed there (the filing card skips those
 * halves), what was said (the pass reads the stored transcript first, this
 * only if that is empty), and how the microphone held up (the `mic_recovery`
 * prompt). iOS `EndedMeeting`.
 */
data class EndedMeeting(
    val recordingId: String,
    val finished: MeetingState.Finished,
    val segments: List<TranscriptSegment>,
    val elapsedMs: Long,
)

/**
 * The hand-off from the record screen to the result page — the phone's version
 * of the desktop's End, which finishes saving and then opens the recording's
 * report. iOS `TabRouter.openEndedMeeting`.
 *
 * The record screen [hand]s the meeting over and navigates; the result page
 * [take]s it once, when its ViewModel is made (so a rotation does not ask
 * twice, and opening the same recording later from the Library is an ordinary
 * read). A page for a different recording finds nothing.
 */
object EndedMeetings {
    @Volatile
    private var pending: EndedMeeting? = null

    fun hand(meeting: EndedMeeting) {
        pending = meeting
    }

    /** The meeting handed over for [recordingId], once; null for any other page. */
    @Synchronized
    fun take(recordingId: String): EndedMeeting? {
        val meeting = pending?.takeIf { it.recordingId == recordingId } ?: return null
        pending = null
        return meeting
    }
}
