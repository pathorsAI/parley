package com.pathors.parley.ui

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import com.pathors.parley.AppContainer
import com.pathors.parley.R
import com.pathors.parley.auth.CustomTabsLauncher
import com.pathors.parley.auth.SignInError
import com.pathors.parley.cloud.CloudClient
import com.pathors.parley.cloud.CloudInvitation
import com.pathors.parley.feedback.Log
import com.pathors.parley.kit.SampleManifest
import com.pathors.parley.screenshot.DemoMode
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// The onboarding's steps, one composable each, in the order `OnboardingStep`
// lists them — iOS `OnboardingSteps.swift`. The microphone check is in
// `OnboardingMic.kt`.

private const val TAG = "Onboarding"

/** The scrolling page every step after the welcome sits in, padded 20dp. */
@Composable
private fun StepPage(content: @Composable () -> Unit) {
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(24.dp),
    ) { content() }
}

// ── 1 · welcome ──────────────────────────────────────────────────────────────

@Composable
internal fun OnboardingIntroStep(container: AppContainer) {
    val language = LocalConfiguration.current.locales[0].language
    // The manifest is an APK asset: read off the main thread, once per language.
    val film by produceState<IntroFilm?>(initialValue = null, container, language) {
        value = withContext(Dispatchers.IO) {
            container.sample.manifest(SampleManifest.langFor(language))?.let(IntroFilm::of)
        }
    }
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(start = 24.dp, end = 24.dp, top = 20.dp, bottom = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(32.dp),
    ) {
        Text(
            stringResource(R.string.onboarding_welcome),
            style = MaterialTheme.typography.headlineSmall,
            color = onboardingPalette().ink,
            textAlign = TextAlign.Center,
        )
        val shown = film
        if (shown != null) {
            IntroStage(shown, Modifier.widthIn(max = 420.dp))
        } else {
            // The stage's room while the manifest is read, or in a build without the sample.
            Spacer(Modifier.height(STAGE_PLACEHOLDER))
        }
    }
}

private val STAGE_PLACEHOLDER = 420.dp

// ── 2 · choose how to run Parley ─────────────────────────────────────────────

/**
 * Signed out: the Cloud card (sign in here) over the Local card. The phone only
 * runs on Cloud, so the Local card says where Local lives instead of offering a
 * button. Signed in: the desktop's confirmation card, filling the page.
 */
@Composable
internal fun OnboardingAccountStep(container: AppContainer, hasAccount: Boolean, onBack: () -> Unit) {
    if (hasAccount) AccountConfirmed(container) else AccountChoosing(container, onBack)
}

@Composable
private fun AccountConfirmed(container: AppContainer) {
    val email by produceState(initialValue = "", container) {
        value = if (DemoMode.isActive) {
            DemoMode.user().email
        } else {
            runCatching { container.cloud.me()?.email }.getOrNull().orEmpty()
        }
    }
    FullPageCard { modifier ->
        OnboardingConfirmCard(
            title = stringResource(R.string.onboarding_on_cloud),
            message = stringResource(R.string.onboarding_on_cloud_body),
            modifier = modifier,
        ) {
            OnboardingPill(rememberVectorPainter(Icons.Filled.CheckCircle), email, PillStyle.GREEN)
        }
    }
}

/**
 * A confirmation card filling the page: the whole height between the header
 * and the footer, less the 20dp a step pads it by on each side, never under
 * 150dp. [card] gets the modifier that sizes and pads it.
 */
@Composable
private fun FullPageCard(card: @Composable (Modifier) -> Unit) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val height = maxOf(150.dp, maxHeight - 40.dp)
        Column(Modifier.verticalScroll(rememberScrollState())) {
            card(Modifier.padding(20.dp).height(height))
        }
    }
}

@Composable
private fun AccountChoosing(container: AppContainer, onBack: () -> Unit) {
    val context = LocalContext.current
    val palette = onboardingPalette()
    val flags = container.onboarding
    val signingIn by container.signingIn.collectAsState()
    val error by container.authError.collectAsState()
    var noBrowser by remember { mutableStateOf(false) }

    val signIn = {
        // Only someone who has never finished the onboarding goes on to the
        // rest of it after signing in, and lands back on this step.
        if (!flags.completed.value) flags.setAfterSignIn(true)
        flags.setStep(OnboardingStep.ACCOUNT.key)
        container.setAuthError(null)
        // Sign-in happens in a Custom Tab on our own origin; the redirect to
        // `parley://auth-callback` stores the token, and that is what swaps
        // this screen out. There is no result callback.
        val launched = CustomTabsLauncher.launchSignIn(context, container.auth)
        noBrowser = !launched
        container.setSigningIn(launched)
    }

    StepPage {
        OnboardingChoiceCard(
            primary = true,
            pill = {
                OnboardingPill(
                    rememberVectorPainter(OnboardingIcons.Cloud),
                    stringResource(R.string.onboarding_cloud),
                    PillStyle.BLUE,
                )
            },
            art = { CloudLines() },
            content = {
                Text(
                    stringResource(R.string.onboarding_cloud_body),
                    style = MaterialTheme.typography.bodySmall,
                    color = palette.ink,
                )
            },
        ) {
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                OnboardingBlueButton(
                    text = stringResource(if (signingIn) R.string.sign_in_in_progress else R.string.sign_in_button),
                    trailingIcon = OnboardingIcons.SignIn,
                    busy = signingIn,
                    onClick = signIn,
                )
                if (signingIn) {
                    Text(
                        stringResource(R.string.sign_in_waiting),
                        style = MaterialTheme.typography.labelSmall,
                        color = palette.secondary,
                        textAlign = TextAlign.End,
                    )
                    // The Custom Tab hands nothing back when it is simply
                    // closed, so the way out of "waiting" is an explicit retry.
                    TextButton(onClick = { container.setSigningIn(false) }) {
                        Text(stringResource(R.string.action_retry))
                    }
                }
                val message = when {
                    noBrowser -> stringResource(R.string.sign_in_no_browser)
                    error == SignInError.DIDNT_FINISH -> stringResource(R.string.sign_in_didnt_finish)
                    else -> null
                }
                if (message != null) {
                    Text(
                        message,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.error,
                        textAlign = TextAlign.End,
                    )
                }
            }
        }

        OnboardingOrDivider()

        OnboardingChoiceCard(
            primary = false,
            pill = {
                OnboardingPill(
                    rememberVectorPainter(OnboardingIcons.Laptop),
                    stringResource(R.string.onboarding_local),
                )
            },
            art = {
                OnboardingLineArt(R.drawable.onboarding_local_lines, 774.609.dp, 104.702.dp, 0.dp, 38.dp)
            },
            content = {
                Text(
                    stringResource(R.string.onboarding_local_body),
                    style = MaterialTheme.typography.bodySmall,
                    color = palette.ink,
                )
            },
        ) {
            Row(
                Modifier
                    .heightIn(min = 36.dp)
                    .padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Icon(OnboardingIcons.Laptop, null, tint = palette.secondary, modifier = Modifier.size(14.dp))
                Text(
                    stringResource(R.string.onboarding_desktop_only),
                    style = MaterialTheme.typography.labelMedium,
                    color = palette.secondary,
                )
            }
        }

        Row(verticalAlignment = Alignment.CenterVertically) {
            OnboardingGhostButton(
                text = stringResource(R.string.onboarding_back),
                leadingIcon = Icons.AutoMirrored.Filled.KeyboardArrowLeft,
                onClick = onBack,
                enabled = !signingIn,
            )
            Spacer(Modifier.weight(1f))
            // Play requires a privacy policy reachable from inside the app, and
            // this is the screen every install passes through.
            TextButton(onClick = { CustomTabsLauncher.launch(context, ParleyLinks.PRIVACY) }) {
                Text(stringResource(R.string.link_privacy_policy), style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}

// ── 3 · organization ─────────────────────────────────────────────────────────

/**
 * What the organization step knows: the user's organizations and the
 * invitations still open to them, and whether a join or create is in flight.
 * iOS `OnboardingOrgModel`. Owned by the wizard.
 *
 * The cloud calls are [CloudClient.myOrgs], [CloudClient.myInvitations],
 * [CloudClient.acceptInvitation] and [CloudClient.createOrg] — all of them
 * here, nowhere else in the wizard.
 */
class OnboardingOrgModel(private val cloud: CloudClient) {
    enum class Phase { LOADING, FAILED, CHOOSING, JOINED }

    /** Why the last join or create did not happen; the screen maps it to copy. */
    enum class ActionError { FAILED, NAME_MISSING }

    var phase by mutableStateOf(Phase.LOADING)
        private set
    var invitations by mutableStateOf<List<CloudInvitation>>(emptyList())
        private set
    var joinedNames by mutableStateOf<List<String>>(emptyList())
        private set
    var busy by mutableStateOf(false)
        private set
    var actionError by mutableStateOf<ActionError?>(null)
        private set

    /** The step offers its own buttons (no footer) while loading or choosing. */
    val choosing: Boolean get() = phase == Phase.LOADING || phase == Phase.CHOOSING

    suspend fun load() {
        phase = Phase.LOADING
        actionError = null
        if (DemoMode.isActive) {
            loadDemo()
            return
        }
        try {
            val orgs = cloud.myOrgs()
            val open = cloud.myInvitations()
            show(orgs.map { it.name }, open)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "onboarding: loading organizations failed", e)
            phase = Phase.FAILED
        }
    }

    suspend fun accept(invitation: CloudInvitation) {
        if (busy) return
        busy = true
        actionError = null
        try {
            val name = invitation.organizationName ?: invitation.organizationId
            if (DemoMode.isActive) {
                delay(DEMO_DELAY_MS)
                joined(listOf(name))
                return
            }
            cloud.acceptInvitation(invitation.id)
            val orgs = runCatching { cloud.myOrgs() }.getOrDefault(emptyList())
            joined(if (orgs.isEmpty()) listOf(name) else orgs.map { it.name })
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "onboarding: accepting the invitation failed", e)
            actionError = ActionError.FAILED
        } finally {
            busy = false
        }
    }

    suspend fun create(name: String) {
        if (busy) return
        val trimmed = name.trim()
        if (trimmed.isEmpty()) {
            actionError = ActionError.NAME_MISSING
            return
        }
        busy = true
        actionError = null
        try {
            if (DemoMode.isActive) {
                delay(DEMO_DELAY_MS)
                joined(listOf(trimmed))
                return
            }
            val created = cloud.createOrg(trimmed)
            joined(listOf(created.name))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "onboarding: creating the organization failed", e)
            actionError = ActionError.FAILED
        } finally {
            busy = false
        }
    }

    private fun show(orgNames: List<String>, open: List<CloudInvitation>) {
        if (orgNames.isEmpty()) {
            invitations = open
            phase = Phase.CHOOSING
        } else {
            joined(orgNames)
        }
    }

    private fun joined(names: List<String>) {
        joinedNames = names
        invitations = emptyList()
        phase = Phase.JOINED
    }

    /** The demo never touches the network: each route is a fixture. */
    private fun loadDemo() {
        when (DemoMode.onboarding.value) {
            DemoMode.OnboardingScenario.ORG_JOINED -> joined(DemoMode.orgs().map { it.name })
            DemoMode.OnboardingScenario.ORG_INVITED -> show(emptyList(), DemoMode.invitations())
            else -> show(emptyList(), emptyList())
        }
    }

    private companion object {
        const val DEMO_DELAY_MS = 600L
    }
}

/**
 * Join an organization you were invited to, create one, or carry on as an
 * individual — the desktop's `OrgStep`. Once a member, its confirmation card.
 */
@Composable
internal fun OnboardingOrgStep(model: OnboardingOrgModel, onBack: () -> Unit, onContinue: () -> Unit) {
    val scope = rememberCoroutineScope()
    val palette = onboardingPalette()
    val scenario by DemoMode.onboarding.collectAsState()
    var orgName by rememberSaveable { mutableStateOf("") }
    LaunchedEffect(model, scenario) {
        // A demo route asks for a fixture each time it is opened.
        if (model.phase == OnboardingOrgModel.Phase.LOADING || DemoMode.isActive) model.load()
    }
    val create = { scope.launch { model.create(orgName) } }

    // Joined: the confirmation fills the page, as the signed-in one does.
    if (model.phase == OnboardingOrgModel.Phase.JOINED) {
        FullPageCard { modifier ->
            OnboardingConfirmCard(
                title = stringResource(R.string.onboarding_org_joined),
                message = stringResource(R.string.onboarding_org_joined_body),
                modifier = modifier,
            ) {
                model.joinedNames.forEach { name ->
                    OnboardingPill(rememberVectorPainter(LibraryIcons.Group), name, PillStyle.GREEN)
                }
            }
        }
        return
    }

    StepPage {
        when (model.phase) {
            OnboardingOrgModel.Phase.LOADING -> Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                Text(
                    stringResource(R.string.onboarding_org_checking),
                    style = MaterialTheme.typography.bodySmall,
                    color = palette.secondary,
                )
            }
            OnboardingOrgModel.Phase.FAILED -> Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    stringResource(R.string.onboarding_org_failed),
                    style = MaterialTheme.typography.bodySmall,
                    color = palette.ink,
                )
                OnboardingWhiteButton(
                    text = stringResource(R.string.onboarding_retry),
                    trailingIcon = Icons.Filled.Refresh,
                    outlined = true,
                    onClick = { scope.launch { model.load() } },
                )
            }
            // Drawn by the full-page card above; never reaches the page.
            OnboardingOrgModel.Phase.JOINED -> Unit
            OnboardingOrgModel.Phase.CHOOSING -> {
                model.invitations.forEach { invitation ->
                    InvitationRow(invitation, model.busy) { scope.launch { model.accept(invitation) } }
                }
                OnboardingChoiceCard(
                    primary = true,
                    pill = {
                        OnboardingPill(
                            painterResource(R.drawable.onboarding_org_create),
                            stringResource(R.string.onboarding_org_create),
                            PillStyle.BLUE,
                            tintIcon = false,
                        )
                    },
                    note = stringResource(R.string.onboarding_org_create_note),
                    art = { CloudLines(offsetY = (-5).dp) },
                    content = {
                        OnboardingTextField(
                            value = orgName,
                            onValueChange = { orgName = it },
                            placeholder = stringResource(R.string.onboarding_org_name),
                            onDone = { create() },
                        )
                    },
                ) {
                    OnboardingBlueButton(
                        text = stringResource(R.string.onboarding_org_create_button),
                        trailingIcon = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                        busy = model.busy,
                        onClick = { create() },
                    )
                }
                OnboardingOrDivider()
                OnboardingChoiceCard(
                    primary = false,
                    pill = {
                        OnboardingPill(
                            rememberVectorPainter(Icons.Filled.Person),
                            stringResource(R.string.onboarding_org_solo),
                        )
                    },
                    note = stringResource(R.string.onboarding_org_solo_note),
                    art = { SoloLines(0.dp, 38.dp) },
                ) {
                    OnboardingWhiteButton(
                        text = stringResource(R.string.onboarding_continue),
                        onClick = onContinue,
                        enabled = !model.busy,
                    )
                }
                OnboardingGhostButton(
                    text = stringResource(R.string.onboarding_back),
                    leadingIcon = Icons.AutoMirrored.Filled.KeyboardArrowLeft,
                    onClick = onBack,
                )
            }
        }
        val error = model.actionError
        if (error != null) {
            Text(
                stringResource(
                    when (error) {
                        OnboardingOrgModel.ActionError.FAILED -> R.string.onboarding_org_error
                        OnboardingOrgModel.ActionError.NAME_MISSING -> R.string.onboarding_org_name_missing
                    },
                ),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.error,
            )
        }
    }
}

@Composable
private fun InvitationRow(invitation: CloudInvitation, busy: Boolean, onJoin: () -> Unit) {
    val palette = onboardingPalette()
    Row(
        Modifier
            .fillMaxWidth()
            .border(1.dp, palette.hairline, RoundedCornerShape(8.dp))
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(LibraryIcons.Group, null, tint = palette.secondary, modifier = Modifier.size(16.dp))
        Text(
            stringResource(R.string.onboarding_org_invited, invitation.organizationName ?: invitation.organizationId),
            style = MaterialTheme.typography.bodySmall,
            color = palette.ink,
            modifier = Modifier.weight(1f),
        )
        OnboardingBlueButton(text = stringResource(R.string.onboarding_org_join), busy = busy, onClick = onJoin)
    }
}

/** A single-line field on the page colour, with a hairline — the org name. */
@Composable
private fun OnboardingTextField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    onDone: () -> Unit,
) {
    val palette = onboardingPalette()
    val shape = RoundedCornerShape(8.dp)
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        singleLine = true,
        textStyle = MaterialTheme.typography.bodySmall.copy(color = palette.ink),
        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { onDone() }),
        modifier = Modifier.fillMaxWidth(),
        decorationBox = { inner ->
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(40.dp)
                    .background(MaterialTheme.colorScheme.background, shape)
                    .border(1.dp, palette.hairline, shape)
                    .padding(horizontal = 12.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                if (value.isEmpty()) {
                    Text(placeholder, style = MaterialTheme.typography.bodySmall, color = palette.secondary)
                }
                inner()
            }
        },
    )
}

// ── 4 · permissions ──────────────────────────────────────────────────────────

/**
 * The microphone, the one grant a phone recording needs — the desktop's
 * permissions step with its macOS-only system-audio row left out — and, on
 * Android 13 and up, notifications, which the recording's ongoing notification
 * needs to be seen. Re-read whenever the app comes back to the front, so a
 * grant made in Settings shows up on its own.
 */
@Composable
internal fun OnboardingPermsStep() {
    val palette = onboardingPalette()
    StepPage {
        Text(
            stringResource(R.string.onboarding_perms_body),
            style = MaterialTheme.typography.bodySmall,
            color = palette.ink,
        )
        PermissionRow(
            permission = Manifest.permission.RECORD_AUDIO,
            icon = OnboardingIcons.Mic,
            label = stringResource(R.string.onboarding_perms_mic),
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            PermissionRow(
                permission = Manifest.permission.POST_NOTIFICATIONS,
                icon = OnboardingIcons.Bell,
                label = stringResource(R.string.onboarding_perms_notifications),
            )
        }
    }
}

/**
 * One permission: Grant asks; once the system will not ask again (the
 * rationale flag going false *after* a denial — `MeetingScreen`'s rule), Open
 * Settings goes to the app's page instead; granted is a green check.
 */
@Composable
private fun PermissionRow(
    permission: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
) {
    val context = LocalContext.current
    val palette = onboardingPalette()
    var granted by remember { mutableStateOf(context.isGranted(permission)) }
    var blocked by remember { mutableStateOf(false) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        granted = context.isGranted(permission)
        if (granted) blocked = false
    }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        granted = ok
        val activity = context.hostActivity()
        blocked = !ok && activity != null && !ActivityCompat.shouldShowRequestPermissionRationale(activity, permission)
    }
    val shape = RoundedCornerShape(8.dp)
    Box(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .border(1.dp, palette.hairline, shape),
    ) {
        Box(Modifier.matchParentSize()) { SoloLines((-52).dp, 37.dp) }
        Row(
            Modifier
                .fillMaxWidth()
                .padding(20.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Icon(icon, null, tint = palette.ink, modifier = Modifier.size(18.dp))
            Text(label, style = MaterialTheme.typography.bodySmall, color = palette.ink, modifier = Modifier.weight(1f))
            when {
                granted -> {
                    val allowed = stringResource(R.string.onboarding_perms_allowed)
                    Icon(
                        Icons.Filled.Check,
                        contentDescription = allowed,
                        tint = palette.greenInk,
                        modifier = Modifier.size(18.dp),
                    )
                }
                blocked -> SmallButton(stringResource(R.string.onboarding_perms_open_settings)) {
                    context.startActivity(
                        Intent(
                            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.fromParts("package", context.packageName, null),
                        ).apply { if (context !is Activity) addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) },
                    )
                }
                else -> SmallButton(stringResource(R.string.onboarding_perms_grant)) { launcher.launch(permission) }
            }
        }
    }
}

@Composable
private fun SmallButton(text: String, onClick: () -> Unit) {
    val palette = onboardingPalette()
    val shape = RoundedCornerShape(8.dp)
    Box(
        Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.background)
            .border(1.dp, palette.hairline, shape)
            .clickable(onClick = onClick)
            .heightIn(min = 32.dp)
            .padding(horizontal = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, style = MaterialTheme.typography.labelSmall, color = palette.ink)
    }
}

internal fun Context.isGranted(permission: String): Boolean =
    ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

/** The hosting [Activity], which `shouldShowRequestPermissionRationale` requires. */
private tailrec fun Context.hostActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.hostActivity()
    else -> null
}

// ── 6 · context ──────────────────────────────────────────────────────────────

/**
 * What every meeting prompt should know about the user — the desktop's
 * `ContextStep`: the speaker background as free text (seeded by the microphone
 * check), and the terms transcription should spell right (the personal
 * dictionary, shared with the voice keyboard and the Mac).
 */
@Composable
internal fun OnboardingContextStep(container: AppContainer) {
    val palette = onboardingPalette()
    val flags = container.onboarding
    val lexicon by container.lexicon.lexicon.collectAsState()
    val terms = lexicon.termsByRecency.map { it.text }
    // Local text state, written through: a field fed back from a flow can drop
    // keystrokes between the write and the next frame.
    var background by remember { mutableStateOf(flags.background.value) }
    var newTerm by rememberSaveable { mutableStateOf("") }
    val shape = RoundedCornerShape(8.dp)
    val addTerm = {
        val term = newTerm.trim()
        if (term.isNotEmpty()) {
            container.lexicon.addTerm(term)
            newTerm = ""
        }
    }

    StepPage {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.onboarding_about_you), style = MaterialTheme.typography.bodySmall, color = palette.ink)
            BasicTextField(
                value = background,
                onValueChange = {
                    background = it
                    flags.setBackground(it)
                },
                textStyle = MaterialTheme.typography.bodySmall.copy(color = palette.ink),
                cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                modifier = Modifier.fillMaxWidth(),
                decorationBox = { inner ->
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = 240.dp)
                            .border(1.dp, palette.hairline, shape)
                            .padding(horizontal = 11.dp, vertical = 14.dp),
                    ) {
                        if (background.isEmpty()) {
                            Text(
                                stringResource(R.string.onboarding_about_you_hint),
                                style = MaterialTheme.typography.bodySmall,
                                color = palette.secondary,
                            )
                        }
                        inner()
                    }
                },
            )
        }

        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.onboarding_terms), style = MaterialTheme.typography.bodySmall, color = palette.ink)
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                terms.forEach { term ->
                    TermChip(term) { container.lexicon.removeTerm(term) }
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    val hairline = palette.hairline
                    BasicTextField(
                        value = newTerm,
                        onValueChange = { newTerm = it },
                        singleLine = true,
                        textStyle = MaterialTheme.typography.bodySmall.copy(color = palette.ink),
                        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { addTerm() }),
                        modifier = Modifier.width(120.dp),
                        decorationBox = { inner ->
                            Box(
                                Modifier
                                    .size(width = 120.dp, height = 30.dp)
                                    .drawBehind {
                                        val stroke = 1.dp.toPx()
                                        drawRoundRect(
                                            color = hairline,
                                            topLeft = Offset(stroke / 2, stroke / 2),
                                            size = androidx.compose.ui.geometry.Size(
                                                size.width - stroke,
                                                size.height - stroke,
                                            ),
                                            cornerRadius = CornerRadius(size.height / 2),
                                            style = Stroke(
                                                width = stroke,
                                                pathEffect = PathEffect.dashPathEffect(
                                                    floatArrayOf(3.dp.toPx(), 3.dp.toPx()),
                                                ),
                                            ),
                                        )
                                    }
                                    .padding(horizontal = 10.dp),
                                contentAlignment = Alignment.CenterStart,
                            ) {
                                if (newTerm.isEmpty()) {
                                    Text(
                                        stringResource(R.string.onboarding_terms_add_hint),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = palette.secondary,
                                    )
                                }
                                inner()
                            }
                        },
                    )
                    TextButton(onClick = { addTerm() }, enabled = newTerm.isNotBlank()) {
                        Text(stringResource(R.string.onboarding_terms_add), style = MaterialTheme.typography.labelMedium)
                    }
                }
            }
        }
    }
}

@Composable
private fun TermChip(term: String, onRemove: () -> Unit) {
    val palette = onboardingPalette()
    val remove = stringResource(R.string.onboarding_terms_remove, term)
    Row(
        Modifier
            .height(30.dp)
            .background(palette.bubble, CircleShape)
            .padding(start = 10.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(term, style = MaterialTheme.typography.bodySmall, color = palette.ink)
        Box(
            Modifier
                .size(26.dp)
                .clickable(onClick = onRemove)
                .semantics { contentDescription = remove },
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.Close, null, tint = palette.ink, modifier = Modifier.size(12.dp))
        }
    }
}

// ── 7 · done ─────────────────────────────────────────────────────────────────

@Composable
internal fun OnboardingDoneStep(onFinish: (OnboardingExit) -> Unit) {
    val primary = MaterialTheme.colorScheme.primary
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
        DoneContent(primary, onFinish, Modifier.weight(1f))
        // A quiet way out, pinned to the bottom of the screen: straight to the
        // library, no sample, no recording.
        TextButton(
            onClick = { onFinish(OnboardingExit.SKIP) },
            modifier = Modifier.padding(bottom = 12.dp),
        ) {
            Text(
                stringResource(R.string.onboarding_skip),
                style = MaterialTheme.typography.labelMedium,
                color = primary,
            )
        }
    }
}

@Composable
private fun DoneContent(
    primary: androidx.compose.ui.graphics.Color,
    onFinish: (OnboardingExit) -> Unit,
    modifier: Modifier,
) {
    val palette = onboardingPalette()
    Column(
        modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(start = 24.dp, end = 24.dp, top = 72.dp, bottom = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(36.dp),
    ) {
        Box(
            Modifier
                .size(48.dp)
                .background(palette.greenPill, CircleShape)
                .clearAndSetSemantics {},
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.Check, null, tint = palette.greenInk, modifier = Modifier.size(24.dp))
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(20.dp)) {
            Text(
                stringResource(R.string.onboarding_done_title),
                style = MaterialTheme.typography.headlineSmall,
                color = palette.ink,
                textAlign = TextAlign.Center,
            )
            val lead = stringResource(R.string.onboarding_done_lead)
            val body = stringResource(R.string.onboarding_done_body)
            Text(
                buildAnnotatedString {
                    withStyle(SpanStyle(fontWeight = FontWeight.Medium)) { append(lead) }
                    append("\n")
                    append(body)
                },
                style = MaterialTheme.typography.bodySmall,
                color = palette.ink,
                textAlign = TextAlign.Center,
            )
        }
        // The extra top padding is the arrow's room: it hangs 52dp above the
        // button, and in the 36dp gap alone it ran through the last line of text.
        Row(
            Modifier.padding(top = 20.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            OnboardingGhostButton(
                text = stringResource(R.string.onboarding_start_recording),
                onClick = { onFinish(OnboardingExit.RECORD) },
            )
            Box {
                OnboardingBlueButton(
                    text = stringResource(R.string.onboarding_try_sample),
                    onClick = { onFinish(OnboardingExit.SAMPLE) },
                )
                // The hand-drawn arrow pointing at the button, hung off its
                // top-right corner without taking any room.
                Box(Modifier.matchParentSize()) {
                    ScribbleArrow(
                        color = primary,
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .wrapContentSize(Alignment.TopEnd, unbounded = true)
                            .offset(x = 34.dp, y = (-52).dp)
                            .requiredSize(46.dp, 53.dp),
                    )
                }
            }
        }
    }
}

/**
 * The hand-drawn curly arrow pointing at "Try the sample" — the desktop's
 * `DoneScribbles`, its arrow and arrowhead paths verbatim (46 × 53 box), as iOS
 * `OnboardingScribbleArrow`.
 */
@Composable
private fun ScribbleArrow(color: androidx.compose.ui.graphics.Color, modifier: Modifier) {
    val paths = remember { listOf(SCRIBBLE_ARROW, SCRIBBLE_HEAD).map { PathParser().parsePathString(it).toPath() } }
    Canvas(modifier.clearAndSetSemantics {}) {
        val sx = size.width / SCRIBBLE_WIDTH
        val sy = size.height / SCRIBBLE_HEIGHT
        scale(sx, sy, pivot = Offset.Zero) {
            paths.forEach { path ->
                drawPath(
                    path = path,
                    color = color,
                    // One dp of line, in the path's own units.
                    style = Stroke(width = 1.dp.toPx() / sx, cap = StrokeCap.Round, join = StrokeJoin.Round),
                )
            }
        }
    }
}

private const val SCRIBBLE_WIDTH = 46f
private const val SCRIBBLE_HEIGHT = 53f
private const val SCRIBBLE_ARROW =
    "M45.1053 2.79108C45.3527 3.38198 45.8571 5.99669 45.1422 14.6463C44.6467 20.642 40.1849 25.574 37.8872 27.9471" +
        "C36.0813 29.8122 34.433 30.0106 32.0533 29.9519C31.1936 29.9306 29.473 28.8217 29.1679 27.7333" +
        "C29.0108 27.1728 29.0235 26.554 29.1028 26.0432C29.1821 25.5324 30.041 24.8943 30.6057 24.6671" +
        "C32.0186 24.0986 33.3829 24.5965 34.202 24.9101C36.3476 25.7318 37.2276 28.8162 35.8757 32.7159" +
        "C34.0083 38.1022 30.7533 39.7886 26.7208 42.12C24.537 43.3826 20.7951 44.1904 16.4297 45.5" +
        "C7.35849 47.7429 3.48971 47.8809 2.32167 47.9405C1.78396 47.9657 1.35795 47.9807 1.21032 48.3674"
private const val SCRIBBLE_HEAD =
    "M3.68704 44.0928C3.63566 44.2014 3.26855 44.7322 2.2476 46.2443C1.87908 46.7901 0.741917 48.6045 " +
        "0.499651 48.8477C0.957288 49.048 1.52832 48.4571 3.49006 49.0908C4.23629 49.3319 5.99017 49.8635 " +
        "6.91468 50.3245"
