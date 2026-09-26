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
import com.pathors.parley.upload.AutoSync
import com.pathors.parley.upload.ManualRetryLedger
import com.pathors.parley.upload.MeetingUploader
import com.pathors.parley.upload.PendingBackfillQueue
import com.pathors.parley.upload.PendingUploadQueue
import com.pathors.parley.upload.TranscriptBackfiller
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
        // From here on, a returning network or a returning user drains the
        // queues too — not only the next cold start.
        container.autoSync.start()
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

    /**
     * Recordings whose live transcript came up short, waiting to be transcribed
     * again in full. Exposed alongside the backfiller because a storage readout
     * has to count these bytes too — they are the same Oggs the upload queue was
     * holding a moment ago.
     */
    val backfillQueue: PendingBackfillQueue = PendingBackfillQueue.default(app)

    /** How many hand-triggered re-transcriptions each recording has spent. */
    val manualRetries: ManualRetryLedger = ManualRetryLedger.default(app)

    val uploader: MeetingUploader = MeetingUploader(
        cloud = cloud,
        queue = uploadQueue,
        backfills = backfillQueue,
        localAudio = localAudio,
        keepsAudioOnPhone = audioRetention::keepsAudioOnPhoneNow,
    )

    /**
     * The transcript safety net. A recording reaches it two ways: automatically,
     * when [uploader] measures the transcript it just pushed against the audio
     * and finds a hole, or because somebody asked.
     */
    val backfiller: TranscriptBackfiller = TranscriptBackfiller(
        cloud = cloud,
        queue = backfillQueue,
        ledger = manualRetries,
        localAudio = localAudio,
        keepsAudioOnPhone = audioRetention::keepsAudioOnPhoneNow,
    )

    /**
     * Drains both queues when a validated network comes back and when the app
     * returns to the foreground. Started from `Application.onCreate`, after the
     * launch-time sweep.
     */
    val autoSync: AutoSync = AutoSync(app, appScope) { drainPendingUploads() }

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

    /**
     * Throw away everything this device is holding for the signed-in account:
     * recordings waiting to upload, recordings waiting to be transcribed again,
     * and the ledger of re-transcriptions they have spent.
     *
     * Account deletion only. Once `DELETE /me` has succeeded there is no account
     * left for any of it to reach, and leaving finished meeting audio on disk
     * would contradict what the confirmation dialog promised — which says
     * "recordings still waiting to upload on this device are discarded too", and
     * a backfill blob is exactly one of those, one step further along.
     *
     * Ordinary sign-out deliberately keeps all three: the same person usually
     * signs back in, and the recordings are still theirs.
     *
     * Blocking file I/O; call it off the main thread.
     */
    fun discardLocalRecordings() {
        uploadQueue.clear()
        backfillQueue.clear()
        manualRetries.clear()
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
            // Then whatever was waiting for a better transcript — including a
            // re-transcription the last process was killed in the middle of.
            drainPendingBackfills()
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
            // An upload that just finished may have queued a backfill, so the
            // two run in this order and not the other.
            drainPendingBackfills()
        }
    }

    /**
     * Best-effort re-transcription of everything the backfill queue is holding.
     * Never throws.
     *
     * Separate from [drainPendingUploads] because the two are different debts: an
     * upload owes the cloud a recording and is urgent; a backfill owes an
     * already-uploaded recording a better transcript and is not. A backfill must
     * never delay or fail an upload.
     */
    fun drainPendingBackfills() {
        appScope.launch {
            if (DemoMode.isActive) return@launch
            if (auth.currentToken() == null) return@launch
            runCatching { backfiller.drain() }
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
            drainBackfills = ::drainPendingBackfills,
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
