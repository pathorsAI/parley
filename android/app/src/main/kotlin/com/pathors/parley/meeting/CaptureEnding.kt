package com.pathors.parley.meeting

/**
 * How a live capture came to an end — and from that, the one decision that
 * cannot be taken back: whether the Ogg file written so far is kept or deleted.
 *
 * The distinction this type exists to force is between *releasing the
 * microphone* and *throwing the recording away*. They arrive together often
 * enough (the capture threw, the service was destroyed, the process is going
 * down) that the code used to treat them as one thing, and every unexpected
 * failure therefore deleted the meeting it had just finished recording. They are
 * not one thing: the microphone can always be taken back, and forty minutes of
 * audio cannot.
 *
 * So the table is deliberately lopsided. Only a person saying "throw this away"
 * deletes anything; everything else keeps the bytes, even when keeping them
 * means saving a file whose container could not be closed cleanly. Mirrors iOS,
 * where `MeetingRecorder.discard()` is the sole `audio.discard()` call site and
 * a lost microphone merely sets a flag and takes the ordinary stop path.
 */
enum class CaptureEnding {
    /** The user asked to stop. Finish the file and upload it. */
    COMPLETED,

    /**
     * Something ended the capture that the user did not ask to end: the
     * microphone was taken, the encoder failed, the host process lost its right
     * to record, an unexpected exception reached the top of the capture loop.
     * Everything recorded up to that point is still worth exactly as much as it
     * was a second earlier, so it is saved and uploaded too — the difference is
     * that the UI is told the meeting was cut short.
     */
    INTERRUPTED,

    /** The user threw the recording away. The only ending that deletes. */
    DISCARDED,

    /**
     * The session is being let go after the UI has acknowledged a terminal
     * state. The audio has already been finished and handed to the upload queue
     * (or already deleted); there is nothing left to decide, so this must not
     * touch the file — a release that deletes is how a saved recording
     * disappears a second after it was saved.
     */
    RELEASED,
}

/** True when this ending must close the container and enqueue the upload. */
val CaptureEnding.savesAudio: Boolean
    get() = this == CaptureEnding.COMPLETED || this == CaptureEnding.INTERRUPTED

/** True when this ending deletes the partial file. Exactly one ending does. */
val CaptureEnding.deletesAudio: Boolean
    get() = this == CaptureEnding.DISCARDED

/**
 * The terminal [MeetingState] for a capture that has finished winding down.
 *
 * Pure on purpose: this is the branch that decides whether the user is shown an
 * error screen or a saved recording, and it is worth being able to test without
 * a microphone.
 *
 * @param recordingId the id the upload queue accepted, or null when it refused
 *   the capture as too short to be a meeting.
 * @param pendingUpload true when the recording is on the device but not yet in
 *   the cloud — a normal offline outcome, not a failure.
 * @param interruptedBy why the capture ended early, or null when the user ended
 *   it. A capture that was interrupted *and* had nothing worth saving is the one
 *   case that still reports a failure: there is no recording to point at, so the
 *   reason is all the user can be given.
 */
fun terminalStateFor(
    recordingId: String?,
    pendingUpload: Boolean,
    interruptedBy: MeetingFailure?,
    detail: String? = null,
): MeetingState = when {
    recordingId != null -> MeetingState.Finished(
        recordingId = recordingId,
        pendingUpload = pendingUpload,
        dropped = false,
        interruptedBy = interruptedBy,
    )

    interruptedBy != null -> MeetingState.Failed(interruptedBy, detail)

    // Under two seconds: a tap of the record button, not a meeting.
    else -> MeetingState.Finished(null, pendingUpload = false, dropped = true)
}
