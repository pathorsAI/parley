package com.pathors.parley.ui

import androidx.annotation.StringRes
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pathors.parley.AppContainer
import com.pathors.parley.R
import com.pathors.parley.auth.CustomTabsLauncher
import com.pathors.parley.ui.theme.ParleyTextStyles

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
 * Android half of iOS `OnboardingView.swift`, down to the three value points and
 * the order they are in.
 */
@Composable
fun OnboardingScreen(container: AppContainer) {
    Column(Modifier.fillMaxSize()) {
        // The pitch scrolls; the sign-in button does not. At the largest font
        // scales this copy is taller than a phone, and the one control that
        // matters must never be the part that gets pushed off the bottom — the
        // scroller takes whatever height is left over, down to none.
        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(24.dp))
            Header()
            Spacer(Modifier.height(28.dp))
            Column(
                modifier = Modifier.widthIn(max = MAX_CONTENT_WIDTH),
                verticalArrangement = Arrangement.spacedBy(22.dp),
            ) {
                POINTS.forEachIndexed { index, point -> PointRow(index + 1, point) }
            }
            Spacer(Modifier.height(24.dp))
        }

        CallToAction(
            container = container,
            modifier = Modifier
                .padding(horizontal = 28.dp)
                .padding(top = 8.dp, bottom = 20.dp),
        )
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
            text = stringResource(R.string.onboarding_tagline),
            style = MaterialTheme.typography.bodyMedium,
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

/** One of the three reasons to sign in. */
private data class Point(@StringRes val title: Int, @StringRes val detail: Int)

private val POINTS = listOf(
    Point(R.string.onboarding_point_room, R.string.onboarding_point_room_detail),
    Point(R.string.onboarding_point_live, R.string.onboarding_point_live_detail),
    Point(R.string.onboarding_point_sync, R.string.onboarding_point_sync_detail),
)

/**
 * A numbered row rather than an icon row.
 *
 * iOS marks these with SF Symbols, which cost nothing there. Here the equivalent
 * is `material-icons-extended`, a megabyte of vectors for three glyphs — and this
 * build verifies every dependency's checksum, so adding one is not free either.
 * The numerals also happen to be the better fit: the three points are a sequence
 * (put the phone down, it transcribes, it syncs), and the same restraint iOS
 * applies to its own numbered setup rows.
 */
@Composable
private fun PointRow(number: Int, point: Point) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Text(
            text = number.toString(),
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.End,
            // The number marks the row visually; the row's own text is what a
            // screen reader should read out, without "1." in front of it.
            modifier = Modifier
                .widthIn(min = 16.dp)
                .clearAndSetSemantics {},
        )
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                text = stringResource(point.title),
                style = ParleyTextStyles.bodyEmphasized,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Text(
                text = stringResource(point.detail),
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
private fun CallToAction(container: AppContainer, modifier: Modifier = Modifier) {
    val context = LocalContext.current

    Column(
        modifier = modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        SignInCallToAction(container, Modifier.widthIn(max = MAX_CONTENT_WIDTH))
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
