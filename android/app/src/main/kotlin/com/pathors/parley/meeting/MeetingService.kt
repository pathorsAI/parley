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
import com.pathors.parley.BuildConfig
import com.pathors.parley.MainActivity
import com.pathors.parley.R
import com.pathors.parley.parleyContainer
import com.pathors.parley.screenshot.DemoMode
import java.text.DateFormat
import java.util.Date
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
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
 *
 * ## The startForeground contract
 *
 * Every path out of [onStartCommand] must have called `startForeground` at
 * least once on this instance before the instance is allowed to stop.
 * `startForegroundService()` promises the platform a notification within a few
 * seconds, and an instance that stops without ever posting one is killed with
 * `ForegroundServiceDidNotStartInTimeException` — a crash in the user's face,
 * not a log line. The paths that only want to stop (the stop action landing on
 * a fresh process, a start that finds nothing to do, the demo action in a
 * release build) therefore go through [ensureForeground] first: the
 * notification flashes up for an instant, which is cheap, and the process
 * survives, which is not.
 */
class MeetingService : Service() {

    /**
     * True once `startForeground` has been called on this instance. See the
     * class docs — this is the flag the whole contract hangs off. `@Volatile`
     * because [stopRecording] clears it from the application scope's thread
     * once the upload tail has finished.
     */
    @Volatile
    private var inForeground = false

    /**
     * Watches the session this instance started or adopted. Main-immediate so a
     * terminal state is acted on in the same frame the session publishes it.
     */
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var observerJob: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                // The notification action survives the process: this can be the
                // first thing a brand-new instance is asked to do.
                ensureForeground()
                stopRecording()
                return START_NOT_STICKY
            }

            ACTION_DISCARD -> {
                ensureForeground()
                discardRecording()
                return START_NOT_STICKY
            }

            ACTION_DEMO_NOTIFICATION -> {
                // The notification and nothing else — see [startDemoNotification].
                if (!BuildConfig.DEBUG || !DemoMode.isActive) {
                    ensureForeground()
                    stopSelfAndForeground()
                    return START_NOT_STICKY
                }
                createChannel()
                // Back-date the chronometer so it agrees with the elapsed time the
                // demo session is already showing on screen. A video in which the
                // notification says 00:28 while the app says 2:02 reads as a bug.
                val elapsed = intent.getLongExtra(EXTRA_DEMO_ELAPSED_MS, 0L)
                startForegroundNotification(System.currentTimeMillis() - elapsed)
                return START_NOT_STICKY
            }
        }
        val session = _activeSession.value
        when {
            // beginRecording() posts the notification itself, with the
            // recording's own start time — don't ensureForeground() first or the
            // chronometer gets posted twice.
            session == null -> beginRecording()

            session.state.value is MeetingState.Recording ||
                session.state.value is MeetingState.Connecting -> {
                ensureForeground()
                observe(session)
            }

            // A session that has finished but has not been cleared yet (the
            // ~1.2 s the UI takes to acknowledge it). There is nothing to
            // record and nothing to adopt, so all that is left is to leave.
            else -> {
                ensureForeground()
                stopSelfAndForeground()
            }
        }
        return START_NOT_STICKY
    }

    /**
     * Post the ongoing notification if this instance has not already. The
     * guard against stopping without ever having started foreground — see the
     * class docs.
     */
    private fun ensureForeground() {
        if (inForeground) return
        createChannel()
        startForegroundNotification(System.currentTimeMillis())
    }

    /**
     * Stop the service when the session reaches a terminal state on its own.
     *
     * A capture that ends without anyone calling [requestStop] — the microphone
     * was taken, the token expired, the encoder died — leaves the session
     * finished or failed and nothing else happens, so without this the
     * microphone foreground service and its "Recording a meeting" notification
     * would sit there until the user killed the app.
     *
     * [MeetingState.Finished] is watched as well as [MeetingState.Failed]
     * because an interrupted recording now *saves* and therefore finishes, where
     * it used to be thrown away and reported as a failure. The ordinary stop
     * path reaches the same state through [stopRecording], which stops the
     * service itself; both are idempotent, so the overlap is harmless.
     */
    private fun observe(session: MeetingSession) {
        observerJob?.cancel()
        observerJob = serviceScope.launch {
            session.state.collect { state ->
                if (state is MeetingState.Failed || state is MeetingState.Finished) {
                    stopSelfAndForeground()
                }
            }
        }
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
        observe(session)
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

    /**
     * Throw the recording away at the user's request.
     *
     * The counterpart to [stopRecording], and the only path here that destroys
     * anything. Every failure ending now saves instead, so the promise the
     * confirmation dialog makes — nothing is saved or uploaded — has to be kept
     * by an action that says so, not by a side effect of disposal.
     */
    private fun discardRecording() {
        val session = _activeSession.value
        if (session == null) {
            stopSelfAndForeground()
            return
        }
        // The application scope for the same reason [stopRecording] uses it: the
        // session must finish releasing the microphone and deleting the file
        // even though `stopSelf()` is about to take the service down.
        applicationContext.parleyContainer.appScope.launch {
            runCatching { session.discard() }
            _activeSession.value = null
            session.dispose()
            stopSelfAndForeground()
        }
    }

    /** Safe to call twice, and safe to call from [clear] on another thread. */
    private fun stopSelfAndForeground() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        inForeground = false
        stopSelf()
    }

    override fun onDestroy() {
        super.onDestroy()
        if (instance === this) instance = null
        serviceScope.cancel()

        // A session still recording when the service dies (task swiped away, low
        // memory) has lost its permission to hold the microphone. That is one
        // fact, and it used to be treated as two: the capture was torn down
        // *and* the audio deleted, so swiping the app away threw the meeting out
        // with the microphone. Releasing the input and destroying the recording
        // are unrelated decisions — only the first of them follows from the
        // service going away.
        //
        // Deliberately the application scope, not the (already cancelled)
        // service scope: closing the container and writing the upload manifest
        // has to outlive this instance, exactly as the ordinary stop does.
        val session = _activeSession.value ?: return
        val state = session.state.value
        if (state !is MeetingState.Recording && state !is MeetingState.Connecting) return
        applicationContext.parleyContainer.appScope.launch {
            runCatching {
                session.stopInterrupted(
                    MeetingFailure.MIC_UNAVAILABLE,
                    "the recording service was destroyed",
                )
            }
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
        inForeground = true
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
        private const val ACTION_DISCARD = "com.pathors.parley.action.DISCARD_MEETING"
        private const val ACTION_DEMO_NOTIFICATION = "com.pathors.parley.action.DEMO_NOTIFICATION"
        private const val EXTRA_DEMO_ELAPSED_MS = "com.pathors.parley.extra.DEMO_ELAPSED_MS"
        private const val CHANNEL_ID = "meeting-recording"
        private const val NOTIFICATION_ID = 1001

        /**
         * The live instance, so [clear] can stop a service the UI has finished
         * with. `@Volatile` because it is written on the main thread and read
         * from wherever [clear] is called.
         */
        @Volatile
        private var instance: MeetingService? = null

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

        /**
         * Show the real ongoing notification without recording anything — debug
         * builds in demo mode only.
         *
         * Google Play's foreground-service declaration requires a video of the
         * ongoing notification, and demo mode otherwise never starts this service
         * at all (`MeetingScreen` swaps in `DemoMeetingSession`), so the shot Play
         * cares about most would be the one shot impossible to capture. This runs
         * the genuine article — same channel, same chronometer, same stop action,
         * same `FOREGROUND_SERVICE_TYPE_MICROPHONE` — with no [MeetingSession]
         * behind it, so demo mode's "no microphone, no network, no residue"
         * promise still holds. Only the transcript on screen is fixture.
         *
         * [elapsedMs] is the time the demo session already claims to have been
         * recording, so the notification's chronometer starts from the same place
         * as the timer on screen instead of from zero.
         *
         * Caller must hold RECORD_AUDIO: from Android 14 the platform refuses a
         * `microphone`-typed foreground service without it. See
         * `android/AppStore/assets/README.md` for the capture procedure.
         */
        fun startDemoNotification(context: Context, elapsedMs: Long = 0L) {
            if (!BuildConfig.DEBUG || !DemoMode.isActive) return
            ContextCompat.startForegroundService(
                context,
                Intent(context, MeetingService::class.java)
                    .setAction(ACTION_DEMO_NOTIFICATION)
                    .putExtra(EXTRA_DEMO_ELAPSED_MS, elapsedMs),
            )
        }

        /** Stop, save and upload. The session stays in [activeSession] until [clear]. */
        fun requestStop(context: Context) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, MeetingService::class.java).setAction(ACTION_STOP),
            )
        }

        /**
         * Throw the recording away: no file, no upload, no library entry.
         *
         * Distinct from [clear], which only lets go of a session whose fate is
         * already settled. Discarding is a decision, and after the failure paths
         * learned to preserve audio it is the one decision that deletes.
         */
        fun requestDiscard(context: Context) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, MeetingService::class.java).setAction(ACTION_DISCARD),
            )
        }

        /**
         * The UI has read the final state; let the session go — and with it any
         * service instance still standing. A failed capture stops the service
         * through its own state observer, but a start command that raced the
         * clear can leave one behind with nothing to do.
         */
        fun clear() {
            val session = _activeSession.value
            _activeSession.value = null
            session?.dispose()
            instance?.stopSelfAndForeground()
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
