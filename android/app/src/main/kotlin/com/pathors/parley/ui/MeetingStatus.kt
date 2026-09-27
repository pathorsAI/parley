package com.pathors.parley.ui

import androidx.annotation.StringRes
import com.pathors.parley.R
import com.pathors.parley.audio.MicRecoveryState
import com.pathors.parley.kit.CaptureRecovery
import com.pathors.parley.meeting.MeetingState
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

/** True while the microphone is (or is about to be) capturing. */
internal fun isLive(state: MeetingState): Boolean =
    state is MeetingState.Recording || state is MeetingState.Connecting

/**
 * The finished state of a meeting the user did not end — the microphone or the
 * disk did — or null for any other state, including a meeting the user stopped.
 */
internal fun interruptedFinish(state: MeetingState): MeetingState.Finished? =
    (state as? MeetingState.Finished)?.takeIf { it.interruptedBy != null }

/** Where a finished meeting's audio ended up: in the upload queue, or uploaded. */
@StringRes
internal fun finishedOutcomeRes(finished: MeetingState.Finished): Int =
    if (finished.pendingUpload) R.string.meeting_queued else R.string.meeting_uploaded

/** The banner copy for a transcription problem that did not stop the recording. */
@StringRes
internal fun transcriptionIssueRes(issue: TranscriptionIssue): Int = when (issue) {
    TranscriptionIssue.QUOTA_EXCEEDED -> R.string.meeting_issue_quota
    TranscriptionIssue.RELAY_ERROR,
    TranscriptionIssue.RELAY_CLOSED,
    -> R.string.meeting_issue_error
}
