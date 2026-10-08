package com.pathors.parley

import android.app.Application
import android.content.Context
import android.net.Uri
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.pathors.parley.auth.AuthManager
import com.pathors.parley.auth.SignInError
import com.pathors.parley.cloud.CloudClient
import com.pathors.parley.filing.FilingPass
import com.pathors.parley.filing.SampleFilingTarget
import com.pathors.parley.feedback.DiagnosticsCollector
import com.pathors.parley.feedback.FeedbackCenter
import com.pathors.parley.feedback.FeedbackQueue
import com.pathors.parley.feedback.FeedbackSettings
import com.pathors.parley.feedback.Log
import com.pathors.parley.feedback.PromptGateStore
import com.pathors.parley.feedback.SyncFailureLedger
import com.pathors.parley.feedback.UncaughtCrashRecorder
import com.pathors.parley.kit.ParleyClientHeader
import com.pathors.parley.library.SaveLocationStore
import com.pathors.parley.ime.VoiceTypingSettings
import com.pathors.parley.meeting.ImportSession
import com.pathors.parley.meeting.MeetingService
import com.pathors.parley.meeting.MeetingSession
import com.pathors.parley.meeting.MeetingState
import com.pathors.parley.kit.GettingStartedStep
import com.pathors.parley.meeting.RecordingFiles
import com.pathors.parley.onboarding.AnnouncementStore
import com.pathors.parley.onboarding.GettingStartedStore
import com.pathors.parley.onboarding.LapCelebrations
import com.pathors.parley.onboarding.SampleRecordingStore
import com.pathors.parley.onboarding.WhatsNewPresenter
import com.pathors.parley.onboarding.parleyAnnouncementsStore
import com.pathors.parley.onboarding.parleyOnboardingStore
import com.pathors.parley.meeting.ImportNotice
import com.pathors.parley.playback.AudioDownloads
import com.pathors.parley.playback.AudioRetention
import com.pathors.parley.playback.LocalAudioStore
import com.pathors.parley.screenshot.DemoMode
import com.pathors.parley.upload.AutoSync
import com.pathors.parley.upload.ManualRetryLedger
import com.pathors.parley.upload.MeetingUploader
import com.pathors.parley.upload.PendingBackfillQueue
import com.pathors.parley.upload.PendingUploadQueue
import com.pathors.parley.upload.TranscriptBackfiller
import java.io.File
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.MainScope
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
        // First, before anything else can throw: a crash while the container
        // is being built is exactly the kind nobody would otherwise hear of.
        UncaughtCrashRecorder(AppContainer.crashDirectory(this)).install()
        // Before anything can open a connection — every request to the cloud,
        // the STT socket included, says which build sent it.
        ParleyClientHeader.install(
            platform = ParleyClientHeader.ANDROID,
            versionName = BuildConfig.VERSION_NAME,
            build = BuildConfig.VERSION_CODE.toString(),
        )
        container = AppContainer(this)
        // Rather than a bare drain: see [AppContainer.adoptOrphanedRecordings]
        // for why launch is the only safe moment to go looking for a recording
        // the last process died in the middle of. The sweep drains afterwards.
        container.adoptOrphanedRecordings()
        // From here on, a returning network or a returning user drains the
        // queues too — not only the next cold start.
        container.autoSync.start()
        container.startWhatsNew()
        // The last process's crash, if it had one, and any report that did not
        // get out before it ended.
        container.feedback.handleLaunch()
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

    /**
     * The filing pass (AI title + folder suggestion) every door into a
     * recording runs — the live meeting screen and an import — with the
     * app's UI language and string table.
     */
    val filingPass: FilingPass = FilingPass.create(app, cloud)

    /** Exposed as well as wrapped: the home screen lists what is still waiting. */
    val uploadQueue: PendingUploadQueue = PendingUploadQueue.default(app)

    /** The recordings whose audio is on this phone, playable without a download. */
    val localAudio: LocalAudioStore = LocalAudioStore.default(app)

    /** "Keep audio on this phone" — read by the uploader, toggled in the account sheet. */
    val audioRetention: AudioRetention = AudioRetention(app)

    /**
     * Who is downloading what: the library row's menu, the player and
     * re-transcription all go through this one, so they agree about it.
     */
    val audioDownloads: AudioDownloads = AudioDownloads(
        cloud = cloud,
        store = localAudio,
        scope = appScope,
        isDemo = { DemoMode.isActive },
    )

    /**
     * Recordings whose live transcript came up short, waiting to be transcribed
     * again in full. Exposed alongside the backfiller because a storage readout
     * has to count these bytes too — they are the same Oggs the upload queue was
     * holding a moment ago.
     */
    val backfillQueue: PendingBackfillQueue = PendingBackfillQueue.default(app)

    /** How many hand-triggered re-transcriptions each recording has spent. */
    val manualRetries: ManualRetryLedger = ManualRetryLedger.default(app)

    /**
     * The library's getting-started checklist. Built before anything can sign
     * in, which is what lets it tell an existing user from a new one — see
     * [GettingStartedStore].
     */
    val gettingStarted: GettingStartedStore = GettingStartedStore(
        store = app.parleyOnboardingStore,
        scope = appScope,
        hadStoredSession = { auth.currentToken() != null },
    )

    /**
     * Which What's New announcements this phone is done with. Built before
     * anything can sign in, for the same reason as [gettingStarted]: a fresh
     * install is told apart from an update by whether a session is already
     * stored — see [AnnouncementStore].
     */
    val announcements: AnnouncementStore = AnnouncementStore(
        store = app.parleyAnnouncementsStore,
        scope = appScope,
        bundled = { AnnouncementStore.loadBundled(app) },
        hadStoredSession = { auth.currentToken() != null },
        appVersion = BuildConfig.VERSION_NAME,
        keyboardUsed = { VoiceTypingSettings(app).keyboardUsedNow() },
    )

    /**
     * When the What's New sheet may come up. Process-scoped, because the
     * moments it waits on — a foreground, a deep link — belong to the process
     * and the activity, not to the library screen. Fed by [startWhatsNew] and
     * `MainActivity.handleDeepLink`; drawn by `ui/WhatsNewSheet.kt`.
     */
    val whatsNew: WhatsNewPresenter = WhatsNewPresenter(
        scope = MainScope(),
        decide = announcements::decide,
        markSeen = announcements::markSeen,
        isForeground = {
            ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
        },
        meetingHoldsMic = {
            when (MeetingService.activeSession.value?.state?.value) {
                MeetingState.Connecting, MeetingState.Recording, MeetingState.Finishing -> true
                else -> false
            }
        },
        // Store screenshots are taken in demo mode; a sheet over them would
        // ruin every frame.
        suppressed = { DemoMode.isActive },
    )

    /**
     * Feeds [whatsNew] the process's foreground and background. Called once,
     * from `Application.onCreate` — the main thread, which a lifecycle observer
     * has to be added on.
     */
    fun startWhatsNew() {
        ProcessLifecycleOwner.get().lifecycle.addObserver(
            object : DefaultLifecycleObserver {
                override fun onStart(owner: LifecycleOwner) = whatsNew.foregrounded()
                override fun onStop(owner: LifecycleOwner) = whatsNew.backgrounded()
            },
        )
    }

    /** The bundled sample recording's local-only library entry. */
    val sample: SampleRecordingStore = SampleRecordingStore(
        context = app,
        store = app.parleyOnboardingStore,
        scope = appScope,
        gettingStarted = gettingStarted,
    )

    /**
     * Where the recording page reads the sample's pending filing suggestion
     * and writes its answer: the sample's own store (onboarding v2's
     * `suggestionPending` / `answerSuggestion`).
     */
    val sampleFiling: SampleFilingTarget
        get() = sample

    /** Whether the guided lap's finish has had its burst, per recording. */
    val lapCelebrations: LapCelebrations = LapCelebrations.device(app)

    /** "Default save location" — read by the uploader, chosen in the account sheet. */
    val saveLocation: SaveLocationStore = SaveLocationStore.default(app)

    /**
     * Each queued recording's run of failed syncs — what the library's
     * "keeps failing to sync" prompt and a report's `syncLastError` read.
     */
    val syncFailures: SyncFailureLedger =
        SyncFailureLedger(File(FeedbackCenter.directory(app), "sync-failures.json"))

    val uploader: MeetingUploader = MeetingUploader(
        cloud = cloud,
        queue = uploadQueue,
        backfills = backfillQueue,
        localAudio = localAudio,
        keepsAudioOnPhone = audioRetention::keepsAudioOnPhoneNow,
        onSaved = { gettingStarted.mark(GettingStartedStep.RECORDED) },
        defaultDestination = saveLocation::current,
        onSyncAttempt = { id, failure ->
            if (failure == null) syncFailures.clear(id) else syncFailures.failed(id, failure)
        },
    )

    /**
     * Problem reports: the prompts every screen raises, the crash from the
     * last process, the report sheet, and the queue that gets them to the
     * cloud. See [FeedbackCenter].
     */
    val feedback: FeedbackCenter = FeedbackCenter(
        app = app,
        scope = appScope,
        cloud = cloud,
        settings = FeedbackSettings(app),
        gate = PromptGateStore(File(FeedbackCenter.directory(app), "prompts.json")),
        queue = FeedbackQueue(File(app.filesDir, FeedbackQueue.DIRECTORY_NAME)),
        collector = DiagnosticsCollector(
            context = app,
            pendingUploads = uploadQueue::count,
            syncLastError = { syncFailures.read().lastError },
            signedIn = { auth.currentToken() != null },
        ),
        crashes = UncaughtCrashRecorder(crashDirectory(app)),
        isDemo = { DemoMode.isActive },
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
    val autoSync: AutoSync = AutoSync(app, appScope) {
        drainPendingUploads()
        // Reports go out signed in or not, so this is not inside the drain,
        // which stops at "nobody is signed in".
        feedback.flush()
    }

    /**
     * Why the last sign-in did not finish (never display copy — the UI maps
     * it), cleared when a sign-in attempt starts or succeeds.
     */
    private val _authError = MutableStateFlow<SignInError?>(null)
    val authError: StateFlow<SignInError?> = _authError.asStateFlow()

    /**
     * The import currently running, if any. Application-scoped rather than
     * screen-scoped so a rotation or a trip to the home screen does not abandon a
     * half-transcribed file.
     */
    private val _activeImport = MutableStateFlow<ImportSession?>(null)
    val activeImport: StateFlow<ImportSession?> = _activeImport.asStateFlow()

    /**
     * The import that just landed, for the library's green line above the list
     * (iOS `LibraryView.importNotice`). Set when the finished import's screen is
     * left behind, cleared by the next import or by the library itself.
     */
    private val _importNotice = MutableStateFlow<ImportNotice?>(null)
    val importNotice: StateFlow<ImportNotice?> = _importNotice.asStateFlow()

    fun clearImportNotice() {
        _importNotice.value = null
    }

    fun setAuthError(error: SignInError?) {
        _authError.value = error
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

    /**
     * The sign-in callback stored a token: confirm it is a session the cloud
     * knows (iOS `AppState.completeSignIn`), then push anything that was
     * waiting. A token the cloud refuses is discarded — which puts the sign-in
     * screen back — with "Sign-in didn't finish", rather than leaving the app
     * signed in until the first real call quietly signs it out again. See
     * [SignInError.fromVerification] for what is kept.
     */
    suspend fun completeSignIn() {
        val verdict = SignInError.fromVerification(runCatching { cloud.me() })
        if (verdict != null) {
            auth.clearSession()
            _authError.value = verdict
            return
        }
        onSignedIn()
    }

    /** Called after a sign-in that stuck: push anything that was waiting. */
    fun onSignedIn() {
        _authError.value = null
        drainPendingUploads()
        feedback.flush()
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

    /**
     * Run the filing pass for a recording nobody is looking at yet (an import
     * that just landed) and leave the suggestion on its meta, where the
     * recording page offers it. On the app's scope, so leaving the import
     * screen does not cancel it. Never throws.
     */
    fun suggestFilingInBackground(recordingId: String) {
        appScope.launch {
            if (DemoMode.isActive) return@launch
            filingPass.generateInBackground(recordingId)
        }
    }

    /** Build the session a [com.pathors.parley.meeting.MeetingService] will host. */
    fun newMeetingSession(context: Context, title: String): MeetingSession =
        MeetingSession(
            context = context.applicationContext,
            auth = auth,
            uploader = uploader,
            title = title,
            orgName = { orgId -> cloud.myOrgs().firstOrNull { it.id == orgId }?.name },
        )

    /** Start importing [uri], replacing (and cancelling) any previous import. */
    fun startImport(uri: Uri, title: String): ImportSession {
        _activeImport.value?.cancel()
        _importNotice.value = null
        val session = ImportSession(
            context = app,
            auth = auth,
            uploader = uploader,
            uri = uri,
            title = title,
            drainBackfills = ::drainPendingBackfills,
            defaultDestination = saveLocation::current,
            runFilingPass = ::suggestFilingInBackground,
        )
        _activeImport.value = session
        session.start()
        return session
    }

    /**
     * Drop the finished (or abandoned) import so the screen can be left behind.
     * One that reached the cloud leaves its [importNotice] for the library.
     */
    fun clearImport() {
        val session = _activeImport.value
        ImportNotice.of(session?.title, session?.state?.value)?.let { _importNotice.value = it }
        session?.cancel()
        _activeImport.value = null
    }

    companion object {
        /**
         * Where the uncaught-exception handler leaves a crash for the next
         * launch. A function of the context alone, because the handler is
         * installed before this container exists.
         */
        fun crashDirectory(context: Context): File = File(FeedbackCenter.directory(context), "crashes")
    }
}

/** The container for this process. Valid from `Application.onCreate` onwards. */
val Context.parleyContainer: AppContainer
    get() = (applicationContext as ParleyApplication).container
