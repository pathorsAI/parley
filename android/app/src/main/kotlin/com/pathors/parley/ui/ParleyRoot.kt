package com.pathors.parley.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.pathors.parley.AppContainer
import com.pathors.parley.R
import com.pathors.parley.meeting.EndedMeetings
import com.pathors.parley.meeting.MeetingChoices
import com.pathors.parley.meeting.MeetingDraft
import com.pathors.parley.meeting.MeetingService
import com.pathors.parley.meeting.MeetingState
import com.pathors.parley.quickrecord.QuickRecord
import com.pathors.parley.quickrecord.QuickRecordInbox
import com.pathors.parley.screenshot.DemoMode
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/** The four places the app can be. */
private object Route {
    const val HOME = "home"

    /**
     * The record screen, and — as an optional argument — whether the visit
     * starts a meeting on arrival (the lock-screen tile, the launcher
     * shortcut, the onboarding's "record now"), as if Start had been pressed.
     * Absent is the screen before a meeting, where the next one is named and
     * filed and Start recording begins it.
     */
    const val ARG_START = "start"
    const val MEETING = "meeting?$ARG_START={$ARG_START}"

    fun meeting(start: Boolean = false): String = if (start) "meeting?$ARG_START=true" else "meeting"

    const val IMPORT = "import"

    /**
     * A recording, and — as an optional argument — the organization whose
     * library it was opened from. An org recording is read through the org's
     * endpoints under an id of its own, so the detail screen has to know.
     */
    const val ARG_ORG = "org"

    /** What it was opened for — see [OpenFor]. Absent is a plain read. */
    const val ARG_FOR = "for"

    /**
     * Opened as the guided lap's recording — see [LocalLapRecording]. Absent is
     * false.
     */
    const val ARG_GUIDED = "guided"
    const val RECORDING = "recording/{id}?$ARG_ORG={$ARG_ORG}&$ARG_FOR={$ARG_FOR}&$ARG_GUIDED={$ARG_GUIDED}"

    fun recording(
        id: String,
        orgId: String? = null,
        openFor: OpenFor = OpenFor.READ,
        guided: Boolean = false,
    ): String {
        val query = listOfNotNull(
            orgId?.let { "$ARG_ORG=$it" },
            openFor.takeIf { it != OpenFor.READ }?.let { "$ARG_FOR=${it.name}" },
            "$ARG_GUIDED=true".takeIf { guided },
        )
        return if (query.isEmpty()) "recording/$id" else "recording/$id?" + query.joinToString("&")
    }
}

/**
 * What a recording's detail screen was opened *for*, beyond reading it. iOS
 * `RecordingDetailView.Intent`.
 *
 * Onboarding v1's checklist opened a recording to file it or to hand it off.
 * v2 (iOS #450) took those row actions away — the guide bar on the recording
 * teaches the step instead — so nothing opens [FILE] or [SHARE] today; the
 * screen still honours them, as iOS still does.
 */
enum class OpenFor {
    READ,

    /** Ask where to file it once the transcript is up. */
    FILE,

    /** Open the share sheet with the analysis prompt once it is up. */
    SHARE,
    ;

    companion object {
        /** Tolerant of a route argument it does not know: that is a plain read. */
        fun parse(value: String?): OpenFor = entries.firstOrNull { it.name == value } ?: READ
    }
}

/**
 * The whole UI: a sign-in wall in front of a four-screen navigation graph.
 *
 * The wall is driven by whether a token is *stored*, not by whether the cloud
 * answered — being offline must never look like being signed out (see
 * `AuthManager.isSignedIn`). A dead session comes back as a 401, which clears the
 * token from one place and swaps this back to the sign-in screen on its own.
 *
 * The one exception is [DemoMode], which stands the wall down without a token so
 * the store screenshots can be captured. It is debug-only and writes nothing.
 *
 * "Not signed in" is [OnboardingScreen] rather than a bare sign-in form: the
 * signed-out state and first run are the same state on this app — there is
 * nothing to do without an account — and the screen a cold install lands on has
 * to say what the app is before it asks for one.
 */
@Composable
fun ParleyRoot() {
    val container = rememberContainer()
    val signedIn by container.auth.isSignedIn.collectAsState(initial = null)
    val demo by DemoMode.enabled.collectAsState()
    val signingIn by container.signingIn.collectAsState()
    val quickRecord by QuickRecordInbox.shared.requestedAt.collectAsState()
    val demoOnboarding by DemoMode.onboarding.collectAsState()

    // A record request that meets the onboarding wall is dropped, not kept for
    // after sign-in: that is minutes later, on a screen reached for another
    // reason (see QuickRecord, "A request goes stale"). Still reading the token
    // (null) is not signed out — the request waits for the answer.
    LaunchedEffect(signedIn, quickRecord) {
        if (signedIn == false && !demo && quickRecord != null) QuickRecordInbox.shared.take()
    }

    // A meeting started from a draft hides that draft on this phone once it is
    // recording — never before (a start the microphone refused leaves it
    // listed, to try again), and never by deleting it: the phone only reads
    // drafts. Watched here rather than on the record screen, which a fast Back
    // could leave before the microphone opens.
    LaunchedEffect(container) {
        MeetingService.activeSession.collectLatest { session ->
            session?.state?.collect { state ->
                if (state == MeetingState.Recording) {
                    MeetingDraft.choices.value.draftId?.let(container.startedDrafts::markStarted)
                }
            }
        }
    }

    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        // With targetSdk 35+ the window is edge-to-edge whether or not the app
        // asks: the system bars are transparent (themes.xml) and the content is
        // laid out under them and under the camera cutout. The screens are
        // plain Columns and custom bottom bars, not Material components that
        // inset themselves, so the one place every screen passes through takes
        // the safe-drawing insets once. The Surface stays full-bleed so its
        // background is what shows through the bars.
        //
        // The signed-in graph takes all but the top here: its destinations
        // take the top themselves ([ParleyNavHost]), so that the Library's
        // overview can draw its light bars up behind the status bar.
        val navHost = demo && demoOnboarding?.signedOut != true || !demo && signedIn == true
        Box(
            Modifier
                .fillMaxSize()
                .windowInsetsPadding(
                    if (navHost) WindowInsets.safeDrawing.only(BELOW_STATUS_BAR) else WindowInsets.safeDrawing,
                ),
        ) {
            when {
                // The welcome and account frames are of the signed-out wizard.
                demo && demoOnboarding?.signedOut == true -> OnboardingScreen(container)
                demo -> ParleyNavHost(container)
                // Still reading the stored token. Named, not a bare spinner: a
                // returning user must not watch an anonymous loading screen, nor
                // see the onboarding wall flash by before their session resolves.
                signedIn == null -> LaunchScreen()

                signedIn == false -> OnboardingScreen(container)
                else -> ParleyNavHost(container)
            }
            // Over every screen, signed in or not (a crash report does not need an
            // account) — but never over a store screenshot.
            if (!demo) {
                Box(Modifier.matchParentSize().underStatusBarInset()) { FeedbackHost(container.feedback) }
            }
        }
        // The sign-in page's edge glow lives here rather than in
        // `OnboardingScreen` so that it can outlast it: a successful sign-in
        // swaps the page out in one frame, and the glow fades over the library
        // that replaces it, then leaves the composition. Outside the safe-drawing
        // padding, because it belongs to the screen's physical edge. See
        // `AuroraEdgeGlow`.
        AuroraEdgeGlow(onSignInPage = signedIn == false && !demo, signingIn = signingIn)
    }
}

/** Every safe-drawing side but the top, which the signed-in destinations take themselves. */
private val BELOW_STATUS_BAR = WindowInsetsSides.Horizontal + WindowInsetsSides.Bottom

/**
 * The top safe-drawing inset the root left to the signed-in destinations. Every
 * one of them takes it here except the Library, whose overview draws behind the
 * status bar and insets its own content ([HomeScreen]).
 */
@Composable
internal fun Modifier.underStatusBarInset(): Modifier =
    windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top))

@Composable
private fun ParleyNavHost(container: AppContainer) {
    val navController = rememberNavController()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val onboardingStart = rememberSignedInOnboardingStart(container)
    val language = LocalConfiguration.current.locales[0].language

    DemoNavigation(navController, container)
    QuickRecordNavigation(navController)

    // The Storage Access Framework: no storage permission, any provider (Files,
    // Drive, a recorder app), and the grant lives as long as we need the Uri.
    val picker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri: Uri? ->
        if (uri != null) {
            runCatching {
                context.contentResolver.takePersistableUriPermission(
                    uri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION,
                )
            }
            container.startImport(uri, displayNameOf(context, uri))
            navController.navigate(Route.IMPORT)
        }
    }

    NavHost(navController = navController, startDestination = Route.HOME) {
        composable(Route.HOME) {
            HomeScreen(
                onRecord = { navController.openMeeting() },
                onStartRecording = { navController.openMeeting(start = true) },
                onStartDraft = { choices -> navController.startDraft(choices) },
                onImport = { picker.launch(arrayOf("audio/*")) },
                onOpenRecording = { id, orgId, guided ->
                    navController.navigate(Route.recording(id, orgId, guided = guided))
                },
            )
            // What's New after an update: only ever over the signed-in library,
            // and never over the onboarding wizard covering it.
            if (onboardingStart == null) WhatsNewHost(container.whatsNew)
        }
        composable(
            route = Route.MEETING,
            arguments = listOf(
                navArgument(Route.ARG_START) {
                    type = NavType.BoolType
                    defaultValue = false
                },
            ),
        ) { entry ->
            Box(Modifier.underStatusBarInset()) {
                MeetingScreen(
                    autoStart = entry.arguments?.getBoolean(Route.ARG_START) ?: false,
                    onDone = { navController.popBackStack(Route.HOME, inclusive = false) },
                    // End, as on the desktop, ends on the recording's result
                    // page — in place of the record screen, so Back from it is
                    // the Library, the recording's own parent.
                    onEnded = { id -> navController.navigate(Route.recording(id)) { popUpTo(Route.HOME) } },
                )
            }
        }
        composable(Route.IMPORT) {
            Box(Modifier.underStatusBarInset()) {
                ImportScreen(onDone = { navController.popBackStack(Route.HOME, inclusive = false) })
            }
        }
        composable(
            route = Route.RECORDING,
            arguments = listOf(
                navArgument(Route.ARG_ORG) {
                    type = NavType.StringType
                    nullable = true
                    defaultValue = null
                },
                navArgument(Route.ARG_FOR) {
                    type = NavType.StringType
                    nullable = true
                    defaultValue = null
                },
                navArgument(Route.ARG_GUIDED) {
                    type = NavType.BoolType
                    defaultValue = false
                },
            ),
        ) { entry ->
            val guided = entry.arguments?.getBoolean(Route.ARG_GUIDED) ?: false
            CompositionLocalProvider(LocalLapRecording provides guided) {
                Box(Modifier.underStatusBarInset()) {
                    RecordingDetailScreen(
                        recordingId = entry.arguments?.getString("id").orEmpty(),
                        orgId = entry.arguments?.getString(Route.ARG_ORG),
                        openFor = OpenFor.parse(entry.arguments?.getString(Route.ARG_FOR)),
                        onBack = { navController.popBackStack() },
                        // The recording is left behind, so the meeting's "done"
                        // lands back on the library.
                        onStartMeeting = { navController.openMeeting(start = true) },
                    )
                }
            }
        }
    }

    // After a sign-in that started in the wizard, the rest of it covers the
    // library until it is left — iOS `MainTabs.onboardingStart`.
    if (onboardingStart != null) {
        // Over the status bar too, so the Library's light bars, which run up
        // behind it, do not show above the wizard.
        Box(
            Modifier
                .fillMaxSize()
                .background(MaterialTheme.colorScheme.background),
        ) {
            OnboardingWizard(
                container = container,
                start = onboardingStart,
                hasAccount = true,
                onFinish = { exit ->
                    container.onboarding.finish()
                    DemoMode.clearOnboarding()
                    when (exit) {
                        OnboardingExit.SKIP -> Unit
                        OnboardingExit.RECORD -> navController.openMeeting(start = true)
                        // The sample, loaded into the library, opens as the lap's
                        // recording — the checklist's own walk-through, without its pause.
                        OnboardingExit.SAMPLE -> scope.launch {
                            val sample = container.sample.load(language) ?: return@launch
                            navController.navigate(Route.recording(sample.id, guided = true))
                        }
                    }
                },
                modifier = Modifier
                    .fillMaxSize()
                    .underStatusBarInset(),
            )
        }
    }
}

/**
 * Which step to open the signed-in wizard on, or null when there is none to
 * show: where it was left, but never before the signed-in confirmation (except
 * a re-run from the account sheet, which starts at the welcome). Only
 * after a sign-in that started in the wizard (`onboarding.afterSignIn`), so
 * users signed in before it existed never see it. A demo route names its own
 * step. iOS `MainTabs.onboardingStart`.
 */
@Composable
private fun rememberSignedInOnboardingStart(container: AppContainer): OnboardingStep? {
    val afterSignIn by container.onboarding.afterSignIn.collectAsState()
    val savedStep by container.onboarding.step.collectAsState()
    val rerun by container.onboarding.rerun.collectAsState()
    val demo by DemoMode.enabled.collectAsState()
    val scenario by DemoMode.onboarding.collectAsState()
    val current = scenario
    return when {
        current != null -> if (current.signedOut) null else current.step
        demo || !afterSignIn -> null
        // A re-run from the account sheet starts at the welcome.
        rerun && savedStep == OnboardingStep.INTRO.key -> OnboardingStep.INTRO
        else -> {
            val saved = OnboardingStep.fromKey(savedStep) ?: OnboardingStep.ACCOUNT
            if (saved < OnboardingStep.ACCOUNT) OnboardingStep.ACCOUNT else saved
        }
    }
}

/**
 * Drives the navigation graph from `parley://demo/…`, so a screenshot run is a
 * list of URLs rather than a list of taps (input automation on an emulator is
 * unreliable; `am start` is not).
 *
 * The account route only has to reach the library — [HomeScreen] watches the same
 * cue and opens its account sheet.
 */
@Composable
private fun DemoNavigation(navController: NavHostController, container: AppContainer) {
    val navigation by DemoMode.navigation.collectAsState()
    LaunchedEffect(navigation) {
        val target = navigation ?: return@LaunchedEffect
        navController.popBackStack(Route.HOME, inclusive = false)
        when (target.screen) {
            DemoMode.Screen.LIBRARY, DemoMode.Screen.ACCOUNT -> Unit
            DemoMode.Screen.TRANSCRIPT, DemoMode.Screen.MOVE_TO_FOLDER, DemoMode.Screen.REPORT ->
                navController.navigate(Route.recording(DemoMode.FEATURED_ID))
            // An ended meeting lands on its result page, handed over the way
            // the record screen hands a real one.
            DemoMode.Screen.MEETING -> if (target.scenario.isSettled) {
                EndedMeetings.hand(DemoMode.endedMeeting())
                navController.navigate(Route.recording(DemoMode.FEATURED_ID))
            } else {
                navController.navigate(Route.meeting())
            }
            DemoMode.Screen.IMPORT -> navController.navigate(Route.IMPORT)
            // Read straight off the seeded entry rather than the store's flow,
            // which catches up a moment after the route seeded it.
            DemoMode.Screen.SAMPLE, DemoMode.Screen.SHARE_MENU ->
                container.sample.manifestOf(DemoMode.sampleEntry.value)?.let { sample ->
                    // The sample is always the lap's recording (LapRules.isLapRecording).
                    navController.navigate(Route.recording(sample.id, guided = true))
                }
        }
    }
}

/**
 * Takes a `parley://record` request (launcher shortcut, Quick Settings tile)
 * and goes to the meeting screen, which starts the recording itself once the
 * microphone is granted — the same path as the red circle, so a meeting started
 * this way is no different. iOS `LiveView.takeQuickRecord`.
 *
 * Taking clears the request, fresh or not, so nothing here can fire twice for
 * one tap. Where the app already is decides whether to navigate at all; see
 * [QuickRecord.shouldOpenMeeting] for why a live meeting is only brought up.
 */
@Composable
private fun QuickRecordNavigation(navController: NavHostController) {
    val requested by QuickRecordInbox.shared.requestedAt.collectAsState()
    LaunchedEffect(requested) {
        if (requested == null || !QuickRecordInbox.shared.take()) return@LaunchedEffect
        val onMeetingScreen = navController.currentDestination?.route == Route.MEETING
        val meeting = MeetingService.activeSession.value?.state?.value
        if (QuickRecord.shouldOpenMeeting(onMeetingScreen, meeting)) {
            // Over the library, like every other start. A settled meeting
            // screen is replaced, and the new one records again at once: the
            // tile is a press of Start.
            navController.openMeeting(start = true)
        }
    }
}

/**
 * Onto the record screen, over the library. A meeting whose outcome was left
 * on screen (still on the phone, too short) is let go first: this visit is for
 * the next one, not for reading an old one's status again. A meeting still in
 * progress is not touched — the screen adopts it.
 */
private fun NavHostController.openMeeting(start: Boolean = false) {
    MeetingService.activeSession.value?.let { if (isSettled(it.state.value)) MeetingService.clear() }
    navigate(Route.meeting(start)) { popUpTo(Route.HOME) }
}

/**
 * A meeting draft's 開始 — the desktop's `startDraft`
 * (`src/components/home/DraftRow.tsx`). With a meeting already going, nothing
 * starts: the record screen comes up over that meeting, as the desktop refuses
 * a second meeting and brings the first one's window forward. Otherwise the
 * draft's name, folder and context become the next meeting's ([MeetingDraft],
 * the desktop's `takeDraft`) and the record screen opens and starts it, the
 * way the Library's Start recording does — microphone prompt included.
 *
 * Demo mode has no microphone and no meeting service: the demo record screen
 * comes up, and nothing is taken or hidden.
 */
private fun NavHostController.startDraft(choices: MeetingChoices) {
    if (DemoMode.isActive) {
        navigate(Route.meeting()) { popUpTo(Route.HOME) }
        return
    }
    val running = MeetingService.activeSession.value?.state?.value
    if (running != null && !isSettled(running)) {
        openMeeting()
        return
    }
    // A settled meeting left on screen gives way in [openMeeting], which
    // leaves these choices alone.
    MeetingDraft.takeDraft(choices)
    openMeeting(start = true)
}

/** The picked file's own name, which becomes the recording's title. */
private fun displayNameOf(context: Context, uri: Uri): String {
    val fromProvider = runCatching {
        context.contentResolver
            .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { cursor ->
                if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getString(0) else null
            }
    }.getOrNull()
    val name = fromProvider ?: uri.lastPathSegment?.substringAfterLast('/')
    return name?.takeIf { it.isNotBlank() } ?: context.getString(R.string.recording_untitled)
}
