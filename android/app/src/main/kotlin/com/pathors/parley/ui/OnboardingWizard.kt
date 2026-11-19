package com.pathors.parley.ui

import androidx.activity.compose.BackHandler
import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
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
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.pathors.parley.AppContainer
import com.pathors.parley.R
import com.pathors.parley.screenshot.DemoMode

/**
 * The onboarding, a port of iOS `OnboardingView.swift` — itself the desktop
 * wizard's Cloud route (`src/components/Onboarding.tsx`): say what Parley is,
 * sign in, settle the organization, allow the microphone, check it, tell the
 * AI who the user is, then hand off to a first run.
 *
 * The desktop's Local route has no phone counterpart — recording on the phone
 * always streams through the account's hosted relay — so the account step shows
 * the Local card only to say where it lives.
 */
enum class OnboardingStep(val key: String, @StringRes val title: Int?) {
    INTRO("intro", null),
    ACCOUNT("account", R.string.onboarding_title_account),
    ORG("org", R.string.onboarding_title_org),
    PERMS("perms", R.string.onboarding_title_perms),
    MIC("mic", R.string.onboarding_title_mic),
    CONTEXT("context", R.string.onboarding_title_context),
    DONE("done", null),
    ;

    /** The welcome and done screens are the hero screens: no title bar. */
    val isHero: Boolean get() = this == INTRO || this == DONE

    val next: OnboardingStep get() = entries[minOf(entries.size - 1, ordinal + 1)]
    val previous: OnboardingStep get() = entries[maxOf(0, ordinal - 1)]

    companion object {
        /** The step stored under `onboarding.step`, or null for none or an unknown one. */
        fun fromKey(key: String?): OnboardingStep? = entries.firstOrNull { it.key == key }
    }
}

/** How the user left the wizard. */
enum class OnboardingExit { SKIP, SAMPLE, RECORD }

/** The step a demo route opens on — iOS `OnboardingScenario.step`. */
internal val DemoMode.OnboardingScenario.step: OnboardingStep
    get() = when (this) {
        DemoMode.OnboardingScenario.WELCOME -> OnboardingStep.INTRO
        DemoMode.OnboardingScenario.ACCOUNT, DemoMode.OnboardingScenario.ACCOUNT_CONFIRMED -> OnboardingStep.ACCOUNT
        DemoMode.OnboardingScenario.ORG, DemoMode.OnboardingScenario.ORG_INVITED,
        DemoMode.OnboardingScenario.ORG_JOINED,
        -> OnboardingStep.ORG
        DemoMode.OnboardingScenario.PERMS -> OnboardingStep.PERMS
        DemoMode.OnboardingScenario.MIC -> OnboardingStep.MIC
        DemoMode.OnboardingScenario.CONTEXT -> OnboardingStep.CONTEXT
        DemoMode.OnboardingScenario.DONE -> OnboardingStep.DONE
    }

/**
 * The wizard. Signed out it is the whole screen (`OnboardingScreen`), on the
 * welcome or the account step; signed in, after a sign-in that started here, it
 * covers the library from the account step on (`ParleyRoot`).
 *
 * The organization and microphone-check models are owned here, not by their
 * steps: leaving the microphone step mid-sentence still finishes saving it, and
 * testing again later still knows what the previous run put in.
 */
@Composable
fun OnboardingWizard(
    container: AppContainer,
    start: OnboardingStep,
    hasAccount: Boolean,
    onFinish: (OnboardingExit) -> Unit,
    modifier: Modifier = Modifier,
) {
    val flags = container.onboarding
    val context = LocalContext.current
    var step by rememberSaveable { mutableStateOf(start) }
    val org = remember { OnboardingOrgModel(container.cloud) }
    val micCheck = remember { MicCheckModel(context.applicationContext, container) }

    // A demo route names its step; the saved step never overrides it.
    val scenario by DemoMode.onboarding.collectAsState()
    LaunchedEffect(scenario) {
        scenario?.let { step = it.step }
    }
    LaunchedEffect(step) { flags.setStep(step.key) }
    // Leaving the wizard while the check listens is the same as Stop: what was
    // said is still saved.
    DisposableEffect(micCheck) { onDispose { micCheck.stop() } }

    val go: (OnboardingStep) -> Unit = { step = it }
    // System back walks the steps back, never past the first one this wizard
    // can show: the welcome signed out, the signed-in confirmation after.
    val first = if (hasAccount) OnboardingStep.ACCOUNT else OnboardingStep.INTRO
    BackHandler(enabled = step > first) { go(step.previous) }
    val palette = onboardingPalette()
    val footer = when (step) {
        OnboardingStep.INTRO -> FooterKind.SKIP_START
        OnboardingStep.ACCOUNT -> if (hasAccount) FooterKind.SKIP_START else null
        OnboardingStep.ORG -> if (org.choosing) null else FooterKind.BACK_NEXT
        OnboardingStep.DONE -> null
        else -> FooterKind.BACK_NEXT
    }

    Box(
        modifier
            .fillMaxSize()
            .background(if (step.isHero) palette.heroBackground else MaterialTheme.colorScheme.background),
    ) {
        if (step.isHero) OnboardingHeroBars(palette)
        Column(Modifier.fillMaxSize()) {
            if (step.isHero) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .height(60.dp)
                        .padding(horizontal = 20.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Spacer(Modifier.weight(1f))
                    OnboardingLanguageButton(onHero = true)
                }
            } else {
                OnboardingHeader(step)
            }
            Crossfade(
                targetState = step,
                animationSpec = tween(STEP_FADE_MS),
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
                label = "onboarding-step",
            ) { shown ->
                Box(Modifier.fillMaxSize()) {
                    when (shown) {
                        OnboardingStep.INTRO -> OnboardingIntroStep(container)
                        OnboardingStep.ACCOUNT -> OnboardingAccountStep(
                            container = container,
                            hasAccount = hasAccount,
                            onBack = { go(OnboardingStep.INTRO) },
                        )
                        OnboardingStep.ORG -> OnboardingOrgStep(
                            model = org,
                            onBack = { go(OnboardingStep.ACCOUNT) },
                            onContinue = { go(OnboardingStep.PERMS) },
                        )
                        OnboardingStep.PERMS -> OnboardingPermsStep()
                        OnboardingStep.MIC -> OnboardingMicStep(micCheck)
                        OnboardingStep.CONTEXT -> OnboardingContextStep(container)
                        OnboardingStep.DONE -> OnboardingDoneStep(onFinish)
                    }
                }
            }
            if (footer != null) {
                OnboardingFooter(
                    kind = footer,
                    skipEnabled = hasAccount,
                    onSkip = { onFinish(OnboardingExit.SKIP) },
                    onBack = { go(step.previous) },
                    onNext = { go(step.next) },
                )
            }
        }
    }
}

private const val STEP_FADE_MS = 250

// ── chrome ───────────────────────────────────────────────────────────────────

/**
 * The colours the desktop wizard draws with that the app's theme does not
 * have — iOS `OnboardingPalette`. Light values are the desktop's own; dark ones
 * follow its dark-mode classes.
 */
@Immutable
data class OnboardingPalette(
    val dark: Boolean,
    val heroBackground: Color,
    val ink: Color,
    val inkSoft: Color,
    val secondary: Color,
    val hairline: Color,
    val segment: Color,
    val blueCardTop: Color,
    val blueCardBottom: Color,
    val greyCardTop: Color,
    val greyCardBottom: Color,
    val pill: Color,
    val greenPill: Color,
    val greenInk: Color,
    val bubble: Color,
)

@Composable
fun onboardingPalette(): OnboardingPalette {
    val scheme = MaterialTheme.colorScheme
    val dark = scheme.background.luminance() < 0.5f
    fun pick(light: Long, darkValue: Long) = Color(if (dark) darkValue else light)
    return OnboardingPalette(
        dark = dark,
        heroBackground = pick(0xFFF5F5F5, 0xFF1C1C1E),
        ink = scheme.onSurface,
        inkSoft = scheme.onSurface.copy(alpha = 0.7f),
        secondary = scheme.onSurfaceVariant,
        hairline = pick(0xFFE3E6EC, 0xFF38383A),
        segment = pick(0xFFE6E6E6, 0xFF38383A),
        blueCardTop = pick(0xFFE1F2FD, 0xFF13263D),
        blueCardBottom = pick(0xFFFFFFFF, 0xFF0F1115),
        greyCardTop = pick(0xFFF5F5F5, 0xFF1F2024),
        greyCardBottom = pick(0xFFFAFAFA, 0xFF18191C),
        pill = if (dark) Color(0xFF2A2B30) else Color.White.copy(alpha = 0.7f),
        greenPill = pick(0xFFD9F7E5, 0xFF163D28),
        greenInk = pick(0xFF006A3B, 0xFF6FDBA0),
        bubble = pick(0xFFF5F5F5, 0xFF2A2B30),
    )
}

private data class HeroBar(val inset: Float, val color: Long, val alpha: Float = 1f)

/** The desktop's `IntroHero`, bar for bar: deepest at the edges. iOS `OnboardingHeroBars`. */
private val HERO_BARS = listOf(
    HeroBar(0f, 0xFF1469D4),
    HeroBar(11.01f, 0xFF1979DA),
    HeroBar(19.07f, 0xFF1D86E0),
    HeroBar(26.82f, 0xFF2191E4),
    HeroBar(31.16f, 0xFF2191E4, 0.9f),
    HeroBar(38.45f, 0xFF2AACEF, 0.8f),
    HeroBar(42.48f, 0xFF2DB6F3, 0.7f),
    HeroBar(38.45f, 0xFF2AACEF, 0.8f),
    HeroBar(31.16f, 0xFF259DE9, 0.9f),
    HeroBar(26.82f, 0xFF2191E4),
    HeroBar(19.07f, 0xFF1D86E0),
    HeroBar(11.01f, 0xFF1979DA),
    HeroBar(0f, 0xFF1469D4),
)

/**
 * The blue bars behind the welcome and done screens: thirteen columns, each a
 * vertical fade from the page into its blue and back, 460dp tall and lifted
 * 160dp above the top, so about 300dp of them show (iOS's numbers).
 */
@Composable
fun OnboardingHeroBars(palette: OnboardingPalette = onboardingPalette()) {
    Canvas(
        Modifier
            .fillMaxWidth()
            .height(HERO_FRAME)
            .graphicsLayer { alpha = HERO_OPACITY }
            .clearAndSetSemantics {},
    ) {
        val width = size.width / HERO_BARS.size
        val height = HERO_HEIGHT.toPx()
        val lift = HERO_LIFT.toPx()
        HERO_BARS.forEachIndexed { i, bar ->
            val top = height * bar.inset / 100f - lift
            val barHeight = height * (1f - 2f * bar.inset / 100f)
            val blue = Color(bar.color).copy(alpha = bar.alpha)
            val edge = palette.heroBackground.copy(alpha = bar.alpha)
            drawRect(
                brush = Brush.verticalGradient(listOf(edge, blue, edge), startY = top, endY = top + barHeight),
                topLeft = Offset(i * width, top),
                size = Size(width + 0.5f, barHeight),
            )
        }
    }
}

private val HERO_HEIGHT = 460.dp
private val HERO_LIFT = 160.dp
private val HERO_FRAME = 310.dp
private const val HERO_OPACITY = 0.8f

/** Every step after the welcome: its title, the language, and the progress line. */
@Composable
private fun OnboardingHeader(step: OnboardingStep) {
    Box(
        Modifier
            .fillMaxWidth()
            .height(60.dp),
    ) {
        Row(
            Modifier
                .fillMaxSize()
                .padding(horizontal = 20.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = step.title?.let { stringResource(it) }.orEmpty(),
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.semantics { heading() },
            )
            Spacer(Modifier.weight(1f))
            OnboardingLanguageButton(onHero = false)
        }
        OnboardingProgress(
            reached = step.ordinal,
            total = OnboardingStep.entries.size - 1,
            modifier = Modifier.align(Alignment.BottomCenter),
        )
    }
}

/** One segment per step after the welcome; those reached in the tint. */
@Composable
private fun OnboardingProgress(reached: Int, total: Int, modifier: Modifier = Modifier) {
    val palette = onboardingPalette()
    val primary = MaterialTheme.colorScheme.primary
    val label = stringResource(R.string.onboarding_progress, reached, total)
    Row(
        modifier
            .fillMaxWidth()
            .clearAndSetSemantics { contentDescription = label },
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        repeat(total) { i ->
            Box(
                Modifier
                    .weight(1f)
                    .height(1.dp)
                    .background(if (i < reached) primary else palette.segment),
            )
        }
    }
}

/**
 * The desktop's language menu. Android keeps an app's language in the system's
 * per-app settings (13 and up), so this shows the current one and opens that
 * page — the account sheet's `openLanguageSettings`.
 */
@Composable
private fun OnboardingLanguageButton(onHero: Boolean) {
    val context = LocalContext.current
    val language = LocalConfiguration.current.locales[0].language
    val short = if (language == "zh") "繁中" else "EN"
    val tint = if (onHero) Color.White else onboardingPalette().ink
    val label = stringResource(R.string.onboarding_language)
    Row(
        Modifier
            .clip(RoundedCornerShape(8.dp))
            .clickable { openLanguageSettings(context) }
            .heightIn(min = 32.dp)
            .padding(horizontal = 8.dp)
            .clearAndSetSemantics { contentDescription = label },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(OnboardingIcons.Globe, contentDescription = null, tint = tint, modifier = Modifier.size(14.dp))
        Text(short, style = MaterialTheme.typography.labelSmall, color = tint)
    }
}

private enum class FooterKind { BACK_NEXT, SKIP_START }

/** A hairline above; the way back (or Skip) on the left, the blue way on to the right. */
@Composable
private fun OnboardingFooter(
    kind: FooterKind,
    skipEnabled: Boolean,
    onSkip: () -> Unit,
    onBack: () -> Unit,
    onNext: () -> Unit,
) {
    val hairline = onboardingPalette().hairline
    Row(
        Modifier
            .fillMaxWidth()
            .drawBehind { drawLine(hairline, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx()) }
            .padding(horizontal = 20.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        when (kind) {
            FooterKind.SKIP_START -> {
                OnboardingGhostButton(
                    text = stringResource(R.string.onboarding_skip),
                    onClick = onSkip,
                    enabled = skipEnabled,
                )
                Spacer(Modifier.weight(1f))
                OnboardingBlueButton(
                    text = stringResource(R.string.onboarding_get_started),
                    trailingIcon = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                    onClick = onNext,
                )
            }
            FooterKind.BACK_NEXT -> {
                OnboardingGhostButton(
                    text = stringResource(R.string.onboarding_back),
                    leadingIcon = Icons.AutoMirrored.Filled.KeyboardArrowLeft,
                    onClick = onBack,
                )
                Spacer(Modifier.weight(1f))
                OnboardingBlueButton(
                    text = stringResource(R.string.onboarding_next),
                    trailingIcon = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                    onClick = onNext,
                )
            }
        }
    }
}

// ── buttons and cards shared by the steps ────────────────────────────────────

private val CARD_SHAPE = RoundedCornerShape(8.dp)

/** The desktop's small filled button, a little taller for a finger. */
@Composable
fun OnboardingBlueButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    trailingIcon: ImageVector? = null,
    busy: Boolean = false,
    enabled: Boolean = true,
) {
    val primary = MaterialTheme.colorScheme.primary
    Row(
        modifier
            .clip(CARD_SHAPE)
            .background(primary.copy(alpha = if (enabled) 1f else 0.5f))
            .clickable(enabled = enabled && !busy, onClick = onClick)
            .heightIn(min = 38.dp)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (busy) {
            CircularProgressIndicator(Modifier.size(14.dp), color = Color.White, strokeWidth = 2.dp)
        }
        Text(text, style = MaterialTheme.typography.titleSmall, color = Color.White)
        if (trailingIcon != null && !busy) {
            Icon(trailingIcon, contentDescription = null, tint = Color.White, modifier = Modifier.size(16.dp))
        }
    }
}

/** The desktop's ghost button: text only, an optional chevron. */
@Composable
fun OnboardingGhostButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    leadingIcon: ImageVector? = null,
    enabled: Boolean = true,
) {
    val ink = onboardingPalette().ink
    Row(
        modifier
            .clip(CARD_SHAPE)
            .clickable(enabled = enabled, onClick = onClick)
            .alpha(if (enabled) 1f else 0.4f)
            .heightIn(min = 38.dp)
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (leadingIcon != null) Icon(leadingIcon, contentDescription = null, tint = ink, modifier = Modifier.size(16.dp))
        Text(text, style = MaterialTheme.typography.bodySmall, color = ink)
    }
}

/** The desktop's white button on a grey card ("Continue ›"). */
@Composable
fun OnboardingWhiteButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    trailingIcon: ImageVector? = Icons.AutoMirrored.Filled.KeyboardArrowRight,
    enabled: Boolean = true,
    outlined: Boolean = false,
) {
    val palette = onboardingPalette()
    Row(
        modifier
            .clip(CARD_SHAPE)
            .background(MaterialTheme.colorScheme.background)
            .then(if (outlined) Modifier.border(1.dp, palette.hairline, CARD_SHAPE) else Modifier)
            .clickable(enabled = enabled, onClick = onClick)
            .alpha(if (enabled) 1f else 0.5f)
            .heightIn(min = 36.dp)
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(text, style = MaterialTheme.typography.bodySmall, color = palette.ink)
        if (trailingIcon != null) {
            Icon(trailingIcon, contentDescription = null, tint = palette.ink, modifier = Modifier.size(16.dp))
        }
    }
}

enum class PillStyle { PLAIN, BLUE, GREEN }

/** A soft pill naming a choice or a confirmed fact. */
@Composable
fun OnboardingPill(icon: Painter, label: String, style: PillStyle = PillStyle.PLAIN, tintIcon: Boolean = true) {
    val palette = onboardingPalette()
    val foreground = when (style) {
        PillStyle.PLAIN -> palette.ink
        PillStyle.BLUE -> MaterialTheme.colorScheme.primary
        PillStyle.GREEN -> palette.greenInk
    }
    Row(
        Modifier
            .clip(CircleShape)
            .background(if (style == PillStyle.GREEN) palette.greenPill else palette.pill)
            .padding(horizontal = 12.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(
            painter = icon,
            contentDescription = null,
            tint = if (tintIcon) foreground else Color.Unspecified,
            modifier = Modifier.size(14.dp),
        )
        Text(label, style = MaterialTheme.typography.bodySmall, color = foreground)
    }
}

/**
 * The desktop's line art (the SVGs in `public/onboarding/`, as vector drawables),
 * drawn at its own size from a fixed corner so a taller card never stretches it.
 * Put it in a `matchParentSize()` box that clips.
 */
@Composable
fun OnboardingLineArt(
    @DrawableRes art: Int,
    width: Dp,
    height: Dp,
    offsetX: Dp = 0.dp,
    offsetY: Dp = 0.dp,
    alpha: Float = 1f,
) {
    Image(
        painter = painterResource(art),
        contentDescription = null,
        modifier = Modifier
            .wrapContentSize(Alignment.TopStart, unbounded = true)
            .offset(x = offsetX, y = offsetY)
            .requiredSize(width, height)
            .alpha(alpha),
    )
}

/** The Cloud and Confirm cards' art, the wide one (967 × 200). */
@Composable
fun CloudLines(offsetY: Dp = 0.dp) =
    OnboardingLineArt(R.drawable.onboarding_cloud_lines, 967.53.dp, 200.945.dp, (-444).dp, offsetY)

/** The personal-edition art (774 × 117), also behind the permission row and the mic check. */
@Composable
fun SoloLines(offsetX: Dp, offsetY: Dp, alpha: Float = 1f) =
    OnboardingLineArt(R.drawable.onboarding_solo_lines, 774.649.dp, 117.519.dp, offsetX, offsetY, alpha)

/**
 * One side of an either/or drawn as a card — the desktop's `ChoiceCard`: a
 * pill naming the choice (with an optional note beside it), whatever the
 * choice needs, and the card's own button bottom-right, over a fade and a
 * piece of line art. [primary] is the blue card, otherwise grey.
 */
@Composable
fun OnboardingChoiceCard(
    primary: Boolean,
    pill: @Composable () -> Unit,
    art: @Composable () -> Unit,
    note: String? = null,
    content: @Composable ColumnScope.() -> Unit = {},
    action: @Composable () -> Unit,
) {
    val palette = onboardingPalette()
    val fade = if (primary) {
        listOf(palette.blueCardTop, palette.blueCardBottom)
    } else {
        listOf(palette.greyCardTop, palette.greyCardBottom)
    }
    Box(
        Modifier
            .fillMaxWidth()
            .clip(CARD_SHAPE)
            .background(Brush.verticalGradient(fade)),
    ) {
        ArtLayer(art)
        Column(
            Modifier
                .fillMaxWidth()
                .padding(20.dp),
            horizontalAlignment = Alignment.End,
            verticalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            Column(
                Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(20.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    pill()
                    if (note != null) {
                        Spacer(Modifier.width(12.dp).weight(1f))
                        Text(
                            text = note,
                            style = MaterialTheme.typography.labelMedium,
                            color = palette.inkSoft,
                            textAlign = TextAlign.End,
                            modifier = Modifier.weight(2f),
                        )
                    }
                }
                content()
            }
            action()
        }
    }
}

/** The line art behind a card, clipped by the card. */
@Composable
private fun BoxScope.ArtLayer(art: @Composable () -> Unit) {
    Box(Modifier.matchParentSize()) { art() }
}

/** The "or" between two choice cards. */
@Composable
fun OnboardingOrDivider() {
    val palette = onboardingPalette()
    Row(
        Modifier
            .fillMaxWidth()
            .clearAndSetSemantics {},
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Box(Modifier.weight(1f).height(1.dp).background(palette.segment))
        Text(
            stringResource(R.string.onboarding_or),
            style = MaterialTheme.typography.labelSmall,
            color = palette.secondary,
        )
        Box(Modifier.weight(1f).height(1.dp).background(palette.segment))
    }
}

/**
 * A step's "you're set" card — the desktop's `ConfirmCard`: green pills, a blue
 * title and a grey line, centred over the blue fade and its line art. The
 * caller sizes it through [modifier].
 */
@Composable
fun OnboardingConfirmCard(
    title: String,
    message: String,
    modifier: Modifier = Modifier,
    pills: @Composable () -> Unit,
) {
    val palette = onboardingPalette()
    Box(
        modifier
            .fillMaxWidth()
            .clip(CARD_SHAPE)
            .background(Brush.verticalGradient(listOf(palette.blueCardTop, palette.blueCardBottom))),
        contentAlignment = Alignment.Center,
    ) {
        ArtLayer {
            OnboardingLineArt(R.drawable.onboarding_confirm_lines, 967.661.dp, 415.817.dp, (-444).dp, 0.dp)
        }
        Column(
            Modifier.padding(20.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { pills() }
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text(
                    title,
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.primary,
                    textAlign = TextAlign.Center,
                )
                Text(
                    message,
                    style = MaterialTheme.typography.bodySmall,
                    color = palette.inkSoft,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}
