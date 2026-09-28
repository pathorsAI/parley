package com.pathors.parley.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pathors.parley.AppContainer
import com.pathors.parley.R
import com.pathors.parley.auth.CustomTabsLauncher
import com.pathors.parley.kit.SampleManifest
import com.pathors.parley.ui.theme.ParleyTextStyles
import com.pathors.parley.ui.theme.ParleyTheme
import com.pathors.parley.ui.theme.ThemePreference
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * First run — the screen a cold Play Store install lands on.
 *
 * Recording on the phone streams through the account's hosted transcription
 * relay and syncs to that account, so there is nothing useful to do before
 * signing in. What stood here before was the bare sign-in wall: the app's name,
 * one line of tagline, and a button demanding a Google account from someone who
 * had been told nothing about what the app does. Play's cold traffic arrives with
 * no context at all — the listing sells, this screen has to close.
 *
 * So the account still comes first, but the screen earns it: say what the app
 * does, what signing in buys, and what it costs, before asking. This is the
 * Android half of iOS `OnboardingView.swift`: since onboarding v2 (#450) the
 * three static value points are a short film of the product's four beats
 * ([IntroStage]), played once from the bundled sample recording.
 */
@Composable
fun OnboardingScreen(container: AppContainer) {
    val language = LocalConfiguration.current.locales[0].language
    // The manifest is an APK asset: read off the main thread, once per language.
    val film = produceState<FilmLoad?>(initialValue = null, container, language) {
        value = withContext(Dispatchers.IO) {
            FilmLoad(container.sample.manifest(SampleManifest.langFor(language))?.let(IntroFilm::of))
        }
    }

    Column(Modifier.fillMaxSize()) {
        // The pitch scrolls; the sign-in button does not. At the largest font
        // scales this copy is taller than a phone, and the one control that
        // matters must never be the part that gets pushed off the bottom — the
        // scroller takes whatever height is left over, down to none.
        Pitch(film.value, Modifier.weight(1f))
        CallToActionFrame(CallToActionPadding) {
            SignInCallToAction(container, Modifier.widthIn(max = MAX_CONTENT_WIDTH))
        }
    }
}

/**
 * The part above the button: the film once the manifest is read; until then —
 * a frame or two — the stage's room, so the sign-in block does not jump when it
 * arrives. A build without the sample assets has no film to play and prints the
 * three points it would have shown instead.
 */
@Composable
private fun Pitch(load: FilmLoad?, modifier: Modifier = Modifier) {
    val film = load?.film
    if (film != null) {
        FilmPitch(film, modifier)
        return
    }
    PitchScroll(rememberScrollState(), modifier) {
        if (load != null) {
            IntroPoints(Modifier.widthIn(max = MAX_CONTENT_WIDTH))
        } else {
            Box(Modifier.heightIn(min = STAGE_PLACEHOLDER_HEIGHT))
        }
    }
}

/**
 * The header and the film, scrolling, with the film's caption kept in view.
 *
 * On most phones the header, the stage and the caption together are taller
 * than the room above the pinned button, so a caption laid out under the stage
 * would sit below the fold for the whole film — the one line that says what
 * each beat is. So the caption floats: it sits in its place under the stage
 * when that place is on screen, and otherwise sticks to the bottom of the pitch,
 * just above the button, until scrolling brings its place into view
 * ([stickyCaptionTop]). Its place in the scrolling content is held by a spacer
 * of its height, so scrolling to the end lands it right under the stage. The
 * stage itself never changes height, so neither moves while the film plays.
 */
@Composable
private fun FilmPitch(film: IntroFilm, modifier: Modifier = Modifier, frozenAt: Double? = null) {
    val clock = rememberIntroClock(film, frozenAt)
    val scroll = rememberScrollState()
    val viewportHeight = remember { mutableIntStateOf(0) }
    val captionHeight = remember { mutableIntStateOf(0) }
    val slotTop = remember { mutableFloatStateOf(0f) }
    val density = LocalDensity.current

    Box(
        modifier
            .fillMaxWidth()
            .onSizeChanged { viewportHeight.intValue = it.height },
    ) {
        PitchScroll(scroll, Modifier.fillMaxSize()) {
            IntroStage(film, clock.value, Modifier.widthIn(max = MAX_CONTENT_WIDTH))
            Spacer(Modifier.height(CAPTION_GAP))
            Spacer(
                Modifier
                    .height(with(density) { captionHeight.intValue.toDp() })
                    .onPlaced { slotTop.floatValue = it.positionInParent().y },
            )
        }
        IntroCaption(
            film = film,
            t = clock.value,
            modifier = Modifier
                .align(Alignment.TopCenter)
                .offset {
                    IntOffset(
                        x = 0,
                        y = stickyCaptionTop(
                            slotTop = slotTop.floatValue,
                            scroll = scroll.value,
                            viewportHeight = viewportHeight.intValue,
                            captionHeight = captionHeight.intValue,
                        ),
                    )
                }
                // Unplaced until the stage has been laid out once: a first
                // frame at the top would flash over the header.
                .graphicsLayer { alpha = if (slotTop.floatValue > 0f) 1f else 0f }
                .background(MaterialTheme.colorScheme.background)
                .padding(horizontal = PITCH_PADDING)
                .widthIn(max = MAX_CONTENT_WIDTH)
                .onSizeChanged { captionHeight.intValue = it.height },
        )
    }
}

/** The scrolling column: the header, then [content], centred and inset. */
@Composable
private fun PitchScroll(scroll: ScrollState, modifier: Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier = modifier
            .verticalScroll(scroll)
            .padding(horizontal = PITCH_PADDING),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(24.dp))
        Header()
        Spacer(Modifier.height(28.dp))
        content()
        Spacer(Modifier.height(24.dp))
    }
}

/**
 * The first thing anyone sees of the product, so it is the wordmark rather than
 * a heading that happens to say "Parley": Alexandria, set large, in ink. The
 * waveform above it is drawn rather than shipped as an asset — the app already
 * draws waveforms (`PlaybackBar`), and the icon set we depend on has no glyph
 * for one.
 */
@Composable
private fun Header() {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        WaveformMark()
        Text(
            text = stringResource(R.string.app_name),
            // The one place the wordmark is a hero rather than a label, so it is
            // the only place it grows past `ParleyTextStyles.wordmark`'s size.
            style = ParleyTextStyles.wordmark.copy(fontSize = 34.sp, lineHeight = 42.sp),
            color = MaterialTheme.colorScheme.onSurface,
        )
        Text(
            text = stringResource(R.string.onboarding_headline),
            style = MaterialTheme.typography.titleLarge,
            color = MaterialTheme.colorScheme.onSurface,
            textAlign = TextAlign.Center,
            modifier = Modifier.widthIn(max = MAX_CONTENT_WIDTH),
        )
        Text(
            text = stringResource(R.string.onboarding_subline),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            modifier = Modifier.widthIn(max = MAX_CONTENT_WIDTH),
        )
    }
}

/** Seven rounded bars. Decoration, so it carries no semantics of its own. */
@Composable
private fun WaveformMark() {
    val color = MaterialTheme.colorScheme.onSurfaceVariant
    Canvas(
        Modifier.size(width = 62.dp, height = 26.dp)
    ) {
        val heights = listOf(0.30f, 0.62f, 1f, 0.76f, 1f, 0.55f, 0.28f)
        // Bars and the gaps between them are the same width, so the mark fills
        // its box whatever the box is: 7 bars + 6 gaps = 13 slots.
        val slot = size.width / (heights.size * 2 - 1)
        heights.forEachIndexed { index, fraction ->
            val barHeight = size.height * fraction
            drawRoundRect(
                color = color,
                topLeft = Offset(index * slot * 2f, (size.height - barHeight) / 2f),
                size = Size(slot, barHeight),
                cornerRadius = CornerRadius(slot / 2f),
            )
        }
    }
}

/** The manifest has been read; [film] is null in a build without the sample. */
private class FilmLoad(val film: IntroFilm?)

/** The three points the film makes, as text — the same three TalkBack reads over the film. */
@Composable
private fun IntroPoints(modifier: Modifier = Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        listOf(R.string.intro_point_record, R.string.intro_point_folder, R.string.intro_point_share).forEach {
            Text(
                text = stringResource(it),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/**
 * The pinned bottom block: the button, what sign-in accepts, the consent the app
 * will ask for before it ever records, and the privacy policy.
 *
 * The last one is not a courtesy. Play requires a privacy policy reachable from
 * inside the app, and this screen is the one every install passes through.
 */
@Composable
private fun CallToActionFrame(modifier: Modifier = Modifier, signIn: @Composable () -> Unit) {
    val context = LocalContext.current

    Column(
        modifier = modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        signIn()
        Text(
            text = stringResource(R.string.onboarding_sign_in_methods),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            modifier = Modifier.widthIn(max = MAX_CONTENT_WIDTH),
        )
        TextButton(onClick = { CustomTabsLauncher.launch(context, ParleyLinks.PRIVACY) }) {
            Text(stringResource(R.string.link_privacy_policy))
        }
    }
}

/**
 * The moment between launch and the stored session being read back.
 *
 * What was here was a bare spinner on an empty page. Reading the auth DataStore
 * takes a frame or two, and in that gap a returning user saw an anonymous
 * loading screen — or, on a slow cold start, the onboarding wall flashing by
 * before their session resolved. Naming the app is the whole fix, and it is what
 * iOS `LaunchView` does.
 */
@Composable
fun LaunchScreen() {
    val loading = stringResource(R.string.launch_loading)
    Column(
        modifier = Modifier
            .fillMaxSize()
            .clearAndSetSemantics { contentDescription = loading },
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = stringResource(R.string.app_name),
            style = ParleyTextStyles.wordmark,
            color = MaterialTheme.colorScheme.onSurface,
        )
        Spacer(Modifier.height(18.dp))
        CircularProgressIndicator(Modifier.size(28.dp))
    }
}

/** Copy stops widening past this; a full-width line on a tablet is unreadable. */
private val MAX_CONTENT_WIDTH = 420.dp

/** Roughly the film's height, held while the manifest is read. */
private val STAGE_PLACEHOLDER_HEIGHT = 360.dp

private val PITCH_PADDING = 28.dp
private val CAPTION_GAP = 16.dp
private val CallToActionPadding = Modifier
    .padding(horizontal = PITCH_PADDING)
    .padding(top = 8.dp, bottom = 20.dp)

// ── previews ─────────────────────────────────────────────────────────────────

/**
 * A short phone, 1 s into the film: the pitch overflows, so the caption must
 * sit fully visible just above the button.
 */
@Preview(name = "Sign-in on a short screen, 1 s in", showBackground = true, widthDp = 360, heightDp = 640)
@Composable
private fun OnboardingShortScreenPreview() {
    ParleyTheme(preference = ThemePreference.LIGHT) {
        Surface(color = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxSize()) {
                FilmPitch(previewIntroFilm, Modifier.weight(1f), frozenAt = 1.0)
                CallToActionFrame(CallToActionPadding) {
                    Button(
                        onClick = {},
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 52.dp),
                    ) {
                        Text(stringResource(R.string.sign_in_button))
                    }
                }
            }
        }
    }
}
