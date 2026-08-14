package com.pathors.parley

import android.app.Application
import android.content.Context
import android.net.Uri
import com.pathors.parley.auth.AuthManager
import com.pathors.parley.cloud.CloudClient
import com.pathors.parley.meeting.ImportSession
import com.pathors.parley.meeting.MeetingSession
import com.pathors.parley.upload.MeetingUploader
import com.pathors.parley.upload.PendingUploadQueue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

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
        container.drainPendingUploads()
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
    val appScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val auth: AuthManager = AuthManager(app)

    /** Bearer-authenticated, and a 401 clears the stored session from one place. */
    val cloud: CloudClient = auth.cloudClient()

    /** Exposed as well as wrapped: the home screen lists what is still waiting. */
    val uploadQueue: PendingUploadQueue = PendingUploadQueue.default(app)

    val uploader: MeetingUploader = MeetingUploader(cloud, uploadQueue)

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

    /** Best-effort upload of everything the queue is holding. Never throws. */
    fun drainPendingUploads() {
        appScope.launch {
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
