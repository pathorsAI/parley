package com.pathors.parley.ime

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.pathors.parley.R
import com.pathors.parley.parleyContainer
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
 * Holds the microphone for one dictation, for as long as it lasts and no longer.
 *
 * ## Why a keyboard needs a foreground service
 *
 * An input method is *never* the top app — the app being typed into is — and
 * since Android 11 an app that is not the top app and has no `microphone`-typed
 * foreground service is fed **silence** by `AudioRecord` rather than an error.
 * So without this service, voice typing would appear to work and would transcribe
 * nothing, which is the worst of the available failures.
 *
 * Starting a foreground service from the background is otherwise forbidden on
 * Android 12+. Android publishes an explicit exemption for the case *"your app
 * is the current input method"*, which is exactly this case and the only reason
 * `startForegroundService` succeeds here. That exemption is also why the session
 * lives in the service rather than in the keyboard view: the platform grants the
 * microphone on the strength of a `startForeground` that has already happened, so
 * the ordering has to be guaranteed, not hoped for. [onStartCommand] posts the
 * notification and *then* constructs [DictationSession], so the microphone can
 * never be opened before the service is foreground.
 *
 * ## The startForeground contract
 *
 * Every path out of [onStartCommand] must have called `startForeground` at least
 * once on this instance before the instance is allowed to stop.
 * `startForegroundService()` promises the platform a notification within a few
 * seconds, and an instance that stops without ever posting one is killed with
 * `ForegroundServiceDidNotStartInTimeException` — a crash in the user's face, not
 * a log line. The paths that only want to stop (a stop or cancel action landing
 * on a fresh process, a start that finds nothing to do) therefore go through
 * [ensureForeground] first. This is the same contract `MeetingService` documents
 * at length; read it there.
 *
 * ## Why the session outlives the keyboard view
 *
 * [activeSession] is process-scoped for the same reason `MeetingService`'s is: an
 * input view is destroyed and recreated as the user moves between fields and as
 * the configuration changes, and a dictation must not die with a view. The
 * session stays in [activeSession] after it reaches a terminal state so the input
 * method can read the final text and commit it; [clear] is what lets it go. The
 * input method calls it once the words are in the field, or to abandon a session
 * that is no longer the current field's (see [DictationFieldGate]). Every session
 * carries the token of the field it was started in, and a start request never
 * adopts a finished session or one from another field ([DictationAdoption]).
 */
class DictationService : Service() {

    /** True once `startForeground` has been called on this instance. */
    @Volatile
    private var inForeground = false

    /**
     * Watches the session this instance started. Main-immediate so a terminal
     * state is acted on in the same frame the session publishes it.
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
                val session = _activeSession.value
                if (session == null) stopSelfAndForeground() else session.requestStop()
                return START_NOT_STICKY
            }

            ACTION_CANCEL -> {
                ensureForeground()
                val session = _activeSession.value
                if (session == null) stopSelfAndForeground() else session.cancel()
                return START_NOT_STICKY
            }
        }

        val owner = intent?.getLongExtra(EXTRA_OWNER, DictationFieldGate.NO_OWNER)
            ?: DictationFieldGate.NO_OWNER
        val existing = _activeSession.value
        when (DictationAdoption.decide(existing?.state?.value, existing?.ownerToken ?: DictationFieldGate.NO_OWNER, owner)) {
            DictationAdoption.Action.ADOPT -> {
                // The same field asked twice, faster than the first session got
                // anywhere. Watch it rather than open a second microphone.
                ensureForeground()
                observe(existing!!)
                return START_NOT_STICKY
            }

            // A session nobody will ever commit (its keyboard died with it, so it
            // sat finished in activeSession), or a live one from another field.
            // Handing either to this caller would type its words into a field
            // they were never meant for.
            DictationAdoption.Action.REPLACE -> {
                if (_activeSession.compareAndSet(existing, null)) existing?.dispose()
            }

            DictationAdoption.Action.START -> Unit
        }

        // Order is load-bearing: foreground first, microphone second. See the
        // class docs.
        val container = applicationContext.parleyContainer
        val session = DictationSession(
            context = applicationContext,
            auth = container.auth,
            cloud = container.cloud,
            settings = VoiceTypingSettings(applicationContext),
            ownerToken = owner,
        )
        val foreground = ensureForeground()
        _activeSession.value = session
        observe(session)
        if (foreground) {
            session.start()
        } else {
            // Without a microphone-typed foreground service AudioRecord would
            // only hand back silence. Fail visibly instead of transcribing nothing.
            session.refuse(DictationFailure.MIC_UNAVAILABLE)
        }
        return START_NOT_STICKY
    }

    /**
     * Post the ongoing notification if this instance has not already. The guard
     * against stopping without ever having started foreground — see the class
     * docs.
     */
    private fun ensureForeground(): Boolean {
        if (inForeground) return true
        return try {
            createChannel()
            startForegroundNotification()
            true
        } catch (e: IllegalStateException) {
            // ForegroundServiceStartNotAllowedException (API 31+) is one of these.
            Log.w(TAG, "foreground start refused", e)
            false
        } catch (e: SecurityException) {
            // A microphone-typed foreground service without RECORD_AUDIO (API 34+).
            Log.w(TAG, "foreground start refused", e)
            false
        }
    }

    /**
     * Give the microphone back as soon as the session is done with it.
     *
     * The session is *not* cleared here: the input method still has to read the
     * final text out of it. Only the service stops, which is what releases the
     * microphone and takes the notification down.
     */
    private fun observe(session: DictationSession) {
        observerJob?.cancel()
        observerJob = serviceScope.launch {
            session.state.collect { state ->
                if (state.isTerminal()) stopSelfAndForeground()
            }
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

        // A session still holding the microphone when the service dies has lost
        // its permission to hold it: from here on `AudioRecord` would hand it
        // silence. Stopping is therefore the honest thing, and it is a *stop*
        // rather than a cancel — the words already heard are real and are
        // already on screen as composing text, so the input method still gets to
        // commit them.
        val session = _activeSession.value ?: return
        when (session.state.value) {
            is DictationState.Connecting,
            is DictationState.Listening,
            -> session.requestStop()

            else -> Unit
        }
    }

    private fun startForegroundNotification() {
        val stop = PendingIntent.getService(
            this,
            0,
            Intent(this, DictationService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_recording)
            .setContentTitle(getString(R.string.ime_notification_title))
            .setContentText(getString(R.string.ime_notification_text))
            // No content intent on purpose. Tapping it would launch Parley over
            // the app the user is dictating into, which is the one thing they
            // definitely did not ask for. The Stop action is the only control.
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
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
            getString(R.string.ime_notification_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.ime_notification_channel_description)
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    companion object {
        private const val ACTION_STOP = "com.pathors.parley.action.STOP_DICTATION"
        private const val ACTION_CANCEL = "com.pathors.parley.action.CANCEL_DICTATION"
        private const val EXTRA_OWNER = "com.pathors.parley.extra.DICTATION_OWNER"
        private const val TAG = "DictationService"

        /**
         * Its own channel, not the meeting one. A user who mutes "Meeting
         * recording" has said something about hour-long recordings, not about a
         * keyboard, and the two notifications have nothing in common but the
         * microphone.
         */
        private const val CHANNEL_ID = "voice-typing"

        /** 1001 is `MeetingService`'s. */
        private const val NOTIFICATION_ID = 1002

        @Volatile
        private var instance: DictationService? = null

        private val _activeSession = MutableStateFlow<DictationSession?>(null)

        /**
         * The dictation in progress, or the one that has just ended and whose
         * text has not been committed yet. Process-scoped on purpose — see the
         * class docs.
         */
        val activeSession: StateFlow<DictationSession?> = _activeSession.asStateFlow()

        /**
         * Start dictating. `RECORD_AUDIO` must already be granted — from Android
         * 14 the platform refuses a `microphone`-typed foreground service
         * without it — and the caller must be the current input method, which is
         * what makes the background start legal.
         */
        fun start(context: Context, ownerToken: Long): Boolean = try {
            ContextCompat.startForegroundService(
                context,
                Intent(context, DictationService::class.java).putExtra(EXTRA_OWNER, ownerToken),
            )
            true
        } catch (e: IllegalStateException) {
            // ForegroundServiceStartNotAllowedException (API 31+) is one of these.
            Log.w(TAG, "dictation start refused", e)
            false
        } catch (e: SecurityException) {
            Log.w(TAG, "dictation start refused", e)
            false
        }

        /**
         * Stop talking and settle the text. The session stays until [clear].
         *
         * A direct call, not an intent: the keyboard runs in this process, and a
         * `startForegroundService` that lands after the session has ended and
         * the service has stopped would be a promise of a notification nobody
         * keeps — a crash. The service sees the session end through its observer.
         */
        fun requestStop() {
            _activeSession.value?.requestStop()
        }

        /** Throw the dictation away: nothing is committed. Direct, as [requestStop]. */
        fun requestCancel() {
            _activeSession.value?.cancel()
        }

        /**
         * Let the session go — once the input method has committed its text, or
         * when it is abandoning it — and with it any service instance still
         * standing. With [only], does nothing unless that is still the session.
         */
        fun clear(only: DictationSession? = null) {
            val session = _activeSession.value ?: return
            if (only != null && only !== session) return
            if (!_activeSession.compareAndSet(session, null)) return
            session.dispose()
            instance?.stopSelfAndForeground()
        }
    }
}
