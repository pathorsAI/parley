package com.pathors.parley.ui

import android.os.Build
import android.view.HapticFeedbackConstants
import android.view.View

/**
 * The beats a meeting recording has, in one place so they cannot drift apart.
 * The Android counterpart of iOS `ParleyKit/Sources/ParleyKit/Haptics.swift`,
 * kept to the four moments the hand most needs to tell apart without the eye:
 *
 * | Moment | Constant (API 30+) | Before API 30 |
 * |---|---|---|
 * | the microphone opened | `GESTURE_START` | `VIRTUAL_KEY` |
 * | stopped, and what it heard was kept | `CONFIRM` | `VIRTUAL_KEY` |
 * | thrown away; nothing follows | `CONTEXT_CLICK` | `CONTEXT_CLICK` |
 * | the microphone was taken away | `REJECT` | `LONG_PRESS` |
 *
 * iOS builds its vocabulary from two-beat patterns that rise and fall; Android
 * already names these meanings, and the platform's own constants are what a
 * user's other apps use for them, so they are used as they are rather than
 * imitated with a custom waveform.
 *
 * **Nothing here is ever load-bearing.** `performHapticFeedback` honours the
 * system's touch-feedback setting and silently does nothing when it is off or
 * when the view is detached; every call site fires and forgets. A beat that
 * does not play costs the user nothing.
 */
internal object MeetingHaptics {
    fun recordingStarted(view: View) {
        view.performHapticFeedback(
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                HapticFeedbackConstants.GESTURE_START
            } else {
                HapticFeedbackConstants.VIRTUAL_KEY
            }
        )
    }

    fun recordingStopped(view: View) {
        view.performHapticFeedback(
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                HapticFeedbackConstants.CONFIRM
            } else {
                HapticFeedbackConstants.VIRTUAL_KEY
            }
        )
    }

    fun recordingDiscarded(view: View) {
        view.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK)
    }

    /**
     * Something happened *to* the user rather than something they pressed —
     * the one beat here that answers no tap, like iOS `micTakenBySystem`.
     */
    fun microphoneLost(view: View) {
        view.performHapticFeedback(
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                HapticFeedbackConstants.REJECT
            } else {
                HapticFeedbackConstants.LONG_PRESS
            }
        )
    }
}
