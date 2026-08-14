package com.pathors.parley.meeting

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.pathors.parley.MainActivity
import com.pathors.parley.R
import com.pathors.parley.parleyContainer
import java.text.DateFormat
import java.util.Date
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Keeps a [MeetingSession] recording while the app is in the background.
 *
 * Android will feed a backgrounded app silence (or kill it) unless a
 * `microphone`-typed foreground service is running, so the service *is* the
 * recording as far as the platform is concerned. It owns no state of its own: the
 * session lives in [activeSession] so a screen can rebind to a recording that
 * started before it existed, and the session's own scope keeps the upload running
 * after the service has stopped itself.
 *
 * Started with [start] once RECORD_AUDIO is granted; stopped with [requestStop].
 */
class MeetingService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopRecording()
                return START_NOT_STICKY
            }
        }
        if (_activeSession.value == null) beginRecording()
        return START_NOT_STICKY
    }

    private fun beginRecording() {
        createChannel()
        val startedAt = System.currentTimeMillis()
        startForegroundNotification(startedAt)
        val session = applicationContext.parleyContainer.newMeetingSession(
            context = applicationContext,
            title = defaultTitle(this, startedAt),
        )
        _activeSession.value = session
        session.start()
    }

    private fun stopRecording() {
        val session = _activeSession.value
        if (session == null) {
            stopSelfAndForeground()
            return
        }
        // Deliberately the application scope, not a service scope: `stop()` also
        // finalizes the file and uploads it, and must survive `stopSelf()`.
        applicationContext.parleyContainer.appScope.launch {
            runCatching { session.stop() }
            stopSelfAndForeground()
        }
    }

    private fun stopSelfAndForeground() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        super.onDestroy()
        // A session still recording when the service dies (task swiped away, low
        // memory) has lost its permission to hold the mic — drop it rather than
        // leaving a silent recording running.
        val session = _activeSession.value
        if (session != null && session.state.value is MeetingState.Recording) {
            session.abandon()
        }
    }

    private fun startForegroundNotification(startedAt: Long) {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, MeetingService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_recording)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(getString(R.string.notification_text))
            .setContentIntent(open)
            // The platform renders the elapsed time for us, so nothing has to
            // wake up once a second just to redraw a clock.
            .setWhen(startedAt)
            .setShowWhen(true)
            .setUsesChronometer(true)
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .addAction(0, getString(R.string.action_stop), stop)
            .build()
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            notification,
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
        )
    }

    private fun createChannel() {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.notification_channel_description)
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    companion object {
        private const val ACTION_STOP = "com.pathors.parley.action.STOP_MEETING"
        private const val CHANNEL_ID = "meeting-recording"
        private const val NOTIFICATION_ID = 1001

        private val _activeSession = MutableStateFlow<MeetingSession?>(null)

        /**
         * The meeting currently being recorded, or the one that just finished and
         * has not been acknowledged yet. Process-scoped on purpose: a Service is
         * not a place to hold state a screen needs to survive rotation.
         */
        val activeSession: StateFlow<MeetingSession?> = _activeSession.asStateFlow()

        /** Start recording. RECORD_AUDIO must already be granted. */
        fun start(context: Context) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, MeetingService::class.java),
            )
        }

        /** Stop, save and upload. The session stays in [activeSession] until [clear]. */
        fun requestStop(context: Context) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, MeetingService::class.java).setAction(ACTION_STOP),
            )
        }

        /** The UI has read the final state; let the session go. */
        fun clear() {
            val session = _activeSession.value
            _activeSession.value = null
            session?.dispose()
        }

        /** "Meeting 9 Aug 2025, 15:20" in the device's locale and format. */
        fun defaultTitle(context: Context, atMs: Long): String {
            val stamp = DateFormat
                .getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT)
                .format(Date(atMs))
            return context.getString(R.string.meeting_title_format, stamp)
        }
    }
}
