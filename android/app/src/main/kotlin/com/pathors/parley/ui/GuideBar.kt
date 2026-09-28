package com.pathors.parley.ui

import android.content.Context
import android.os.Build
import android.provider.Settings
import android.view.HapticFeedbackConstants
import android.view.View
import androidx.annotation.StringRes
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.rotateRad
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.pathors.parley.R
import com.pathors.parley.kit.GuidedLap
import com.pathors.parley.kit.GuidedLap.Display
import com.pathors.parley.kit.GuidedLap.Step
import com.pathors.parley.kit.LapConfetti
import com.pathors.parley.kit.LapMotion
import com.pathors.parley.ui.theme.ParleyTheme
import kotlinx.coroutines.delay

/** What the guide bar draws. */
@Immutable
class GuideBarState(
    val display: GuidedLap.Display,
    /** The questions step 3 lists — the sample's own, or the generic three. */
    val questions: List<String>,
    /**
     * The folder the recording was just filed into, and whether the same
     * answer renamed it — for the ✓ after step 1. Null says "Filed." alone.
     */
    val filedFolder: String?,
    val renamed: Boolean,
    /**
     * Whether the recording has a suggestion card to point at. Without one,
     * step 1's action opens the folder picker instead.
     */
    val hasSuggestion: Boolean,
)

/** Everything the guide bar can do, wired to the recording page by its owner. */
@Immutable
class GuideBarActions(
    /** Step 1: wash the suggestion card, or open the folder picker when there is none. */
    val showSuggestion: () -> Unit,
    /** Step 2: the Transcript page, scrolled to its first turn, lit. */
    val openTranscript: () -> Unit,
    /** Step 3: the share sheet with the analysis prompt. */
    val share: () -> Unit,
    /** Step 3: "Copy with analysis prompt". */
    val copy: () -> Unit,
    /** "Not now": dismisses the checklist, and the bar with it. */
    val notNow: () -> Unit,
    val finish: GuideFinishActions,
)

/** What the done card can do. */
@Immutable
class GuideFinishActions(
    /** "Start your first real meeting". */
    val startMeeting: () -> Unit,
    /** "Close". */
    val close: () -> Unit,
    /**
     * True the first time the finish is shown on this recording (and marks
     * it), so the burst plays once per recording, ever.
     */
    val claimCelebration: () -> Boolean,
)

/**
 * The guided lap, on the recording it is about: a slim bar pinned to the
 * bottom of the recording page that says what to do next on *this* page —
 * look at the suggestion, replay a line, hand it to an AI — and says so again,
 * briefly, when it has been done. iOS `GuideBar.swift` (#450).
 *
 * Onboarding v1 only ticked a list on the library; on the recording itself
 * nothing said what to do. The bar is the missing half. It reads its step from
 * the same checklist ([GuidedLap], parleykit), so the library and the bar can
 * never disagree, and a step still ticks only from the real event.
 *
 * Same chrome as the other pinned parts of this page: page-coloured, a
 * hairline on the edge that faces the content, no card and no fill. Blue only
 * on what can be tapped; the ✓ is the success green, as on the checklist.
 */
@Composable
fun GuideBar(state: GuideBarState, actions: GuideBarActions, modifier: Modifier = Modifier) {
    Column(
        modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.background),
    ) {
        HorizontalDivider(thickness = 0.5.dp, color = MaterialTheme.colorScheme.outlineVariant)
        AnimatedContent(
            targetState = state.display,
            // Unclipped, so the finish's burst can rise over the page.
            transitionSpec = {
                (fadeIn(tween(SWAP_MS)) togetherWith fadeOut(tween(SWAP_MS))).using(SizeTransform(clip = false))
            },
            // The finish is one card whichever way it was reached — the ✓ of
            // the last step or the done step itself — so swapping between the
            // two must not start it again.
            contentKey = ::contentKeyOf,
            label = "guide-bar",
        ) { display ->
            Box(Modifier.padding(horizontal = 20.dp, vertical = 12.dp)) {
                GuideContent(display, state, actions)
            }
        }
    }
}

private fun contentKeyOf(display: Display): Any = if (isFinish(display)) Step.DONE else display

/** The done step, and the ✓ of the step that finished the lap, are both the finish. */
private fun isFinish(display: Display): Boolean = when (display) {
    is Display.Current -> display.step == Step.DONE
    is Display.Confirmed -> display.step == Step.SHARE || display.step == Step.DONE
}

@Composable
private fun GuideContent(display: Display, state: GuideBarState, actions: GuideBarActions) {
    when {
        isFinish(display) -> LapFinish(actions.finish)
        display is Display.Confirmed -> Confirmation(confirmationLine(display.step, state))
        else -> CurrentStep((display as Display.Current).step, state, actions)
    }
}

@Composable
private fun CurrentStep(step: Step, state: GuideBarState, actions: GuideBarActions) {
    when (step) {
        Step.FILE -> StepBlock(R.string.guide_file_title, R.string.guide_file_body, actions.notNow) {
            Primary(
                if (state.hasSuggestion) R.string.guide_show_me else R.string.guide_choose_folder,
                actions.showSuggestion,
            )
        }

        Step.REPLAY -> StepBlock(R.string.guide_replay_title, R.string.guide_replay_body, actions.notNow) {
            Primary(R.string.guide_open_transcript, actions.openTranscript)
        }

        Step.SHARE -> StepBlock(R.string.guide_share_title, R.string.guide_share_body, actions.notNow) {
            ShareActions(state.questions, actions)
        }

        Step.DONE -> LapFinish(actions.finish)
    }
}

@Composable
private fun confirmationLine(step: Step, state: GuideBarState): String = when {
    step == Step.REPLAY -> stringResource(R.string.guide_replay_confirmed)
    state.filedFolder == null -> stringResource(R.string.guide_filed)
    state.renamed -> stringResource(R.string.guide_renamed_filed_in, state.filedFolder)
    else -> stringResource(R.string.guide_filed_in, state.filedFolder)
}

/**
 * A step: its counter and name, the one sentence of why, its action, and the
 * way out.
 */
@Composable
private fun StepBlock(
    @StringRes title: Int,
    @StringRes body: Int,
    onNotNow: () -> Unit,
    actions: @Composable () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = stringResource(title),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.weight(1f),
            )
            NotNow(onNotNow)
        }
        Text(
            text = stringResource(body),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        actions()
    }
}

/** × Not now — quiet, top right, as the checklist's own. */
@Composable
private fun NotNow(onClick: () -> Unit) {
    TextButton(onClick = onClick, contentPadding = PaddingValues(horizontal = 4.dp)) {
        Icon(
            Icons.Default.Close,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(14.dp),
        )
        Spacer(Modifier.width(4.dp))
        Text(
            text = stringResource(R.string.getting_started_not_now),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** Step 3's working parts: the questions the share will ask, then Share and Copy. */
@Composable
private fun ShareActions(questions: List<String>, actions: GuideBarActions) {
    Column {
        questions.forEach { question ->
            Text(
                text = "· $question",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(18.dp)) {
            Primary(R.string.guide_share_to_ai, actions.share)
            TextButton(onClick = actions.copy, contentPadding = PaddingValues(horizontal = 0.dp)) {
                Text(stringResource(R.string.guide_copy_instead), style = MaterialTheme.typography.labelLarge)
            }
        }
    }
}

/**
 * The step's one action: blue text, emphasized — the tint says it can be
 * tapped, and nothing on this bar needs a filled button to be found.
 */
@Composable
private fun Primary(@StringRes label: Int, onClick: () -> Unit) {
    TextButton(onClick = onClick, contentPadding = PaddingValues(horizontal = 0.dp)) {
        Text(stringResource(label), fontWeight = FontWeight.SemiBold)
    }
}

/** A ✓ and what just happened, held for [GuidedLap.HOLD_MS]. One element to TalkBack. */
@Composable
private fun Confirmation(line: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp)
            .semantics(mergeDescendants = true) {},
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(
            Icons.Filled.CheckCircle,
            contentDescription = null,
            tint = ParleyTheme.colors.success,
            modifier = Modifier.size(20.dp),
        )
        Text(line, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface)
    }
}

// ── the finish ───────────────────────────────────────────────────────────────

/**
 * The finish of the lap: the three ✓ lines cascade in
 * [LapMotion.CASCADE_STEP] apart, one success haptic, then one burst of
 * confetti — once per recording, ever. "Remove animations", or a finish
 * already celebrated, shows the final state at once and throws nothing.
 */
@Composable
private fun LapFinish(actions: GuideFinishActions) {
    val context = LocalContext.current
    val view = LocalView.current
    val color = MaterialTheme.colorScheme.primary
    var shown by remember { mutableIntStateOf(0) }
    // Seconds into the burst, or null when there is none to draw.
    var burst by remember { mutableStateOf<Float?>(null) }
    LaunchedEffect(Unit) {
        if (shown > 0) return@LaunchedEffect
        if (guideAnimationsRemoved(context) || !actions.claimCelebration()) {
            shown = DONE_LINES.size
            return@LaunchedEffect
        }
        for (index in 1..DONE_LINES.size) {
            delay(CASCADE_MS)
            shown = index
        }
        successHaptic(view)
        val start = withFrameNanos { it }
        var seconds = 0f
        while (seconds < LapMotion.CONFETTI_DURATION) {
            burst = seconds
            seconds = (withFrameNanos { it } - start) / NANOS_PER_SECOND
        }
        burst = null
    }
    // Drawn over the card rather than laid out beside it: the burst rises
    // over the page above the bar and must not make the bar any taller.
    Box(
        Modifier.drawWithContent {
            drawContent()
            burst?.let { drawConfetti(it, color) }
        },
    ) {
        FinishContent(shown, actions)
    }
}

@Composable
private fun FinishContent(shown: Int, actions: GuideFinishActions) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(
                Icons.Filled.CheckCircle,
                contentDescription = null,
                tint = ParleyTheme.colors.success,
                modifier = Modifier.size(20.dp),
            )
            Text(
                text = stringResource(R.string.getting_started_done),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
            )
        }
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            DONE_LINES.forEachIndexed { index, line -> DoneLine(line, visible = index < shown) }
        }
        Text(
            text = stringResource(R.string.guide_done_body),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(18.dp), verticalAlignment = Alignment.CenterVertically) {
            Primary(R.string.guide_start_meeting, actions.startMeeting)
            TextButton(onClick = actions.close, contentPadding = PaddingValues(horizontal = 0.dp)) {
                Text(
                    text = stringResource(R.string.action_close),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Text(
            text = stringResource(R.string.guide_mac_footnote),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.outline,
        )
    }
}

/** One ✓ line of the finish, sliding in from 8 dp to the left on the lap's spring. */
@Composable
private fun DoneLine(@StringRes line: Int, visible: Boolean) {
    val progress = animateFloatAsState(if (visible) 1f else 0f, lapSpring(), label = "done-line")
    val shift = with(LocalDensity.current) { LINE_SHIFT.toPx() }
    Row(
        modifier = Modifier.graphicsLayer {
            alpha = progress.value.coerceIn(0f, 1f)
            translationX = -shift * (1f - progress.value)
        },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(
            Icons.Default.Check,
            contentDescription = null,
            tint = ParleyTheme.colors.success,
            modifier = Modifier.size(14.dp),
        )
        Text(
            text = stringResource(line),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/**
 * One restrained burst: [LapMotion.CONFETTI_PIECES] small accent-blue
 * rectangles thrown up from the bottom centre of a [CONFETTI_HEIGHT] box
 * lifted [CONFETTI_RISE] over the card, falling back and fading over
 * [LapMotion.CONFETTI_DURATION] — [LapConfetti]'s arithmetic, drawn. Takes no
 * touches and says nothing to TalkBack.
 */
private fun DrawScope.drawConfetti(seconds: Float, color: Color) {
    val unit = density
    val pieces = LapConfetti.pieces(
        seconds.toDouble(),
        (size.width / unit).toDouble(),
        CONFETTI_HEIGHT.value.toDouble(),
    )
    val pieceSize = Size((LapConfetti.PIECE_WIDTH * unit).toFloat(), (LapConfetti.PIECE_HEIGHT * unit).toFloat())
    val corner = Offset(-pieceSize.width / 2, -pieceSize.height / 2)
    translate(top = -CONFETTI_RISE.toPx()) {
        pieces.forEach { piece ->
            translate((piece.x * unit).toFloat(), (piece.y * unit).toFloat()) {
                rotateRad(piece.rotation.toFloat(), pivot = Offset.Zero) {
                    drawRect(color, topLeft = corner, size = pieceSize, alpha = piece.alpha.toFloat())
                }
            }
        }
    }
}

/**
 * The finish landed — iOS `LapMotion.success()`. `CONFIRM` on API 30+, the
 * platform's own word for "that worked". Never load-bearing: it honours the
 * system's touch-feedback setting.
 */
private fun successHaptic(view: View) {
    view.performHapticFeedback(
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            HapticFeedbackConstants.CONFIRM
        } else {
            HapticFeedbackConstants.VIRTUAL_KEY
        },
    )
}

/**
 * Whether the system's animations are off — Settings › Accessibility ›
 * "Remove animations", which zeroes the animator duration scale. Android's
 * Reduce Motion.
 */
internal fun guideAnimationsRemoved(context: Context): Boolean =
    Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f

private val DONE_LINES = listOf(R.string.guide_done_named, R.string.guide_done_replayed, R.string.guide_done_handed)

/** iOS `.animation(.easeOut(duration: 0.25), value: display)`. */
private const val SWAP_MS = 250

private const val MS_PER_SECOND = 1_000
private const val NANOS_PER_SECOND = 1_000_000_000f
private val CASCADE_MS = (LapMotion.CASCADE_STEP * MS_PER_SECOND).toLong()
private val CONFETTI_MS = (LapMotion.CONFETTI_DURATION * MS_PER_SECOND).toLong()

/** iOS: a 260 pt tall burst, lifted 250 pt so it rises over the page above the bar. */
private val CONFETTI_HEIGHT = 260.dp
private val CONFETTI_RISE = 250.dp
private val LINE_SHIFT = 8.dp
