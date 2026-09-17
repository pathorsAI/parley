package com.pathors.parley.playback

import androidx.annotation.StringRes
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
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
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.pathors.parley.R
import com.pathors.parley.ui.formatDuration
import java.util.Locale
import kotlin.math.roundToLong
import androidx.compose.foundation.Canvas as DrawCanvas

/**
 * The player, pinned under the recording's title: the whole file as one
 * overview waveform, and one row of controls.
 *
 * ## Why an overview and not a scrolling waveform
 *
 * The live meeting screen's level meter is a history — during a meeting the
 * question is "did it hear the last thing I said". Afterwards the question is
 * the opposite one, "where in this hour was the bit about the price", and only
 * a view of the *whole* file can answer it. So this is static: one bar per 5dp
 * of width, the entire recording, the played portion in the primary colour.
 *
 * ## One height, four states
 *
 * The audio is either playable, arriving, opening, or not here yet, and the
 * block keeps the same height through all of them ([BLOCK_HEIGHT]) so the
 * transcript underneath does not jump when a download lands.
 */
@Composable
fun PlaybackBar(
    state: PlaybackState,
    onPlayPause: () -> Unit,
    onSeek: (Long) -> Unit,
    onSetRate: (Float) -> Unit,
    onCycleRate: () -> Unit,
    onDownload: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface)) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(BLOCK_HEIGHT)
                .padding(horizontal = 16.dp, vertical = 8.dp),
            contentAlignment = Alignment.Center,
        ) {
            when (state.phase) {
                PlaybackPhase.READY -> Player(
                    state = state,
                    onPlayPause = onPlayPause,
                    onSeek = onSeek,
                    onSetRate = onSetRate,
                    onCycleRate = onCycleRate,
                )

                PlaybackPhase.DOWNLOADING -> ProgressLine(
                    caption = stringResource(R.string.playback_downloading),
                    fraction = state.downloadFraction,
                )

                PlaybackPhase.PREPARING -> ProgressLine(
                    caption = stringResource(R.string.playback_preparing),
                    fraction = -1f,
                )

                PlaybackPhase.FAILED -> FailureLine(state.failure, onDownload)
                PlaybackPhase.ABSENT -> TextButton(onClick = onDownload) {
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

@Composable
private fun Player(
    state: PlaybackState,
    onPlayPause: () -> Unit,
    onSeek: (Long) -> Unit,
    onSetRate: (Float) -> Unit,
    onCycleRate: () -> Unit,
) {
    // The position the finger is at, while one is down. Null otherwise — the
    // playhead follows the audio again the moment the drag ends.
    var scrubMs by remember { mutableStateOf<Long?>(null) }
    val shownMs = scrubMs ?: state.positionMs

    Column(Modifier.fillMaxSize()) {
        WaveformScrubber(
            overview = state.overview,
            positionMs = shownMs,
            durationMs = state.durationMs,
            enabled = state.isSeekable,
            onScrub = { ms -> scrubMs = ms },
            onScrubEnd = { ms ->
                scrubMs = null
                onSeek(ms)
            },
            modifier = Modifier
                .fillMaxWidth()
                .height(WAVEFORM_HEIGHT),
        )
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(CONTROLS_HEIGHT),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            PlayPauseButton(isPlaying = state.isPlaying, onClick = onPlayPause)
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
            SpeedButton(rate = state.rate, onSetRate = onSetRate, onCycle = onCycleRate)
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

/** Tap cycles through the speeds, long-press opens the whole list. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SpeedButton(rate: Float, onSetRate: (Float) -> Unit, onCycle: () -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    val label = stringResource(R.string.playback_speed)

    Box {
        Text(
            text = rateLabel(rate),
            style = MaterialTheme.typography.bodyLarge.copy(
                fontFeatureSettings = TABULAR_FIGURES,
            ),
            fontWeight = FontWeight.Medium,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier
                .clip(MaterialTheme.shapes.small)
                .combinedClickable(
                    onClick = onCycle,
                    onLongClick = { expanded = true },
                )
                .padding(horizontal = 10.dp, vertical = 8.dp)
                .semantics { contentDescription = label },
        )
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            PlaybackController.RATES.forEach { value ->
                DropdownMenuItem(
                    text = { Text(rateLabel(value)) },
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
        verticalArrangement = Arrangement.spacedBy(10.dp),
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

@Composable
private fun FailureLine(failure: PlaybackFailure?, onRetry: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = stringResource(failureMessage(failure)),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error,
        )
        // A download that did not arrive is worth another tap; a file on the
        // phone that the decoder refuses is not, and offering a retry for it
        // would be a button that cannot work.
        if (failure != PlaybackFailure.UNPLAYABLE) {
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
 * Tap seeks. Drag previews and seeks on release, so the one thing that must be
 * true of a scrubber is true here: when the number under your finger changes,
 * the audio goes there. (iOS shipped this with the number moving and the audio
 * staying put — PR #376.)
 */
@Composable
fun WaveformScrubber(
    overview: AudioPeaks.Overview?,
    positionMs: Long,
    durationMs: Long,
    enabled: Boolean,
    onScrub: (Long) -> Unit,
    onScrubEnd: (Long) -> Unit,
    modifier: Modifier = Modifier,
) {
    val played = MaterialTheme.colorScheme.primary
    val unplayed = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.35f)
    val playhead = MaterialTheme.colorScheme.onSurface
    val description = stringResource(R.string.playback_scrub)

    // Recomputed only when the bar count or the source peaks change: resampling
    // 400 values down to ~110 on every 50 ms tick would be work done 20 times a
    // second for a picture that did not move.
    var barCount by remember { mutableStateOf(0) }
    val bars = remember(overview, barCount) { resampleBars(overview, barCount) }

    val step = with(androidx.compose.ui.platform.LocalDensity.current) {
        (BAR_WIDTH + BAR_GAP).toPx()
    }

    DrawCanvas(
        modifier = modifier
            .semantics { contentDescription = description }
            // Measured here rather than in the draw pass: writing state while
            // drawing schedules another frame to draw the answer, which is one
            // frame of a waveform that is not there yet on every resize.
            .onSizeChanged { measured ->
                barCount = (measured.width / step).toInt().coerceAtLeast(0)
            }
            .scrubGestures(enabled, durationMs, onScrub, onScrubEnd),
    ) {
        drawWaveform(bars, step, positionMs, durationMs, played, unplayed, playhead)
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
 * The scrub gesture: tap commits straight away, drag reports every move through
 * [onScrub] and commits through [onScrubEnd].
 *
 * Two separate `pointerInput`s rather than one, because the tap detector and the
 * drag detector each want the whole gesture: sharing one scope makes the first
 * one to suspend the only one that ever sees a pointer.
 */
private fun Modifier.scrubGestures(
    enabled: Boolean,
    durationMs: Long,
    onScrub: (Long) -> Unit,
    onScrubEnd: (Long) -> Unit,
): Modifier = this
    .pointerInput(enabled, durationMs) {
        if (!enabled) return@pointerInput
        detectTapGestures { offset ->
            onScrubEnd(timeAt(offset.x, size.width, durationMs))
        }
    }
    .pointerInput(enabled, durationMs) {
        if (!enabled) return@pointerInput
        var x = 0f
        detectHorizontalDragGestures(
            onDragStart = { offset ->
                x = offset.x
                onScrub(timeAt(x, size.width, durationMs))
            },
            onHorizontalDrag = { change, delta ->
                change.consume()
                x += delta
                onScrub(timeAt(x, size.width, durationMs))
            },
            onDragEnd = { onScrubEnd(timeAt(x, size.width, durationMs)) },
            onDragCancel = { onScrubEnd(timeAt(x, size.width, durationMs)) },
        )
    }

/**
 * One draw pass: the bars, then the playhead over them.
 *
 * Bails on a canvas too short for a single bar rather than drawing a squashed
 * one, which also means nothing at all is drawn before the first real measure.
 */
private fun DrawScope.drawWaveform(
    bars: FloatArray,
    step: Float,
    positionMs: Long,
    durationMs: Long,
    played: Color,
    unplayed: Color,
    playhead: Color,
) {
    val minBar = BAR_WIDTH.toPx()
    if (bars.isEmpty() || size.height < minBar) return

    val progressX = if (durationMs > 0L) {
        size.width * (positionMs.toFloat() / durationMs).coerceIn(0f, 1f)
    } else {
        0f
    }

    drawBars(bars, step, minBar, progressX, played, unplayed)
    // No duration means no meaningful position, so there is no line to put.
    if (durationMs > 0L) drawPlayhead(progressX, playhead)
}

/**
 * The bars themselves, [played] up to [progressX] and [unplayed] after it.
 *
 * Normalised to the loudest bar with a floor under it, and every bar at least
 * its own width tall. See the [WaveformScrubber] doc for why both.
 */
private fun DrawScope.drawBars(
    bars: FloatArray,
    step: Float,
    minBar: Float,
    progressX: Float,
    played: Color,
    unplayed: Color,
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
            color = if (x + barWidth <= progressX) played else unplayed,
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
private fun DrawScope.drawPlayhead(progressX: Float, color: Color) {
    val width = PLAYHEAD_WIDTH.toPx()
    drawRoundRect(
        color = color,
        topLeft = Offset((progressX - width / 2f).coerceIn(0f, size.width - width), 0f),
        size = Size(width, size.height),
        cornerRadius = CornerRadius(width / 2f, width / 2f),
    )
}

private fun timeAt(x: Float, width: Int, durationMs: Long): Long {
    if (width <= 0 || durationMs <= 0L) return 0L
    val fraction = (x / width).coerceIn(0f, 1f)
    return (fraction.toDouble() * durationMs).roundToLong()
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

/** What the block occupies in every phase. See the [PlaybackBar] doc. */
private val BLOCK_HEIGHT: Dp = WAVEFORM_HEIGHT + CONTROLS_HEIGHT + 16.dp

/** The quietest "loudest moment" we will normalise against. See [WaveformScrubber]. */
private const val MIN_LOUDEST = 0.02f
