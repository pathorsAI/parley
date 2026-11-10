package com.pathors.parley.meeting

enum class PauseToggle { PAUSE, RESUME }

/**
 * The state [toggle] moves [this] to, or null when it does not apply (pausing
 * while connecting, resuming a recording, anything after Stop).
 */
fun MeetingState.after(toggle: PauseToggle): MeetingState? = when {
    toggle == PauseToggle.PAUSE && this == MeetingState.Recording -> MeetingState.Paused
    toggle == PauseToggle.RESUME && this == MeetingState.Paused -> MeetingState.Recording
    else -> null
}
