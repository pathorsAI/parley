package com.pathors.parley.ui

import androidx.compose.runtime.compositionLocalOf
import com.pathors.parley.cloud.RecordingSummary
import com.pathors.parley.kit.GettingStartedState
import com.pathors.parley.kit.SampleManifest

/**
 * The guided lap's recording: which one it is, and whether the recording screen
 * on display is it.
 *
 * Onboarding v2 (iOS #450) teaches the lap on the recording itself — a guide bar
 * that walks file → replay → share — and only on *the* recording the lap is
 * about: the sample, or the user's only recording. On the fortieth recording the
 * lap would be noise. The library knows which recording that is; the recording
 * screen does not, so the library says so on the way in, through the recording
 * route's `guided` argument (see `ParleyRoot`), and the screen reads it here.
 */
object LapRules {

    /**
     * The recording "Continue →" reopens: the sample when it is in the library,
     * else the newest of the user's own (which is the only one, while there is
     * only one). iOS `LibraryView.lapRecording`.
     *
     * [recordings] is the personal library from the cloud, without the sample.
     */
    fun lapRecording(recordings: List<RecordingSummary>, sample: RecordingSummary?): RecordingSummary? =
        sample ?: recordings.maxByOrNull { it.createdAt }

    /**
     * Whether a row opens with the guide bar: a personal recording that is the
     * sample, or the user's only recording. iOS `LibraryView.isLapRecording`.
     *
     * [orgId] is the scope the row was opened from (null = personal);
     * [recordings] is the personal library from the cloud, without the sample.
     */
    fun isLapRecording(id: String, orgId: String?, recordings: List<RecordingSummary>): Boolean {
        if (orgId != null) return false
        if (SampleManifest.isSample(id)) return true
        return recordings.singleOrNull()?.id == id
    }

    /**
     * The checklist header's one action: "Continue →" once something is
     * recorded and there is a lap recording to go back to, else "Walk through it
     * with the sample recording" — or nothing, in a build without the sample.
     * iOS `LibraryView.checklistAction`.
     */
    fun checklistAction(
        state: GettingStartedState,
        lapRecording: RecordingSummary?,
        sampleBundled: Boolean,
    ): ChecklistAction = when {
        state.recorded && lapRecording != null -> ChecklistAction.CONTINUE_LAP
        sampleBundled -> ChecklistAction.WALK_THROUGH
        else -> ChecklistAction.NONE
    }
}

/** What the checklist's header offers. */
enum class ChecklistAction {
    /** 用範例錄音走一遍 — nothing recorded yet: the transcribing beat, then the sample opens. */
    WALK_THROUGH,

    /** 繼續 → — back into the lap recording ([LapRules.lapRecording]). */
    CONTINUE_LAP,

    /** A build without the sample, and nothing to continue. */
    NONE,
}

/**
 * True inside a recording screen that was opened as the guided lap's recording —
 * from the checklist's own action ("Walk through…", "Continue →"), or from a row
 * that [LapRules.isLapRecording] picks out. The recording route's `guided`
 * argument, provided by `ParleyRoot` around `RecordingDetailScreen`.
 *
 * It says "this is the lap recording", nothing more: whether the guide bar is
 * actually up also depends on the checklist (`GettingStartedState.isVisible`, not
 * dismissed), which the bar reads for itself.
 */
val LocalLapRecording = compositionLocalOf { false }
