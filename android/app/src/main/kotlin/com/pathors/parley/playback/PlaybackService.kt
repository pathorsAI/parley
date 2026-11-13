package com.pathors.parley.playback

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.pathors.parley.MainActivity
import com.pathors.parley.R
import com.pathors.parley.feedback.Log

private const val TAG = "PlaybackService"

/**
 * The process-wide [PlaybackRoster] of open recording players, and the door
 * into [PlaybackService].
 *
 * Main thread only: every caller is a player (built on the main thread) or the
 * service's own lifecycle.
 */
internal object PlaybackSessions {

    private val roster = PlaybackRoster<MediaSession> { it.player.pause() }

    private var nextId = 0

    /** A session id unique in this process, which Media3 requires per service. */
    fun newId(): String = "parley-playback-${++nextId}"

    fun register(session: MediaSession) = roster.register(session)

    fun unregister(session: MediaSession) = roster.unregister(session)

    /** See [PlaybackRoster.pauseAll]. Called when a meeting starts recording. */
    fun pauseAll() = roster.pauseAll()

    /**
     * Make sure the service is up to host the open players. Called on play —
     * a tap on the screen, so the app is in the foreground and a plain
     * `startService` is allowed. Media3 itself promotes the service to the
     * foreground once the player is actually playing.
     *
     * Not on open: the file finishes downloading whenever it finishes, and a
     * background `startService` throws on Android 8+.
     */
    fun ensureHosted(context: Context) {
        if (!roster.needsHost) return
        try {
            context.startService(Intent(context, PlaybackService::class.java))
        } catch (e: IllegalStateException) {
            // Background start refused. Playback still works on screen; it just
            // will not have a notification until the next play.
            Log.w(TAG, "could not start the playback service", e)
        }
    }

    /** What a tap on the notification opens: the app, on the screen it was left on. */
    fun sessionActivity(context: Context): PendingIntent = PendingIntent.getActivity(
        context,
        0,
        Intent(context, MainActivity::class.java)
            .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK),
        PendingIntent.FLAG_IMMUTABLE,
    )

    /** The newest open player. See [PlaybackRoster.current]. */
    val current: MediaSession? get() = roster.current

    fun attach(host: PlaybackRoster.Host<MediaSession>): Boolean = roster.attach(host)

    fun detach(host: PlaybackRoster.Host<MediaSession>) = roster.detach(host)
}

/**
 * Keeps a recording playing with the screen off or the app in the background,
 * and gives it the standard media notification: play/pause, a seekable
 * timeline, the lock screen and headset buttons. The Android half of iOS's
 * `UIBackgroundModes: audio`.
 *
 * It owns no player. The open recording's `MediaSession` is handed to it by
 * [PlaybackSessions] (see [PlaybackRoster] for why the player stays with the
 * screen), and it stops itself when the last player is released — so leaving
 * the recording's screen takes the notification away with the audio.
 *
 * Not exported: nothing outside the app has a reason to bind it. The system's
 * media controls and Bluetooth buttons reach the session through the platform
 * session token Media3 publishes, not through this service.
 */
@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
class PlaybackService : MediaSessionService(), PlaybackRoster.Host<MediaSession> {

    override fun onCreate() {
        super.onCreate()
        setMediaNotificationProvider(
            DefaultMediaNotificationProvider.Builder(this)
                .setChannelName(R.string.playback_channel_name)
                .build()
                .apply { setSmallIcon(R.drawable.ic_stat_playback) },
        )
        // Restarted by the system with nothing left to play: leave at once
        // rather than idle with no player and no notification.
        if (!PlaybackSessions.attach(this)) stopSelf()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? =
        PlaybackSessions.current

    override fun host(session: MediaSession) = addSession(session)

    override fun unhost(session: MediaSession) {
        // Guarded: Media3 drops a session from the service on its own when the
        // session is released, and removing it twice throws.
        if (isSessionAdded(session)) removeSession(session)
    }

    override fun finish() = pauseAllPlayersAndStopSelf()

    /**
     * Swiped out of recents: stop, playing or not. The activity — and with it
     * the screen whose player this is — is gone, so a recording still talking
     * would have nothing left on screen to stop it with.
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        pauseAllPlayersAndStopSelf()
    }

    override fun onDestroy() {
        PlaybackSessions.detach(this)
        // The sessions outlive the service (their screens own them); unhook them
        // so they do not keep pointing at a dead notification manager.
        sessions.forEach(::unhost)
        super.onDestroy()
    }
}
