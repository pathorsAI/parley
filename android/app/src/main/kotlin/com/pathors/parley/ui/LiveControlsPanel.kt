package com.pathors.parley.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.setProgress
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pathors.parley.R
import com.pathors.parley.ui.theme.ParleyTheme
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/** One line the panel has to say about the recording's health. */
internal data class PanelNotice(val text: String, val alarming: Boolean)

/**
 * The live meeting's controls, under the transcript: status, timer, level
 * meter, status lines, stop, discard.
 *
 * While [recording], the top edge can be dragged down to give the transcript
 * more room, and the panel stays wherever it is let go (see [LivePanel] for the
 * geometry and what drops out when). The height is remembered across meetings
 * in [LivePanelStore]. Before recording actually starts it is always fully
 * open, with no grabber — there is nothing to make room for yet.
 *
 * Whatever the height, an alarming [notices] entry stays visible: in full as the
 * status line, or as a warning mark beside the timer once that line has had to
 * go.
 */
@Composable
internal fun LiveControlsPanel(
    recording: Boolean,
    statusText: String,
    elapsedMs: Long,
    level: Float,
    notices: List<PanelNotice>,
    onStop: () -> Unit,
    onDiscard: () -> Unit,
    actions: @Composable RowScope.() -> Unit,
) {
    val context = LocalContext.current
    val store = remember(context) { LivePanelStore.default(context) }
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current

    // The stored fraction (0 compact … 1 full), and past either end while a
    // drag rubber-bands. Starts open: that is also the only way to measure it.
    val fraction = remember { Animatable(1f) }
    // What the content measures fully open. Zero until the first layout.
    var fullDp by remember { mutableFloatStateOf(0f) }
    var dragging by remember { mutableStateOf(false) }
    val dragHeightDp = remember { StateRef(0f) }
    val touched = remember { StateRef(false) }

    // A recording starting (or one being returned to) reopens the panel where
    // the user last left it. Waits for a measurement, and gives way to a drag
    // that got there first.
    LaunchedEffect(recording) {
        if (!recording) {
            fraction.snapTo(1f)
            return@LaunchedEffect
        }
        val saved = store.current()
        snapshotFlow { fullDp }.first { it > 0f }
        if (!touched.value) fraction.animateTo(saved, PanelSpring)
    }

    fun settle(target: Float) {
        touched.value = true
        scope.launch { fraction.animateTo(target, PanelSpring) }
        scope.launch { store.set(target) }
    }

    val current = if (recording) fraction.value else 1f
    // Fully open and at rest, the panel wraps its content — which is how the
    // open height gets (re)measured, e.g. when a warning line appears.
    val wrapping = !recording || fullDp <= 0f ||
        (!dragging && !fraction.isRunning && LivePanel.isFullyOpen(current))
    val heightDp = if (wrapping) fullDp else LivePanel.heightDp(current, fullDp)
    val shape = if (wrapping) LivePanel.shape(fullDp, fullDp) else LivePanel.shape(heightDp, fullDp)

    val dragState = rememberDraggableState { deltaPx ->
        val next = dragHeightDp.value - deltaPx / density.density
        dragHeightDp.value = next
        val shown = LivePanel.rubberBand(next, fullDp)
        scope.launch { fraction.snapTo(LivePanel.fraction(shown, fullDp)) }
    }

    Column(Modifier.fillMaxWidth()) {
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .then(
                    if (wrapping) Modifier.wrapContentHeight() else Modifier.height(heightDp.dp)
                )
                .clipToBounds()
                .onSizeChanged { size ->
                    if (wrapping) fullDp = size.height / density.density
                }
                .draggable(
                    state = dragState,
                    orientation = Orientation.Vertical,
                    enabled = recording && fullDp > 0f,
                    onDragStarted = {
                        touched.value = true
                        fraction.stop()
                        dragging = true
                        dragHeightDp.value = LivePanel.heightDp(fraction.value, fullDp)
                    },
                    onDragStopped = {
                        dragging = false
                        val shown = LivePanel.heightDp(fraction.value, fullDp)
                        settle(LivePanel.restingFraction(shown, fullDp))
                    },
                ),
        ) {
            if (shape.columnAlpha > 0f) {
                FullColumn(
                    shape = shape,
                    recording = recording,
                    statusText = statusText,
                    elapsedMs = elapsedMs,
                    level = level,
                    notices = notices,
                    onStop = onStop,
                    onDiscard = onDiscard,
                    actions = actions,
                )
            }
            if (recording && shape.rowAlpha > 0f) {
                CompactRow(
                    alpha = shape.rowAlpha,
                    elapsedMs = elapsedMs,
                    level = level,
                    notices = notices,
                    onStop = onStop,
                )
            }
            if (recording) {
                Grabber(
                    fraction = current,
                    onToggle = { settle(LivePanel.toggledFraction(current)) },
                    onSet = { settle(it) },
                )
            }
        }
    }
}

/**
 * Soft enough to read as the panel settling rather than snapping. Compose scales
 * it by the system animator duration, so with animations off it simply lands.
 */
private val PanelSpring = spring<Float>(
    dampingRatio = Spring.DampingRatioNoBouncy,
    stiffness = Spring.StiffnessMediumLow,
)

/** Room above the content for the grabber. */
private val GrabberBand = 20.dp

@Composable
private fun BoxScope.FullColumn(
    shape: LivePanelShape,
    recording: Boolean,
    statusText: String,
    elapsedMs: Long,
    level: Float,
    notices: List<PanelNotice>,
    onStop: () -> Unit,
    onDiscard: () -> Unit,
    actions: @Composable RowScope.() -> Unit,
) {
    Column(
        modifier = Modifier
            .align(Alignment.BottomCenter)
            .fillMaxWidth()
            // Taller than the panel mid-drag is fine: the column hangs from the
            // bottom and the band above it is what gets clipped.
            .wrapContentHeight(align = Alignment.Bottom, unbounded = true)
            .graphicsLayer { alpha = shape.columnAlpha }
            .padding(start = 16.dp, end = 16.dp, top = GrabberBand, bottom = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (shape.showsStatusRow) {
            StatusRow(recording = recording, text = statusText, actions = actions)
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            PanelTimer(elapsedMs = elapsedMs, sizeSp = shape.timerSp)
            if (!shape.showsStatusLine) HealthMark(notices, Modifier.padding(start = 8.dp))
        }
        if (shape.showsLevelMeter) {
            Spacer(Modifier.height(8.dp))
            LevelMeter(level = level, live = recording)
        }
        if (shape.showsStatusLine) {
            notices.forEach { notice ->
                Spacer(Modifier.height(8.dp))
                Text(
                    text = notice.text,
                    style = MaterialTheme.typography.bodySmall,
                    textAlign = TextAlign.Center,
                    color = if (notice.alarming) {
                        MaterialTheme.colorScheme.error
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                )
            }
        }
        Spacer(Modifier.height(12.dp))
        RoundStopButton(diameter = shape.stopDp.dp, onStop = onStop)
        if (shape.showsDiscard) {
            DiscardControl(onDiscard = onDiscard)
        } else {
            Spacer(Modifier.height(4.dp))
        }
    }
}

/** The red dot and what is happening, with the transcript's copy and share. */
@Composable
private fun StatusRow(recording: Boolean, text: String, actions: @Composable RowScope.() -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            modifier = Modifier.weight(1f).semantics(mergeDescendants = true) {},
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (recording) {
                RecordingDot()
                Spacer(Modifier.width(7.dp))
            }
            Text(
                text = text,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        actions()
    }
}

/** Collapsed: red dot, timer, a small level meter, stop. */
@Composable
private fun BoxScope.CompactRow(
    alpha: Float,
    elapsedMs: Long,
    level: Float,
    notices: List<PanelNotice>,
    onStop: () -> Unit,
) {
    Row(
        modifier = Modifier
            .align(Alignment.BottomCenter)
            .fillMaxWidth()
            .height((LivePanel.COMPACT_DP.dp - GrabberBand))
            .graphicsLayer { this.alpha = alpha }
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RecordingDot()
        Spacer(Modifier.width(8.dp))
        PanelTimer(elapsedMs = elapsedMs, sizeSp = LivePanel.TIMER_ROW_SP)
        HealthMark(notices, Modifier.padding(start = 6.dp))
        Spacer(Modifier.width(12.dp))
        LevelMeter(
            level = level,
            live = true,
            bars = 8,
            height = 14.dp,
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(12.dp))
        RoundStopButton(diameter = LivePanel.STOP_ROW_DP.dp, onStop = onStop)
    }
}

@Composable
private fun RecordingDot() {
    Box(
        Modifier
            .size(8.dp)
            .clip(CircleShape)
            .background(ParleyTheme.colors.recording)
    )
}

/**
 * The clock, sized by the panel. Still scales with the user's font size, but
 * only so far: at 56sp it is already the largest thing on the screen, and at
 * double that it would push the stop button out of the panel.
 */
@Composable
private fun PanelTimer(elapsedMs: Long, sizeSp: Float) {
    val fontScale = LocalDensity.current.fontScale
    val capped: TextUnit = (sizeSp * minOf(fontScale, MAX_TIMER_FONT_SCALE) / fontScale).sp
    Text(
        text = formatClock(elapsedMs),
        style = MaterialTheme.typography.displaySmall.copy(
            fontSize = capped,
            lineHeight = capped * 1.15f,
            fontFeatureSettings = "tnum",
        ),
        fontWeight = FontWeight.Medium,
    )
}

private const val MAX_TIMER_FONT_SCALE = 1.3f

/**
 * The health warnings, once there is no room left to spell them out: a mark in
 * the error colour that reads out every warning it stands for.
 */
@Composable
private fun HealthMark(notices: List<PanelNotice>, modifier: Modifier = Modifier) {
    val alarming = notices.filter { it.alarming }
    if (alarming.isEmpty()) return
    val description = alarming.joinToString("\n") { it.text }
    Icon(
        imageVector = Icons.Default.Warning,
        contentDescription = description,
        tint = MaterialTheme.colorScheme.error,
        modifier = modifier.size(18.dp),
    )
}

/**
 * Stop: the recording red disc with a white rounded square, the same glyph as
 * iOS (`LiveView.recordControl`). No label, because the screen already says it
 * is recording — this only has to be the thing you press. TalkBack reads
 * "Stop".
 */
@Composable
private fun RoundStopButton(diameter: Dp, onStop: () -> Unit) {
    val view = LocalView.current
    val label = stringResource(R.string.action_stop)
    Box(
        modifier = Modifier
            .size(diameter)
            .clip(CircleShape)
            .background(ParleyTheme.colors.recording)
            .clickable(role = Role.Button) {
                // On the tap, not when the upload lands: the beat answers the
                // press, and closing, draining and uploading are seconds of work.
                MeetingHaptics.recordingStopped(view)
                onStop()
            }
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .size(diameter * STOP_GLYPH_RATIO)
                .clip(RoundedCornerShape(diameter * 0.07f))
                // White in both appearances: the disc under it does not follow
                // the system appearance either.
                .background(MaterialTheme.colorScheme.onError)
        )
    }
}

private const val STOP_GLYPH_RATIO = 0.3f

/**
 * The drag handle. The whole panel drags; this is the part that says so, the
 * part a tap toggles open ↔ collapsed, and the part TalkBack can resize through
 * — as an adjustable value and as expand / collapse actions.
 */
@Composable
private fun BoxScope.Grabber(fraction: Float, onToggle: () -> Unit, onSet: (Float) -> Unit) {
    val describe = stringResource(R.string.meeting_panel_resize)
    val expand = stringResource(R.string.meeting_panel_expand)
    val collapse = stringResource(R.string.meeting_panel_collapse)
    val open = LivePanel.isFullyOpen(fraction)
    val compact = LivePanel.isCompact(fraction)
    Box(
        modifier = Modifier
            .align(Alignment.TopCenter)
            .width(96.dp)
            .height(48.dp)
            .clickable(
                role = Role.Button,
                onClickLabel = if (open) collapse else expand,
                onClick = onToggle,
            )
            .semantics {
                contentDescription = describe
                progressBarRangeInfo = ProgressBarRangeInfo(fraction.coerceIn(0f, 1f), 0f..1f)
                setProgress { target ->
                    onSet(target.coerceIn(0f, 1f))
                    true
                }
                customActions = buildList {
                    if (!open) add(CustomAccessibilityAction(expand) { onSet(1f); true })
                    if (!compact) add(CustomAccessibilityAction(collapse) { onSet(0f); true })
                }
            },
        contentAlignment = Alignment.TopCenter,
    ) {
        Box(
            Modifier
                .padding(top = 4.5.dp)
                .size(width = 36.dp, height = 5.dp)
                .clip(RoundedCornerShape(2.5.dp))
                .background(MaterialTheme.colorScheme.outlineVariant)
        )
    }
}
