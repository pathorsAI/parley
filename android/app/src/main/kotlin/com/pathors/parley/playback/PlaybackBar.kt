package com.pathors.parley.playback

import android.content.Context
import android.os.Build
import android.provider.Settings
import android.view.HapticFeedbackConstants
import android.view.View
import androidx.annotation.StringRes
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.AwaitPointerEventScope
import androidx.compose.ui.input.pointer.PointerId
import androidx.compose.ui.input.pointer.PointerInputChange
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.setProgress
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import com.pathors.parley.R
import com.pathors.parley.ui.formatDuration
import java.util.Locale
import kotlin.math.roundToInt
import kotlin.math.roundToLong
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import androidx.compose.foundation.Canvas as DrawCanvas

/**
 * The player, pinned under the recording's title: the whole file as one
 * overview waveform, and one row of controls. The Android half of iOS
 * `PlaybackBar.swift`, behaviour for behaviour.
 *
 * ## Why an overview and not a scrolling waveform
 *
 * The live meeting screen's level meter is a history — during a meeting the
 * question is "did it hear the last thing I said". Afterwards the question is
 * the opposite one, "where in this hour was the bit about the price", and only
 * a view of the *whole* file can answer it. So this is static: one bar per 5dp
 * of width, the entire recording, the played portion in the primary colour.
 *
 * ## Full height only once there is a waveform
 *
 * Before the audio is playable the block is a single 44dp row — the download
 * offer, its progress, "Preparing…", or why it failed. An 80dp band holding one
 * line of text reads as a hole in the page, not a player (iOS #381).
 *
 * @param actions what the bar's controls do. See [PlaybackBarActions].
 * @param markers moments worth finding on the timeline, in milliseconds — the
 *   analysis's findings. Drawn as small dots riding the top edge of the
 *   waveform; tapping one seeks there.
 */
@Composable
fun PlaybackBar(
    state: PlaybackState,
    actions: PlaybackBarActions,
    modifier: Modifier = Modifier,
    markers: List<Long> = emptyList(),
) {
    val hasWaveform = state.phase == PlaybackPhase.READY
    Column(modifier = modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface)) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(if (hasWaveform) PLAYER_HEIGHT + 16.dp else CONTROLS_HEIGHT + 16.dp)
                .padding(horizontal = 16.dp, vertical = 8.dp),
            contentAlignment = Alignment.Center,
        ) {
            when (state.phase) {
                PlaybackPhase.READY -> Player(state = state, markers = markers, actions = actions)

                PlaybackPhase.DOWNLOADING -> ProgressLine(
                    caption = stringResource(R.string.playback_downloading),
                    fraction = state.downloadFraction,
                )

                PlaybackPhase.PREPARING -> ProgressLine(
                    caption = stringResource(R.string.playback_preparing),
                    fraction = -1f,
                )

                PlaybackPhase.FAILED -> FailureLine(state.failure, actions.onDownload)
                PlaybackPhase.ABSENT -> TextButton(onClick = actions.onDownload) {
                    // No size next to it on purpose: the recording summary
                    // carries `hasAudio` but no byte count, and a number
                    // invented here would be a guess in the one place somebody
                    // is deciding whether to spend their data on it.
                    Text(
                        text = stringResource(R.string.playback_download),
                        style = MaterialTheme.typography.bodyLarge,
                        fontWeight = FontWeight.Medium,
                    )
                }
            }
        }
        // The hairline is the whole of the separation: the block is the same
        // colour as the page, so a rule is what says "the transcript scrolls
        // under this" without a card, a shadow or a tinted band.
        HorizontalDivider()
    }
}

/**
 * What the player's controls do, handed to [PlaybackBar] as one value.
 *
 * @property onSeek every seek the bar itself makes: each move of a scrub (live,
 *   so the audio follows the finger), a highlight dot, TalkBack's ±15 s. A
 *   seek from the transcript is not this — it goes through
 *   [PlaybackController.jumpTo], and the bar sees it as [PlaybackState.jump].
 * @property onDownload fetch the audio; also the failed download's retry.
 */
class PlaybackBarActions(
    val onPlayPause: () -> Unit,
    val onSeek: (Long) -> Unit,
    val onSetRate: (Float) -> Unit,
    val onCycleRate: () -> Unit,
    val onDownload: () -> Unit,
)

@Composable
private fun Player(state: PlaybackState, markers: List<Long>, actions: PlaybackBarActions) {
    // Where the finger has the scrub, while one is down — for the clock in the
    // control row. The seek itself is already live; this only saves the clock
    // from lagging the finger by a poll.
    var scrubMs by remember { mutableStateOf<Long?>(null) }
    val shownMs = scrubMs ?: state.positionMs

    Column(Modifier.fillMaxSize()) {
        WaveformScrubber(
            state = state,
            onSeek = actions.onSeek,
            markers = markers,
            onScrubChange = { scrubMs = it },
            modifier = Modifier
                .fillMaxWidth()
                .height(WAVEFORM_HEIGHT)
                // Above the control row, so the floating time pill (taller
                // than the strip in the precision tiers) draws over it.
                .zIndex(1f),
        )
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(CONTROLS_HEIGHT),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            PlayPauseButton(isPlaying = state.isPlaying, onClick = actions.onPlayPause)
            Text(
                text = "${formatDuration(shownMs.toDouble())} / " +
                    formatDuration(state.durationMs.toDouble()),
                style = MaterialTheme.typography.bodyMedium.copy(
                    // Tabular figures: without them the clock's width changes
                    // with its digits and the row twitches once a second.
                    fontFeatureSettings = TABULAR_FIGURES,
                ),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.weight(1f))
            SpeedButton(rate = state.rate, onSetRate = actions.onSetRate, onCycle = actions.onCycleRate)
        }
    }
}

/**
 * A 36dp primary-coloured disc. Coloured because it is tappable *and* because
 * the player is the thing happening now.
 */
@Composable
private fun PlayPauseButton(isPlaying: Boolean, onClick: () -> Unit) {
    val label = stringResource(if (isPlaying) R.string.playback_pause else R.string.playback_play)
    val glyph = MaterialTheme.colorScheme.onPrimary
    Box(
        modifier = Modifier
            .size(36.dp)
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.primary)
            .clickable(onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        // Drawn rather than imported: `Pause` lives only in
        // `material-icons-extended`, and a 6 MB icon library for one glyph is
        // not a trade worth making in an app that ships two shapes.
        DrawCanvas(Modifier.size(GLYPH_SIZE)) {
            if (isPlaying) {
                val bar = size.width * 0.3f
                val radius = CornerRadius(bar * 0.25f, bar * 0.25f)
                drawRoundRect(
                    color = glyph,
                    topLeft = Offset(0f, 0f),
                    size = Size(bar, size.height),
                    cornerRadius = radius,
                )
                drawRoundRect(
                    color = glyph,
                    topLeft = Offset(size.width - bar, 0f),
                    size = Size(bar, size.height),
                    cornerRadius = radius,
                )
            } else {
                // Nudged right by a hair: a triangle's visual centre is left of
                // its bounding box's, so one centred by its box always looks a
                // touch too far left inside a circle.
                val nudge = size.width * 0.06f
                drawPath(
                    path = Path().apply {
                        moveTo(nudge, 0f)
                        lineTo(size.width, size.height / 2f)
                        lineTo(nudge, size.height)
                        close()
                    },
                    color = glyph,
                )
            }
        }
    }
}

/**
 * Tap cycles 1 → 1.25 → 1.5 → 2, long-press opens every speed from 0.75× to
 * 2×. Whatever is chosen is remembered for the next recording and the next
 * launch ([PlaybackRateStore]).
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SpeedButton(rate: Float, onSetRate: (Float) -> Unit, onCycle: () -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    val label = stringResource(R.string.playback_speed)
    val current = rateLabel(rate)

    Box {
        Box(
            modifier = Modifier
                .sizeIn(minWidth = 44.dp, minHeight = 44.dp)
                .clip(MaterialTheme.shapes.small)
                .combinedClickable(
                    onClick = onCycle,
                    onLongClick = { expanded = true },
                )
                .padding(horizontal = 10.dp)
                .semantics {
                    contentDescription = label
                    stateDescription = current
                },
            contentAlignment = Alignment.CenterEnd,
        ) {
            Text(
                text = current,
                style = MaterialTheme.typography.bodyLarge.copy(
                    fontFeatureSettings = TABULAR_FIGURES,
                ),
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.primary,
            )
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            PlaybackRates.MENU.forEach { value ->
                val selected = rateLabel(value) == current
                DropdownMenuItem(
                    text = {
                        Text(
                            text = rateLabel(value),
                            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                            color = if (selected) {
                                MaterialTheme.colorScheme.primary
                            } else {
                                MaterialTheme.colorScheme.onSurface
                            },
                        )
                    },
                    onClick = {
                        expanded = false
                        onSetRate(value)
                    },
                )
            }
        }
    }
}

/** A thin determinate line with a caption under it. `fraction < 0` is indeterminate. */
@Composable
private fun ProgressLine(caption: String, fraction: Float) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (fraction >= 0f) {
            LinearProgressIndicator(
                progress = { fraction },
                modifier = Modifier.fillMaxWidth(),
            )
        } else {
            LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
        }
        Text(
            text = caption,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/**
 * Why it failed, on the one row. A download that did not arrive is worth
 * another tap, so it keeps a retry beside the sentence; a file on the phone
 * that the decoder refuses is not, and offering a retry for it would be a
 * button that cannot work.
 */
@Composable
private fun FailureLine(failure: PlaybackFailure?, onRetry: () -> Unit) {
    val retryable = failure != PlaybackFailure.UNPLAYABLE
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = if (retryable) Arrangement.spacedBy(8.dp) else Arrangement.Center,
    ) {
        Text(
            text = stringResource(failureMessage(failure)),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error,
            textAlign = if (retryable) TextAlign.Start else TextAlign.Center,
            maxLines = 2,
            modifier = if (retryable) Modifier.weight(1f) else Modifier,
        )
        if (retryable) {
            TextButton(onClick = onRetry) {
                Text(stringResource(R.string.playback_retry))
            }
        }
    }
}

@StringRes
private fun failureMessage(failure: PlaybackFailure?): Int = when (failure) {
    PlaybackFailure.DOWNLOAD_MISSING -> R.string.playback_failed_missing
    PlaybackFailure.UNPLAYABLE -> R.string.playback_failed_unplayable
    else -> R.string.playback_failed_network
}

/**
 * The overview waveform, and the only place the recording can be scrubbed.
 *
 * ## The bars
 *
 * 3dp wide, 2dp apart, rounded ends, symmetric about a centreline. Silence is
 * still a mark: a bar never goes below its own width, so a quiet stretch of an
 * hour-long file draws as a dotted centreline rather than as a gap in the
 * recording — which is the difference between "nobody spoke" and "nothing was
 * recorded".
 *
 * Normalised to the loudest moment rather than by a fixed gain: an hour of a
 * phone on a table across a boardroom is quiet all the way through, and a fixed
 * gain draws that as a flat line. The floor stops a silent file being amplified
 * into noise.
 *
 * ## The gesture
 *
 * A drag moves the playhead *relative* to where it was — touching the strip
 * does not jump anywhere — and moving the finger away from the strip, up or
 * down, slows it to ¼ ("Fine") and then 1/16 ("Finer"), with a tick at each
 * change and a floating pill that says the time and the tier. The audio seeks
 * live on every move ([onSeek]; the controller conflates the engine seeks), so
 * when the number under the finger changes, the audio is already there. See
 * [ScrubRules] for the arithmetic.
 *
 * ## A jump from the transcript
 *
 * When [jump] changes, the playhead glides from where it was to where it
 * landed over 0.5 s and a ring grows and fades there over 0.7 s — skipped
 * entirely when the system's animations are off. A scrub never does this: it is
 * already under the finger.
 *
 * ## TalkBack
 *
 * The drag is unreachable with TalkBack on, so the strip is an adjustable
 * control: swipe up or down moves 15 s, and the position is spoken as a clock.
 */
@Composable
fun WaveformScrubber(
    state: PlaybackState,
    onSeek: (Long) -> Unit,
    modifier: Modifier = Modifier,
    markers: List<Long> = emptyList(),
    onScrubChange: (Long?) -> Unit = {},
) {
    val colors = WaveformColors(
        played = MaterialTheme.colorScheme.primary,
        unplayed = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.35f),
        playhead = MaterialTheme.colorScheme.onSurface,
    )
    val page = MaterialTheme.colorScheme.surface
    val description = stringResource(R.string.playback_scrub)
    val view = LocalView.current
    val durationMs = state.durationMs
    val enabled = state.isSeekable

    // Recomputed only when the bar count or the source peaks change: resampling
    // 400 values down to ~110 on every 50 ms tick would be work done 20 times a
    // second for a picture that did not move.
    var canvasSize by remember { mutableStateOf(IntSize.Zero) }
    val step = with(LocalDensity.current) { (BAR_WIDTH + BAR_GAP).toPx() }
    val barCount = (canvasSize.width / step).toInt().coerceAtLeast(0)
    val bars = remember(state.overview, barCount) { resampleBars(state.overview, barCount) }

    var scrub by remember { mutableStateOf<ScrubPreview?>(null) }
    val shownMs = scrub?.timeMs ?: state.positionMs

    // Held as `State` so the long-lived gesture and semantics lambdas always
    // call the newest callbacks rather than the ones of their first frame.
    val seek = rememberUpdatedState(onSeek)
    val scrubChange = rememberUpdatedState(onScrubChange)
    val gesture = ScrubCallbacks(
        position = rememberUpdatedState(state.positionMs),
        onSeek = seek,
        onPreview = { preview ->
            scrub = preview
            scrubChange.value(preview?.timeMs)
        },
        onTierChange = { PlaybackHaptics.tierChanged(view) },
    )

    val marks = rememberJumpMarks(state.jump, durationMs)

    Box(modifier) {
        DrawCanvas(
            modifier = Modifier
                .fillMaxSize()
                .scrubSemantics(enabled, description, shownMs, state.positionMs, durationMs) { ms ->
                    seek.value(ms)
                }
                // Measured here rather than in the draw pass: writing state while
                // drawing schedules another frame to draw the answer, which is one
                // frame of a waveform that is not there yet on every resize.
                .onSizeChanged { canvasSize = it }
                .scrubGesture(enabled, durationMs, gesture),
        ) {
            drawWaveform(bars, step, shownMs, durationMs, colors, marks.glideFraction)
            marks.ringFraction?.let { drawRipple(it, marks.ring.value, colors.played) }
        }

        if (durationMs > 0L && canvasSize.width > 0) {
            markers.forEach { at ->
                HighlightDot(
                    x = canvasSize.width * fractionOf(at, durationMs),
                    label = stringResource(R.string.playback_highlight_at, formatDuration(at.toDouble())),
                    enabled = enabled,
                    colors = DotColors(ink = colors.playhead, page = page),
                    onClick = { seek.value(at.coerceIn(0L, durationMs)) },
                )
            }
        }

        scrub?.let { ScrubPill(it, canvasSize) }
    }
}

/** One live scrub: the time it has reached, where the finger is, and the tier. */
private data class ScrubPreview(val timeMs: Long, val finger: Offset, val tier: Int)

/**
 * What the scrub gesture reads and reports. The position and the seek are
 * `State`s because the gesture outlives recompositions: it must start from the
 * current position and call the current callback.
 */
private class ScrubCallbacks(
    val position: State<Long>,
    val onSeek: State<(Long) -> Unit>,
    val onPreview: (ScrubPreview?) -> Unit,
    val onTierChange: () -> Unit,
)

/**
 * The scrub: one gesture per finger, from touch-down to lift. See the
 * [WaveformScrubber] doc for the behaviour and [ScrubSession] for the maths.
 */
private fun Modifier.scrubGesture(enabled: Boolean, durationMs: Long, callbacks: ScrubCallbacks): Modifier =
    pointerInput(enabled, durationMs) {
        if (!enabled) return@pointerInput
        awaitEachGesture { trackScrub(durationMs, callbacks) }
    }

private suspend fun AwaitPointerEventScope.trackScrub(durationMs: Long, callbacks: ScrubCallbacks) {
    val down = awaitFirstDown()
    down.consume()
    val session = ScrubSession(
        startMs = callbacks.position.value,
        downX = down.position.x,
        downY = down.position.y,
    )
    callbacks.onPreview(ScrubPreview(session.currentMs, down.position, session.tier))
    try {
        while (true) {
            val change = awaitScrubMove(down.id) ?: break
            val before = session.currentMs
            val tierChanged = session.move(
                x = change.position.x,
                y = change.position.y,
                pxPerDp = density,
                widthPx = size.width.toFloat(),
                durationMs = durationMs,
            )
            if (tierChanged) callbacks.onTierChange()
            change.consume()
            callbacks.onPreview(ScrubPreview(session.currentMs, change.position, session.tier))
            // Live: the audio follows the finger, or — paused — the playhead
            // does and the next play starts here.
            if (session.currentMs != before) callbacks.onSeek.value(session.currentMs)
        }
    } finally {
        // Nothing to apply on release: every move already seeked, so lifting
        // the finger just ends the label.
        callbacks.onPreview(null)
    }
}

/** The next move of the scrubbing finger, or null once it has lifted or gone. */
private suspend fun AwaitPointerEventScope.awaitScrubMove(id: PointerId): PointerInputChange? {
    val change = awaitPointerEvent().changes.firstOrNull { it.id == id } ?: return null
    if (!change.pressed) {
        change.consume()
        return null
    }
    return change
}

/**
 * The playhead gliding to a tapped turn and the ring where it lands — iOS
 * `ScrubbableWaveform.startGlide`. Drawn by the canvas, whose own playhead
 * steps aside for the length of the glide.
 */
@Stable
private class JumpMarks(private var seenJump: Int) {
    val glide = Animatable(0f)
    val ring = Animatable(0f)
    private var gliding by mutableStateOf(false)

    /** Where the ring is, as a fraction of the width; null when there is none. */
    var ringFraction by mutableStateOf<Float?>(null)
        private set

    /** The playhead's position mid-glide; null when it follows the audio. */
    val glideFraction: Float? get() = if (gliding) glide.value else null

    /**
     * Whether [id] is a new jump. The jump already on screen when this
     * composed — after a rotation, say — is history, not an event to replay.
     */
    fun claim(id: Int): Boolean {
        if (id == seenJump) return false
        seenJump = id
        return true
    }

    suspend fun play(jump: PlaybackJump, durationMs: Long) {
        val to = fractionOf(jump.toMs, durationMs)
        try {
            glide.snapTo(fractionOf(jump.fromMs, durationMs))
            ring.snapTo(0f)
            gliding = true
            ringFraction = to
            coroutineScope {
                launch { glide.animateTo(to, tween(GLIDE_MS, easing = EASE_IN_OUT)) }
                launch { ring.animateTo(1f, tween(RIPPLE_MS, easing = EASE_OUT)) }
            }
        } finally {
            // Only this jump's own marks: a newer one may already be drawing.
            if (seenJump == jump.id) {
                gliding = false
                ringFraction = null
            }
        }
    }
}

/**
 * Watches [jump]: a light tick on every new one, and the glide and ring unless
 * the system's animations are off.
 */
@Composable
private fun rememberJumpMarks(jump: PlaybackJump, durationMs: Long): JumpMarks {
    val marks = remember { JumpMarks(jump.id) }
    val view = LocalView.current
    val context = LocalContext.current
    val duration = rememberUpdatedState(durationMs)
    LaunchedEffect(jump.id) {
        if (!marks.claim(jump.id)) return@LaunchedEffect
        PlaybackHaptics.jumped(view)
        if (duration.value > 0L && !animationsRemoved(context)) marks.play(jump, duration.value)
    }
    return marks
}

/**
 * The strip as TalkBack sees it: "Scrub", the position as a clock, and an
 * adjustable range in seconds whose step is exactly 15 s (see
 * [ScrubRules.accessibilityRange]).
 */
private fun Modifier.scrubSemantics(
    enabled: Boolean,
    description: String,
    shownMs: Long,
    positionMs: Long,
    durationMs: Long,
    onSeek: (Long) -> Unit,
): Modifier = semantics {
    contentDescription = description
    stateDescription = formatDuration(shownMs.toDouble())
    if (enabled && durationMs > 0L) {
        val range = ScrubRules.accessibilityRange(durationMs)
        progressBarRangeInfo = ProgressBarRangeInfo(
            current = (positionMs / 1000f).coerceIn(0f, range.endSeconds),
            range = 0f..range.endSeconds,
            steps = range.steps,
        )
        setProgress { seconds ->
            onSeek((seconds * 1000.0).roundToLong().coerceIn(0L, durationMs))
            true
        }
    }
}

/**
 * A highlight: a 6dp ink dot with a ring of page colour, so it reads over a
 * loud bar as well as over silence, riding the strip's top edge. The target is
 * a thumb-sized 24dp around it, laid over the waveform so a tap on the dot is
 * the dot's, not the scrub's.
 */
@Composable
private fun HighlightDot(
    x: Float,
    label: String,
    enabled: Boolean,
    colors: DotColors,
    onClick: () -> Unit,
) {
    DrawCanvas(
        modifier = Modifier
            .offset {
                IntOffset(
                    x = (x - DOT_TARGET.toPx() / 2f).roundToInt(),
                    y = DOT_TARGET_TOP.roundToPx(),
                )
            }
            .size(DOT_TARGET)
            .clickable(
                interactionSource = null,
                indication = null,
                enabled = enabled,
                role = Role.Button,
                onClick = onClick,
            )
            .semantics { contentDescription = label },
    ) {
        drawCircle(color = colors.page, radius = (DOT_DIAMETER / 2 + DOT_RING).toPx())
        drawCircle(color = colors.ink, radius = (DOT_DIAMETER / 2).toPx())
    }
}

/**
 * The floating time while a finger is down, with the tier's name under it once
 * one is in effect. Follows the finger horizontally and sits above it, clamped
 * inside the strip.
 */
@Composable
private fun ScrubPill(preview: ScrubPreview, strip: IntSize) {
    val tier = ScrubRules.TIERS[preview.tier]
    val height = if (tier.label != null) PILL_HEIGHT_TIERED else PILL_HEIGHT
    val shape = MaterialTheme.shapes.small
    val density = LocalDensity.current
    val (x, y) = with(density) {
        ScrubRules.pillOffset(
            fingerX = preview.finger.x,
            fingerY = preview.finger.y,
            pillWidth = PILL_WIDTH.toPx(),
            pillHeight = height.toPx(),
            stripWidth = strip.width.toFloat(),
            stripHeight = strip.height.toFloat(),
            gapPx = PILL_GAP.toPx(),
        )
    }
    Column(
        modifier = Modifier
            .offset { IntOffset(x.roundToInt(), y.roundToInt()) }
            .size(PILL_WIDTH, height)
            .background(MaterialTheme.colorScheme.surface, shape)
            .border(Dp.Hairline, MaterialTheme.colorScheme.outlineVariant, shape),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(1.dp, Alignment.CenterVertically),
    ) {
        Text(
            text = formatDuration(preview.timeMs.toDouble()),
            style = MaterialTheme.typography.bodySmall.copy(fontFeatureSettings = TABULAR_FIGURES),
            color = MaterialTheme.colorScheme.onSurface,
        )
        tier.label?.let { label ->
            Text(
                text = stringResource(label),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/**
 * The bars to draw for [barCount] columns of canvas, or an empty array while
 * there is nothing to draw yet — before the first measure, or before the peaks
 * have been computed.
 */
private fun resampleBars(overview: AudioPeaks.Overview?, barCount: Int): FloatArray =
    if (barCount <= 0 || overview == null) FloatArray(0)
    else AudioPeaks.resample(overview.peaks, barCount)

/**
 * One draw pass: the bars, then the playhead over them — at [glideFraction]
 * instead of the position while a jump is gliding.
 *
 * Bails on a canvas too short for a single bar rather than drawing a squashed
 * one, which also means nothing at all is drawn before the first real measure.
 */
private fun DrawScope.drawWaveform(
    bars: FloatArray,
    step: Float,
    positionMs: Long,
    durationMs: Long,
    colors: WaveformColors,
    glideFraction: Float?,
) {
    val minBar = BAR_WIDTH.toPx()
    if (bars.isEmpty() || size.height < minBar) return

    val progressX = size.width * fractionOf(positionMs, durationMs)

    drawBars(bars, step, minBar, progressX, colors)
    // No duration means no meaningful position, so there is no line to put.
    if (durationMs > 0L) drawPlayhead(glideFraction?.let { size.width * it } ?: progressX, colors.playhead)
}

/**
 * The waveform's three inks: what has played, what has not, and the playhead —
 * not the primary colour, which is already saying which side has played.
 */
private data class WaveformColors(val played: Color, val unplayed: Color, val playhead: Color)

/** A highlight dot's ink and the ring of page colour around it. */
private data class DotColors(val ink: Color, val page: Color)

/**
 * The bars themselves, played up to [progressX] and unplayed after it.
 *
 * Normalised to the loudest bar with a floor under it, and every bar at least
 * its own width tall. See the [WaveformScrubber] doc for why both.
 */
private fun DrawScope.drawBars(
    bars: FloatArray,
    step: Float,
    minBar: Float,
    progressX: Float,
    colors: WaveformColors,
) {
    val loudest = maxOf(bars.max(), MIN_LOUDEST)
    val midY = size.height / 2f
    val barWidth = BAR_WIDTH.toPx()
    val radius = CornerRadius(barWidth / 2f, barWidth / 2f)

    bars.forEachIndexed { index, value ->
        val x = index * step
        val scaled = (value / loudest).coerceIn(0f, 1f)
        val height = minBar + (size.height - minBar) * scaled
        drawRoundRect(
            color = if (x + barWidth <= progressX) colors.played else colors.unplayed,
            topLeft = Offset(x, midY - height / 2f),
            size = Size(barWidth, height),
            cornerRadius = radius,
        )
    }
}

/**
 * The line at the current position.
 *
 * Not the primary colour: that is already saying which side of the line has
 * played, and a primary line on a primary field vanishes.
 */
private fun DrawScope.drawPlayhead(x: Float, color: Color) {
    val width = PLAYHEAD_WIDTH.toPx()
    drawRoundRect(
        color = color,
        topLeft = Offset((x - width / 2f).coerceIn(0f, size.width - width), 0f),
        size = Size(width, size.height),
        cornerRadius = CornerRadius(width / 2f, width / 2f),
    )
}

/**
 * The ring where a jump landed: from a tenth of its size to 44dp across,
 * fading out as it grows. iOS `RippleRing`. Drawn past the strip's own height
 * on purpose — nothing clips it.
 */
private fun DrawScope.drawRipple(fraction: Float, progress: Float, color: Color) {
    val full = RIPPLE_DIAMETER.toPx() / 2f
    drawCircle(
        color = color,
        radius = full * (0.1f + 0.9f * progress),
        center = Offset(size.width * fraction, size.height / 2f),
        alpha = 0.9f * (1f - progress),
        style = Stroke(width = RIPPLE_STROKE.toPx()),
    )
}

private fun fractionOf(ms: Long, durationMs: Long): Float =
    if (durationMs > 0L) (ms.toFloat() / durationMs).coerceIn(0f, 1f) else 0f

/**
 * Whether the system's animations are off — Settings › Accessibility ›
 * "Remove animations", which zeroes the animator duration scale. Read when a
 * jump happens rather than remembered, so flipping it takes effect at once.
 */
private fun animationsRemoved(context: Context): Boolean =
    Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f

/**
 * The player's two light ticks. iOS uses a light impact for both; Android's
 * closest vocabulary is the tick a slider makes crossing a detent. Never
 * load-bearing — `performHapticFeedback` honours the system's touch-feedback
 * setting and does nothing when it is off.
 */
internal object PlaybackHaptics {
    /** The scrub crossed into a finer (or coarser) tier. */
    fun tierChanged(view: View) {
        view.performHapticFeedback(
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                HapticFeedbackConstants.SEGMENT_TICK
            } else {
                HapticFeedbackConstants.CLOCK_TICK
            },
        )
    }

    /** A tapped turn moved the player. iOS `LapMotion.tap()`. */
    fun jumped(view: View) {
        view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    }
}

/** `1×`, `1.25×` — trailing zeroes stripped, because `1.00×` reads as a measurement. */
internal fun rateLabel(rate: Float): String {
    val text = String.format(Locale.US, "%.2f", rate).trimEnd('0').trimEnd('.')
    return "$text×"
}

/** Tabular figures, so a running clock does not change width as it counts. */
private const val TABULAR_FIGURES = "tnum"

private val GLYPH_SIZE: Dp = 14.dp
private val BAR_WIDTH: Dp = 3.dp
private val BAR_GAP: Dp = 2.dp
private val PLAYHEAD_WIDTH: Dp = 2.dp
private val WAVEFORM_HEIGHT: Dp = 36.dp
private val CONTROLS_HEIGHT: Dp = 44.dp

/** The waveform and the control row. See the [PlaybackBar] doc for the collapsed height. */
private val PLAYER_HEIGHT: Dp = WAVEFORM_HEIGHT + CONTROLS_HEIGHT

private val DOT_DIAMETER: Dp = 6.dp
private val DOT_RING: Dp = 1.5.dp
private val DOT_TARGET: Dp = 24.dp

/** The target's top, so the dot's centre sits 3dp inside the strip's top edge. */
private val DOT_TARGET_TOP: Dp = (-9).dp

private val PILL_WIDTH: Dp = 96.dp
private val PILL_HEIGHT: Dp = 28.dp
private val PILL_HEIGHT_TIERED: Dp = 44.dp
private val PILL_GAP: Dp = 12.dp

private val RIPPLE_DIAMETER: Dp = 44.dp
private val RIPPLE_STROKE: Dp = 1.5.dp

/** iOS `LapMotion.playheadGlide` and `LapMotion.ripple`, in milliseconds. */
private const val GLIDE_MS = 500
private const val RIPPLE_MS = 700

/** SwiftUI's `.easeInOut` and `.easeOut` curves. */
private val EASE_IN_OUT = CubicBezierEasing(0.42f, 0f, 0.58f, 1f)
private val EASE_OUT = CubicBezierEasing(0f, 0f, 0.58f, 1f)

/** The quietest "loudest moment" we will normalise against. See [WaveformScrubber]. */
private const val MIN_LOUDEST = 0.02f
