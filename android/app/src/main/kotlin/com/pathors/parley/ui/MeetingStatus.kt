package com.pathors.parley.ui

import androidx.annotation.StringRes
import com.pathors.parley.R
import com.pathors.parley.audio.MicRecoveryState
import com.pathors.parley.kit.CaptureRecovery
import com.pathors.parley.kit.TranscriptSegment
import com.pathors.parley.meeting.MeetingState
import com.pathors.parley.meeting.isInProgress
import com.pathors.parley.meeting.TranscriptionIssue

/**
 * The decisions behind the live meeting screen's status lines, kept apart from
 * the composables that render them so they can be tested without Compose.
 */

/** The one microphone line the meeting screen shows, and whether it is bad news. */
internal sealed interface MicLine {
    val alarming: Boolean

    /** The recovery ladder ran out; [loss] says why, in terms the user can act on. */
    data class Lost(val loss: CaptureRecovery.Loss) : MicLine {
        override val alarming: Boolean get() = true
    }

    /** Something took the microphone and a rebuild is under way. */
    data object Recovering : MicLine {
        override val alarming: Boolean get() = true
    }

    /** The microphone is ours but delivering silence. */
    data object Silenced : MicLine {
        override val alarming: Boolean get() = true
    }

    /** A recovery just landed; news for a moment, not a state. */
    data object Back : MicLine {
        override val alarming: Boolean get() = false
    }
}

/**
 * The single microphone line, the way iOS shows its one status line
 * (`MeetingRecorder.handle(_: AudioCapture.Status)`), in priority order: lost,
 * being fought for, silenced, back. Never two at once — a silenced microphone
 * is usually *also* recovering, and two banners saying the same thing in
 * different words read as two problems.
 */
internal fun micLine(recovery: MicRecoveryState, silenced: Boolean, back: Boolean): MicLine? =
    when (recovery) {
        is MicRecoveryState.Lost -> MicLine.Lost(recovery.loss)
        MicRecoveryState.Recovering -> MicLine.Recovering
        MicRecoveryState.Holding -> when {
            silenced -> MicLine.Silenced
            back -> MicLine.Back
            else -> null
        }
    }

/** True while the meeting is in progress: connecting, recording or paused. */
internal fun isLive(state: MeetingState): Boolean = state.isInProgress

/** True once the meeting has an outcome: nothing is recording, finishing or uploading. */
internal fun isSettled(state: MeetingState): Boolean =
    state is MeetingState.Finished || state is MeetingState.Failed

/**
 * The finished state of a meeting the user did not end — the microphone or the
 * disk did — or null for any other state, including a meeting the user stopped.
 */
internal fun interruptedFinish(state: MeetingState): MeetingState.Finished? =
    (state as? MeetingState.Finished)?.takeIf { it.interruptedBy != null }

/**
 * Where a finished meeting ended up, in the words iOS `MeetingRecorder.upload`
 * uses for each ending. The copy is [finishedOutcomeRes]'s; this is the
 * decision, kept apart so it can be tested without resources.
 */
internal sealed interface FinishedOutcome {
    /** Under two seconds: a tap of the record button, not a meeting. */
    data object TooShort : FinishedOutcome

    /** The cloud has it. */
    data object Synced : FinishedOutcome

    /** The cloud has it, and a copy went to [org] (the default save location). */
    data class SharedTo(val org: String) : FinishedOutcome

    /** Still on the phone because the cloud said 402; it waits for the quota. */
    data object WaitingForQuota : FinishedOutcome

    /** Still on the phone because the cloud refused it; parked, retried later or by hand. */
    data object NotUploaded : FinishedOutcome

    /** Still on the phone for any other reason; the queue retries it. */
    data object Queued : FinishedOutcome
}

internal fun finishedOutcome(finished: MeetingState.Finished): FinishedOutcome {
    val org = finished.sharedToOrgName
    return when {
        finished.dropped -> FinishedOutcome.TooShort
        finished.pendingUpload && finished.waitingForQuota -> FinishedOutcome.WaitingForQuota
        finished.pendingUpload && finished.uploadRefused -> FinishedOutcome.NotUploaded
        finished.pendingUpload -> FinishedOutcome.Queued
        org != null -> FinishedOutcome.SharedTo(org)
        else -> FinishedOutcome.Synced
    }
}

/** The copy for [outcome]; [FinishedOutcome.SharedTo]'s takes the org's name as its argument. */
@StringRes
internal fun finishedOutcomeRes(outcome: FinishedOutcome): Int = when (outcome) {
    FinishedOutcome.TooShort -> R.string.meeting_dropped
    FinishedOutcome.Synced -> R.string.meeting_uploaded
    is FinishedOutcome.SharedTo -> R.string.meeting_shared_to
    FinishedOutcome.WaitingForQuota -> R.string.meeting_queued_quota
    FinishedOutcome.NotUploaded -> R.string.meeting_upload_refused
    FinishedOutcome.Queued -> R.string.meeting_sync_failed
}

/**
 * How a status line is drawn, which says as much as its words do. From iOS
 * `LiveView.statusLine`: a reconnect is an amber spinner, because it is a pause
 * the transcript comes back from; the end of the live transcript is ink with a
 * bolt, because the *recording* is fine and red would say the opposite; a
 * problem with the microphone or the disk is the error colour, because that one
 * does put the recording at risk.
 */
internal enum class NoticeTone {
    /** News, not a problem ("Microphone is back"). */
    INFO,

    /** The transcript paused and is coming back. */
    RECONNECTING,

    /** The live transcript is over; the recording is not. */
    TRANSCRIPT_STOPPED,

    /** The recording itself is at risk. */
    ALARM,
    ;

    /** Worth keeping on screen however far the panel is collapsed. */
    val needsAttention: Boolean get() = this != INFO
}

/** The tone of a transcription problem's line — see [NoticeTone]. */
internal fun transcriptionIssueTone(issue: TranscriptionIssue): NoticeTone =
    if (issue.isTerminal) NoticeTone.TRANSCRIPT_STOPPED else NoticeTone.RECONNECTING

/** The status copy for a transcription problem that did not stop the recording. */
@StringRes
internal fun transcriptionIssueRes(issue: TranscriptionIssue): Int = when (issue) {
    TranscriptionIssue.RECONNECTING -> R.string.meeting_issue_reconnecting
    TranscriptionIssue.QUOTA_EXCEEDED -> R.string.meeting_issue_quota
    TranscriptionIssue.STOPPED -> R.string.meeting_issue_stopped
    TranscriptionIssue.SIGNED_OUT -> R.string.meeting_issue_signed_out
}

/**
 * Which sentence the empty transcript panel shows: iOS's "Hit record…" before
 * a meeting (and after one that said nothing), and the desktop's "Listening…"
 * from the moment the meeting starts until somebody speaks.
 */
@StringRes
internal fun emptyTranscriptRes(state: MeetingState): Int =
    if (showsMeeting(state)) R.string.meeting_listening else R.string.meeting_idle_hint

/**
 * Whether the screen is the meeting's — the dock with the clock, Pause and End
 * — rather than the one before a meeting. It stays up through
 * [MeetingState.Finishing], the relay draining its last sentence, so End can
 * turn into its spinner where it was pressed instead of the screen changing
 * under the finger. iOS `LiveView.showsMeeting`.
 */
internal fun showsMeeting(state: MeetingState): Boolean =
    isLive(state) || state == MeetingState.Finishing

/**
 * Whether a finished meeting ends on its result page, as the desktop's End
 * does: the user ended it and the cloud has it (the page reads the recording
 * from there). Anything else — still on the phone (offline, the quota, a
 * refusal), too short to keep, or cut short by the microphone or the disk —
 * stays on the record screen with its status line, which is the only place
 * that says what happened.
 */
internal fun endsOnResultPage(state: MeetingState): Boolean =
    state is MeetingState.Finished && state.recordingId != null &&
        !state.pendingUpload && !state.dropped && state.interruptedBy == null

/**
 * The one warning strip under the top of the meeting screen. The desktop's
 * `LiveBanners` show one at a time, most urgent first, and so does this: what
 * Android can detect, in this order — a microphone that is gone, being fought
 * for or silenced (the recording itself is at risk), the disk filling, the
 * live transcript reconnecting or over (the recording is unaffected), and the
 * passing "microphone is back".
 */
internal sealed interface MeetingWarning {
    val tone: NoticeTone

    data class Mic(val line: MicLine) : MeetingWarning {
        override val tone: NoticeTone get() = if (line.alarming) NoticeTone.ALARM else NoticeTone.INFO
    }

    data object StorageLow : MeetingWarning {
        override val tone: NoticeTone get() = NoticeTone.ALARM
    }

    data class Transcription(val issue: TranscriptionIssue) : MeetingWarning {
        override val tone: NoticeTone get() = transcriptionIssueTone(issue)
    }
}

internal fun currentWarning(mic: MicLine?, storageLow: Boolean, issue: TranscriptionIssue?): MeetingWarning? =
    when {
        mic != null && mic.alarming -> MeetingWarning.Mic(mic)
        storageLow -> MeetingWarning.StorageLow
        issue != null -> MeetingWarning.Transcription(issue)
        mic != null -> MeetingWarning.Mic(mic)
        else -> null
    }

/**
 * The turn being spoken right now: the newest segment the provider has not
 * finalised. The only speaker label that gets the blue (iOS
 * `LiveView.currentSpeakingID`) — a final segment is something that *was* said.
 */
internal fun currentSpeakingId(segments: List<TranscriptSegment>): String? =
    segments.lastOrNull { !it.isFinal }?.id
