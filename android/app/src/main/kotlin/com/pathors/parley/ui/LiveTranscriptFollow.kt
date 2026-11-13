package com.pathors.parley.ui

/**
 * Whether the live transcript keeps itself on the newest line, and whether the
 * "Latest" control is up. iOS `LiveView.followsLive` / `segmentsWhenLeft` (#641).
 *
 * Following is on until the reader drags the transcript away from its end —
 * someone scrolling up mid-meeting is re-reading something, and pulling them
 * back down on every new turn is the one thing an auto-scrolling transcript must
 * not do (the same rule the recording page keeps for playback). It comes back
 * from the "Latest" control, from scrolling back down to the end, and when the
 * next meeting starts.
 *
 * Immutable, and nothing but the decisions: the screen holds one in snapshot
 * state and feeds it what the list reports, so every rule here is testable
 * without a list — see `LiveTranscriptFollowTest`.
 *
 * @property following The transcript scrolls to each new turn as it arrives.
 * @property segmentsWhenLeft How many turns there were when following stopped,
 *   so "Latest" only appears once there is something below the reader they
 *   have not seen.
 * @property atBottom The transcript's last line is in view — the list cannot
 *   scroll any further forward.
 */
internal data class LiveTranscriptFollow(
    val following: Boolean = true,
    val segmentsWhenLeft: Int = 0,
    val atBottom: Boolean = true,
) {

    /**
     * The reader has scrolled away from the end and more has been said since.
     * A reader who scrolled up in a quiet moment is not nagged.
     */
    fun showsLatest(segmentCount: Int): Boolean = !following && segmentCount > segmentsWhenLeft

    /**
     * A drag started. One that starts at the end does not count until it has
     * left it (see [bottomChanged]), so a nudge at the bottom, or the drag that
     * brings the reader back down, does not undo the resume.
     */
    fun dragStarted(segmentCount: Int): LiveTranscriptFollow =
        if (!following || atBottom) this else stopFollowing(segmentCount)

    /**
     * The list reports whether its last line is in view. Scrolling back down to
     * the newest line is asking to follow again; making the reader find a
     * button for it would be a step they already took. Leaving the end only
     * stops following while the reader's finger is on it: the list also leaves
     * the end on its own, every time a turn arrives and before the follow has
     * caught up, and whenever the panel under it is resized.
     */
    fun bottomChanged(atBottom: Boolean, dragging: Boolean, segmentCount: Int): LiveTranscriptFollow =
        when {
            atBottom -> copy(atBottom = true, following = true)
            dragging && following -> stopFollowing(segmentCount).copy(atBottom = false)
            else -> copy(atBottom = false)
        }

    /** The "Latest" control was tapped: back on, and the screen scrolls down. */
    fun jumpedToLatest(): LiveTranscriptFollow = copy(following = true)

    private fun stopFollowing(segmentCount: Int) =
        copy(following = false, segmentsWhenLeft = segmentCount)

    companion object {
        /**
         * A new meeting is a new transcript; whatever the reader was re-reading
         * in the last one is gone.
         */
        val Start = LiveTranscriptFollow()
    }
}
