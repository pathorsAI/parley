package com.pathors.parley.playback

/**
 * The open players, and the service that hosts them while one is.
 *
 * ## Why a roster, and not a service that owns the player
 *
 * The usual Media3 shape puts the `ExoPlayer` inside the `MediaSessionService`
 * and has the screen talk to it through a `MediaController`. That is the right
 * shape for a music app, where the queue outlives every screen. It is the wrong
 * one here, because a recording's player belongs to the recording's screen:
 * leaving the detail screen is how somebody stops it, and the scrubber, the
 * conflated live seek, the edge 2× hold and the highlight jumps all drive the
 * player synchronously from the main thread. A controller in between would make
 * every one of those an asynchronous binder round trip, and would split the
 * player's lifetime from the screen's.
 *
 * So the player stays where it was ([ExoPlaybackEngine], owned by
 * [PlaybackController], owned by the screen's view model), wrapped in a
 * `MediaSession`; this roster is the hand-off that lets [PlaybackService] host
 * those sessions — notification, lock screen, headset buttons, foreground
 * status — without owning any of them. The service is a guest of the player,
 * not the other way round.
 *
 * Generic over the session type so the bookkeeping can be unit-tested without
 * Media3; [PlaybackSessions] is the one real instance. Main thread only, like
 * the players it lists.
 *
 * @param pause how to pause one session's player — see [pauseAll]
 */
internal class PlaybackRoster<S : Any>(private val pause: (S) -> Unit) {

    /** What [PlaybackRoster] needs from the service hosting its sessions. */
    interface Host<S> {
        /** Start showing [session]: its notification, its media buttons. */
        fun host(session: S)

        /** Stop showing [session]. It is about to be released. */
        fun unhost(session: S)

        /** Nothing is open any more: go away. */
        fun finish()
    }

    /** Insertion-ordered, so [current] is the most recently opened player. */
    private val sessions = LinkedHashSet<S>()

    private var host: Host<S>? = null

    /** Whether a player is open and nothing is hosting it yet. */
    val needsHost: Boolean get() = sessions.isNotEmpty() && host == null

    /**
     * The player a system controller (a Bluetooth headset, say) should reach
     * when it asks the service for "the" session: the newest one, which is the
     * screen on top.
     */
    val current: S? get() = sessions.lastOrNull()

    /** A player opened. Hosted at once if the service is already up. */
    fun register(session: S) {
        if (sessions.add(session)) host?.host(session)
    }

    /**
     * A player is being released. The last one out tells the service to stop,
     * which is what takes the notification away with the screen.
     */
    fun unregister(session: S) {
        if (!sessions.remove(session)) return
        val host = host ?: return
        host.unhost(session)
        if (sessions.isEmpty()) host.finish()
    }

    /**
     * The service came up. Hosts every open player.
     *
     * @return false when there is nothing to host — the system restarted the
     *   service on its own, after the screen that wanted it was gone — so the
     *   caller should stop rather than sit in the foreground with no player.
     */
    fun attach(host: Host<S>): Boolean {
        this.host = host
        sessions.forEach(host::host)
        return sessions.isNotEmpty()
    }

    /** The service is going away. A stale host (an older instance) is ignored. */
    fun detach(host: Host<S>) {
        if (this.host === host) this.host = null
    }

    /**
     * Pause every open player. A meeting starting is the caller: the
     * microphone must not record the last meeting playing out of the speaker.
     */
    fun pauseAll() {
        sessions.forEach(pause)
    }
}
