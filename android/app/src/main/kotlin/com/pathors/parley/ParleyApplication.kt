package com.pathors.parley

import android.app.Application
import android.content.Context
import android.net.Uri
import android.util.Log
import com.pathors.parley.auth.AuthManager
import com.pathors.parley.cloud.CloudClient
import com.pathors.parley.meeting.ImportSession
import com.pathors.parley.meeting.MeetingService
import com.pathors.parley.meeting.MeetingSession
import com.pathors.parley.meeting.RecordingFiles
import com.pathors.parley.playback.AudioRetention
import com.pathors.parley.playback.LocalAudioStore
import com.pathors.parley.screenshot.DemoMode
import com.pathors.parley.upload.MeetingUploader
import com.pathors.parley.upload.PendingUploadQueue
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

private const val TAG = "ParleyApplication"

/**
 * The app's single Application instance. It owns [AppContainer]; everything else
 * reaches its dependencies through [Context.parleyContainer].
 */
class ParleyApplication : Application() {

    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        // Rather than a bare drain: see [AppContainer.adoptOrphanedRecordings]
        // for why launch is the only safe moment to go looking for a recording
        // the last process died in the middle of. The sweep drains afterwards.
        container.adoptOrphanedRecordings()
    }
}

/**
 * A hand-written service locator — the whole dependency graph of the app, built
 * once per process.
 *
 * No DI framework on purpose: there are exactly four long-lived objects here, and
 * a phone app that starts a foreground service wants its wiring to be readable in
 * one screen rather than spread across generated components.
 */
class AppContainer(private val app: Application) {

    /**
     * Long-lived work that must outlive any single screen or service: the
     * pending-upload drain, and the "stop the meeting, then upload it" tail that
     * keeps running while [com.pathors.parley.meeting.MeetingService] is shutting
     * itself down.
     */
    val appScope: CoroutineScope = CoroutineScope(
        SupervisorJob() + Dispatchers.Default +
            // A SupervisorJob keeps these jobs from cancelling each other, but an
            // exception none of them handles still reaches the thread's default
            // handler and kills the process. The "stop the meeting, then upload
            // it" tail runs here, so that would be a crash at the worst possible
            // moment — just as a recording is being saved.
            CoroutineExceptionHandler { _, t -> Log.e(TAG, "unhandled in app scope", t) },
    )

    val auth: AuthManager = AuthManager(app)

    /** Bearer-authenticated, and a 401 clears the stored session from one place. */
    val cloud: CloudClient = auth.cloudClient()

    /** Exposed as well as wrapped: the home screen lists what is still waiting. */
    val uploadQueue: PendingUploadQueue = PendingUploadQueue.default(app)

    /** The recordings whose audio is on this phone, playable without a download. */
    val localAudio: LocalAudioStore = LocalAudioStore.default(app)

    /** "Keep audio on this phone" — read by the uploader, toggled in the account sheet. */
    val audioRetention: AudioRetention = AudioRetention(app)

    val uploader: MeetingUploader = MeetingUploader(
        cloud = cloud,
        queue = uploadQueue,
        localAudio = localAudio,
        keepsAudioOnPhone = audioRetention::keepsAudioOnPhoneNow,
    )

    /**
     * The last sign-in callback error code (never display copy — the UI maps it),
     * cleared when a sign-in attempt starts or succeeds.
     */
    private val _authError = MutableStateFlow<String?>(null)
    val authError: StateFlow<String?> = _authError.asStateFlow()

    /**
     * The import currently running, if any. Application-scoped rather than
     * screen-scoped so a rotation or a trip to the home screen does not abandon a
     * half-transcribed file.
     */
    private val _activeImport = MutableStateFlow<ImportSession?>(null)
    val activeImport: StateFlow<ImportSession?> = _activeImport.asStateFlow()

    fun setAuthError(code: String?) {
        _authError.value = code
    }

    /** Called after a successful sign-in callback: push anything that was waiting. */
    fun onSignedIn() {
        _authError.value = null
        drainPendingUploads()
    }

    /**
     * Claim any Ogg file left behind by a recording that never finished, then
     * drain the queue — which by then includes whatever was just claimed.
     *
     * Runs from `Application.onCreate` and nowhere else. A live recording writes
     * its Ogg into the very directory this scans, so adopting one would move the
     * file out from under the encoder; "before anything has had a chance to
     * start recording" is the only guarantee available, and it is a guarantee
     * only at launch. iOS calls its equivalent from exactly one place for
     * exactly this reason (`App/Parley/AppState.swift:107`).
     *
     * The adopted recordings carry **no transcript**, on purpose — see
     * [RecordingFiles.adoptOrphans].
     */
    fun adoptOrphanedRecordings() {
        appScope.launch {
            // Demo mode must not reach the network and must not touch a real
            // user's recordings, the same two reasons [drainPendingUploads] has.
            if (DemoMode.isActive) return@launch
            runCatching {
                RecordingFiles.adoptOrphans(app, uploader) { startedAtMs ->
                    MeetingService.defaultTitle(app, startedAtMs)
                }
                // Logged rather than swallowed: a sweep that fails silently is
                // indistinguishable from a sweep that found nothing, and those
                // are very different facts when someone reports a lost meeting.
            }.onFailure { Log.w(TAG, "could not sweep for orphaned recordings", it) }
            // Sequential rather than parallel with the sweep: a rescued meeting
            // should reach the cloud on the same launch that found it, and
            // enqueueing into a drain already in flight would leave it for next
            // time.
            if (auth.currentToken() == null) return@launch
            runCatching { uploader.drain() }
        }
    }

    /** Best-effort upload of everything the queue is holding. Never throws. */
    fun drainPendingUploads() {
        appScope.launch {
            // Demo mode must not reach the network at all, and must not touch a
            // real user's queue if one happens to exist on this device.
            if (DemoMode.isActive) return@launch
            if (auth.currentToken() == null) return@launch
            runCatching { uploader.drain() }
        }
    }

    /** Build the session a [com.pathors.parley.meeting.MeetingService] will host. */
    fun newMeetingSession(context: Context, title: String): MeetingSession =
        MeetingSession(
            context = context.applicationContext,
            auth = auth,
            uploader = uploader,
            title = title,
        )

    /** Start importing [uri], replacing (and cancelling) any previous import. */
    fun startImport(uri: Uri, title: String): ImportSession {
        _activeImport.value?.cancel()
        val session = ImportSession(
            context = app,
            auth = auth,
            uploader = uploader,
            uri = uri,
            title = title,
        )
        _activeImport.value = session
        session.start()
        return session
    }

    /** Drop the finished (or abandoned) import so the screen can be left behind. */
    fun clearImport() {
        _activeImport.value?.cancel()
        _activeImport.value = null
    }
}

/** The container for this process. Valid from `Application.onCreate` onwards. */
val Context.parleyContainer: AppContainer
    get() = (applicationContext as ParleyApplication).container
