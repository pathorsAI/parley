package com.pathors.parley.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.ceil
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The live level history: capsule-ended bars symmetric about a centreline,
 * newest at the right edge, the whole field scrolling left while the meeting
 * records — iOS `WaveformView` as #371 left it.
 *
 * It replaces a 12-segment level meter. A meter only answers "is sound
 * arriving", which the recording dot already answers; a scrolling history
 * answers "did it hear the last thing I said", which is the question someone
 * has while the phone sits on a table in the middle of a meeting.
 *
 * The weight is the point, and it is iOS's: thick bars, pale, half height. Only
 * the freshest few are drawn near full strength so "it heard me just now" stays
 * legible, and the history recedes. Idle there is no signal and so no blue — a
 * dotted grey centreline that says the field is waiting.
 *
 * ## Where the data comes from
 *
 * [level] is the RMS `MicCapture` already computes per 100 ms chunk. This
 * samples it on the same cadence rather than on every emission, because a
 * `StateFlow` swallows a repeated value and silence repeats — iOS needs a
 * separate `micSample` counter for the same reason. Between samples the field
 * glides instead of jumping a bar every 100 ms: the offset is interpolated from
 * how long ago the last sample landed, which is the only reason this needs a
 * frame clock at all, and the frame loop exists only while [active].
 */
@Composable
internal fun LiveWaveform(
    level: Float,
    active: Boolean,
    modifier: Modifier = Modifier,
    height: Dp = LiveWaveformShape.HEIGHT,
) {
    val currentLevel by rememberUpdatedState(level)
    val history = remember { LevelHistory(LiveWaveformShape.CAPACITY) }
    // Snapshot state only so the canvas redraws: the draw block reads both, so
    // a new frame or a new sample invalidates the draw and nothing else.
    var lastSampleNanos by remember { mutableLongStateOf(0L) }
    var frameNanos by remember { mutableLongStateOf(0L) }

    LaunchedEffect(active) {
        if (!active) {
            // The next meeting starts from an empty field, not this one's tail.
            history.clear()
            lastSampleNanos = 0L
            frameNanos = 0L
            return@LaunchedEffect
        }
        launch {
            while (true) {
                history.append(currentLevel)
                lastSampleNanos = System.nanoTime()
                delay(LiveWaveformShape.INTERVAL_MS)
            }
        }
        while (true) {
            withFrameNanos { frameNanos = System.nanoTime() }
        }
    }

    val signal = MaterialTheme.colorScheme.primary
    val idle = MaterialTheme.colorScheme.outline.copy(alpha = LiveWaveformShape.IDLE_ALPHA)

    Canvas(
        modifier
            .fillMaxWidth()
            .height(height)
            // A waveform says nothing a screen reader can use, and the status
            // line beside it already says the recording is running.
            .clearAndSetSemantics {},
    ) {
        val barWidth = LiveWaveformShape.BAR_WIDTH.toPx()
        val step = barWidth + LiveWaveformShape.GAP.toPx()
        val minBar = LiveWaveformShape.MIN_BAR.toPx()
        if (size.width <= step || size.height <= minBar) return@Canvas

        // One extra bar so the one sliding off the left edge is drawn while it
        // is still half visible.
        val visible = ceil(size.width / step).toInt() + 1
        val frames = history.lastPadded(visible)
        val progress = if (active) {
            LiveWaveformShape.glide(frameNanos - lastSampleNanos)
        } else {
            0f
        }
        val shift = progress * step
        val midY = size.height / 2f
        val corner = CornerRadius(barWidth / 2f)

        frames.forEachIndexed { index, value ->
            val fromRight = frames.size - 1 - index
            val x = size.width - barWidth - fromRight * step - shift
            if (x + barWidth <= 0f || x >= size.width) return@forEachIndexed
            val barHeight = LiveWaveformShape.barHeight(value, size.height, minBar)
            val color = if (active) {
                signal.copy(alpha = LiveWaveformShape.opacity(fromRight))
            } else {
                idle
            }
            drawRoundRect(
                color = color,
                topLeft = Offset(x, midY - barHeight / 2f),
                size = Size(barWidth, barHeight),
                cornerRadius = corner,
            )
        }
    }
}

/**
 * The waveform's geometry and weights, kept apart from the composable so they
 * can be tested without Compose. The same numbers as iOS `WaveformView`.
 */
internal object LiveWaveformShape {
    /** 3dp bars, 2dp apart, ends rounded by half the width. */
    val BAR_WIDTH = 3.dp
    val GAP = 2.dp

    /** Silence is still a mark: at one bar width the floor draws as a dot. */
    val MIN_BAR = 3.dp

    /** Glanceable, not screen-filling. */
    val HEIGHT = 28.dp

    /** `MicCapture`'s chunk: one level every 100 ms. */
    const val INTERVAL_MS = 100L
    private const val INTERVAL_NANOS = INTERVAL_MS * 1_000_000f

    /** More than the widest phone's field holds, small enough not to matter. */
    const val CAPACITY = 256

    /**
     * Speech RMS lives around 0.05–0.3, so ×6 puts normal talking near the top
     * of the field without clipping every syllable.
     */
    const val GAIN = 6f

    /** History sits at this much of the blue: present, not shouting. */
    const val HISTORY_ALPHA = 0.35f

    /** The newest bar, and how many bars it takes to fade back to history. */
    const val FRESH_ALPHA = 0.9f
    const val FRESH_COUNT = 6

    /** The idle centreline, as a fraction of the outline grey. */
    const val IDLE_ALPHA = 0.5f

    /** A bar's height for an RMS [value]: never below [minBar], never past [height]. */
    fun barHeight(value: Float, height: Float, minBar: Float): Float {
        val scaled = (value * GAIN).coerceIn(0f, 1f)
        return minBar + (height - minBar) * scaled
    }

    /** Full strength at the right edge, easing back to history over [FRESH_COUNT] bars. */
    fun opacity(fromRight: Int): Float {
        if (fromRight >= FRESH_COUNT) return HISTORY_ALPHA
        val t = fromRight.coerceAtLeast(0).toFloat() / FRESH_COUNT
        return FRESH_ALPHA - (FRESH_ALPHA - HISTORY_ALPHA) * t
    }

    /** How far through the current sample window [sinceSampleNanos] is, 0…1. */
    fun glide(sinceSampleNanos: Long): Float =
        (sinceSampleNanos / INTERVAL_NANOS).coerceIn(0f, 1f)
}

/**
 * A fixed-size ring of levels, oldest first. Plain state on purpose: the
 * waveform's frame clock is what redraws it, and a snapshot write per sample
 * would recompose for nothing.
 */
internal class LevelHistory(private val capacity: Int) {
    private val values = FloatArray(capacity)
    private var start = 0
    var size = 0
        private set

    fun append(value: Float) {
        if (size < capacity) {
            values[(start + size) % capacity] = value
            size++
        } else {
            values[start] = value
            start = (start + 1) % capacity
        }
    }

    fun clear() {
        start = 0
        size = 0
    }

    /**
     * The newest [count] levels, oldest first, with silence in front when there
     * are fewer: the field starts full of silence rather than filling in from
     * the right, which would read as a broken layout for the first seconds of
     * every meeting.
     */
    fun lastPadded(count: Int): FloatArray {
        val out = FloatArray(count)
        val take = minOf(count, size)
        for (i in 0 until take) {
            out[count - take + i] = values[(start + size - take + i) % capacity]
        }
        return out
    }
}
