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
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/** One line the panel has to say about the recording's health, and how to draw it. */
internal data class PanelNotice(val text: String, val tone: NoticeTone) {
    val needsAttention: Boolean get() = tone.needsAttention
}

/**
 * What the panel reports about the meeting: whether it is [recording] yet, the
 * status line, the clock, the input [level] (0…1) and the health [notices].
 */
@Immutable
internal data class LiveReadout(
    val recording: Boolean,
    val statusText: String,
    val elapsedMs: Long,
    val level: Float,
    val notices: List<PanelNotice>,
)

/**
 * The live meeting's controls, under the transcript: status, timer, waveform,
 * status lines, stop, discard.
 *
 * While recording, the top edge can be dragged down to give the transcript
 * more room, and the panel stays wherever it is let go (see [LivePanel] for the
 * geometry and what drops out when). The height is remembered across meetings
 * in [LivePanelStore]. Before recording actually starts it is always fully
 * open, with no grabber — there is nothing to make room for yet.
 *
 * Whatever the height, a [LiveReadout.notices] entry that needs attention stays
 * visible: in full as the status line, or as its mark beside the timer once
 * that line has had to go (see [HealthMark]).
 */
@Composable
internal fun LiveControlsPanel(
    readout: LiveReadout,
    onStop: () -> Unit,
    onDiscard: () -> Unit,
    actions: @Composable RowScope.() -> Unit,
) {
    val recording = readout.recording
    val panel = rememberPanelHeight(recording)
    val density = LocalDensity.current.density

    val current = panel.current(recording)
    // Fully open and at rest, the panel wraps its content — which is how the
    // open height gets (re)measured, e.g. when a warning line appears.
    val wrapping = panel.wraps(recording)
    val heightDp = if (wrapping) panel.fullDp else LivePanel.heightDp(current, panel.fullDp)
    val shape = LivePanel.shape(heightDp, panel.fullDp)

    val dragState = rememberDraggableState { deltaPx -> panel.drag(deltaPx, density) }

    Column(Modifier.fillMaxWidth()) {
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .then(
                    if (wrapping) Modifier.wrapContentHeight() else Modifier.height(heightDp.dp)
                )
                .clipToBounds()
                .onSizeChanged { size -> panel.measured(size.height / density, wrapping) }
                .draggable(
                    state = dragState,
                    orientation = Orientation.Vertical,
                    enabled = panel.canDrag(recording),
                    onDragStarted = { panel.dragStarted() },
                    onDragStopped = { panel.dragStopped() },
                ),
        ) {
            if (shape.columnAlpha > 0f) {
                FullColumn(
                    shape = shape,
                    readout = readout,
                    onStop = onStop,
                    onDiscard = onDiscard,
                    actions = actions,
                )
            }
            if (recording) {
                RecordingOverlays(
                    rowAlpha = shape.rowAlpha,
                    fraction = current,
                    readout = readout,
                    onStop = onStop,
                    onSettle = panel::settle,
                )
            }
        }
    }
}

/**
 * The panel's height and the drag that changes it. [fraction] is the stored
 * fraction (0 compact … 1 full), and past either end while a drag
 * rubber-bands; it starts open, which is also the only way to measure it.
 * [fullDp] is what the content measures fully open, zero until the first
 * layout.
 */
@Stable
private class PanelHeight(
    private val store: LivePanelStore,
    private val scope: CoroutineScope,
) {
    val fraction = Animatable(1f)
    var fullDp by mutableFloatStateOf(0f)
        private set
    private var dragging by mutableStateOf(false)
    private var dragHeightDp = 0f
    private var touched = false

    /** The fraction to lay out at: always fully open before recording starts. */
    fun current(recording: Boolean): Float = if (recording) fraction.value else 1f

    /** Whether the panel wraps its content rather than being held at a height. */
    fun wraps(recording: Boolean): Boolean = !recording || fullDp <= 0f ||
        (!dragging && !fraction.isRunning && LivePanel.isFullyOpen(fraction.value))

    fun canDrag(recording: Boolean): Boolean = recording && fullDp > 0f

    /**
     * A recording starting (or one being returned to) reopens the panel where
     * the user last left it. Waits for a measurement, and gives way to a drag
     * that got there first.
     */
    suspend fun reopen(recording: Boolean) {
        if (!recording) {
            fraction.snapTo(1f)
            return
        }
        val saved = store.current()
        snapshotFlow { fullDp }.first { it > 0f }
        if (!touched) fraction.animateTo(saved, PanelSpring)
    }

    /** The content laid out at [heightDp]; only a wrapping panel is a measurement. */
    fun measured(heightDp: Float, wrapping: Boolean) {
        if (wrapping) fullDp = heightDp
    }

    fun settle(target: Float) {
        touched = true
        scope.launch { fraction.animateTo(target, PanelSpring) }
        scope.launch { store.set(target) }
    }

    suspend fun dragStarted() {
        touched = true
        fraction.stop()
        dragging = true
        dragHeightDp = LivePanel.heightDp(fraction.value, fullDp)
    }

    fun drag(deltaPx: Float, density: Float) {
        val next = dragHeightDp - deltaPx / density
        dragHeightDp = next
        val shown = LivePanel.rubberBand(next, fullDp)
        scope.launch { fraction.snapTo(LivePanel.fraction(shown, fullDp)) }
    }

    fun dragStopped() {
        dragging = false
        val shown = LivePanel.heightDp(fraction.value, fullDp)
        settle(LivePanel.restingFraction(shown, fullDp))
    }
}

/** The panel's height, reopened to the stored one whenever [recording] starts. */
@Composable
private fun rememberPanelHeight(recording: Boolean): PanelHeight {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val panel = remember { PanelHeight(LivePanelStore.default(context), scope) }
    LaunchedEffect(recording) { panel.reopen(recording) }
    return panel
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
    readout: LiveReadout,
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
            StatusRow(recording = readout.recording, text = readout.statusText, actions = actions)
        }
        TimerLine(shape = shape, elapsedMs = readout.elapsedMs, notices = readout.notices)
        if (shape.showsWaveform) {
            Spacer(Modifier.height(8.dp))
            LiveWaveform(level = readout.level, active = readout.recording)
        }
        if (shape.showsStatusLine) {
            NoticeLines(readout.notices)
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

/** The clock, with the warning mark beside it once the status lines are gone. */
@Composable
private fun TimerLine(shape: LivePanelShape, elapsedMs: Long, notices: List<PanelNotice>) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        PanelTimer(elapsedMs = elapsedMs, sizeSp = shape.timerSp)
        if (!shape.showsStatusLine) HealthMark(notices, Modifier.padding(start = 8.dp))
    }
}

/** Every notice spelled out, each drawn in its [NoticeTone]. */
@Composable
private fun NoticeLines(notices: List<PanelNotice>) {
    notices.forEach { notice ->
        Spacer(Modifier.height(8.dp))
        NoticeLine(notice)
    }
}

/**
 * One status line. Its look is the news as much as its words are — iOS
 * `LiveView.statusLine`: a reconnect is an amber spinner, the end of the live
 * transcript is ink with a bolt (the recording is fine, so not red), and only a
 * threat to the recording itself is the error colour.
 */
@Composable
internal fun NoticeLine(notice: PanelNotice, modifier: Modifier = Modifier) {
    val color = noticeColor(notice.tone)
    Row(
        modifier = modifier.semantics(mergeDescendants = true) {},
        verticalAlignment = Alignment.CenterVertically,
    ) {
        when (notice.tone) {
            NoticeTone.RECONNECTING -> {
                ReconnectingSpinner(size = 12.dp)
                Spacer(Modifier.width(6.dp))
            }
            NoticeTone.TRANSCRIPT_STOPPED -> {
                Icon(
                    imageVector = MeetingIcons.TranscriptStopped,
                    contentDescription = null,
                    tint = color,
                    modifier = Modifier.size(14.dp),
                )
                Spacer(Modifier.width(6.dp))
            }
            NoticeTone.INFO, NoticeTone.ALARM -> Unit
        }
        Text(
            text = notice.text,
            style = MaterialTheme.typography.bodySmall,
            textAlign = TextAlign.Center,
            color = color,
        )
    }
}

@Composable
private fun noticeColor(tone: NoticeTone): Color = when (tone) {
    NoticeTone.INFO -> MaterialTheme.colorScheme.onSurfaceVariant
    NoticeTone.RECONNECTING -> ParleyTheme.colors.warning
    // Full-weight ink rather than red: the live transcript is over, but the
    // recording is not, and colouring this like a failure would say the
    // opposite of what the sentence says.
    NoticeTone.TRANSCRIPT_STOPPED -> MaterialTheme.colorScheme.onSurface
    NoticeTone.ALARM -> MaterialTheme.colorScheme.error
}

/** iOS's mini `ProgressView` tinted amber: a pause that is being worked on. */
@Composable
private fun ReconnectingSpinner(size: Dp) {
    CircularProgressIndicator(
        modifier = Modifier.size(size),
        color = ParleyTheme.colors.warning,
        strokeWidth = 1.5.dp,
    )
}

/**
 * What only a recording panel has, over the column: the compact row as it
 * fades in, and the grabber. [onSettle] moves the panel to a fraction.
 */
@Composable
private fun BoxScope.RecordingOverlays(
    rowAlpha: Float,
    fraction: Float,
    readout: LiveReadout,
    onStop: () -> Unit,
    onSettle: (Float) -> Unit,
) {
    if (rowAlpha > 0f) {
        CompactRow(alpha = rowAlpha, readout = readout, onStop = onStop)
    }
    Grabber(
        fraction = fraction,
        onToggle = { onSettle(LivePanel.toggledFraction(fraction)) },
        onSet = { onSettle(it) },
    )
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

/** Collapsed: red dot, timer, the health mark, the waveform in whatever width is left, stop. */
@Composable
private fun BoxScope.CompactRow(alpha: Float, readout: LiveReadout, onStop: () -> Unit) {
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
        PanelTimer(elapsedMs = readout.elapsedMs, sizeSp = LivePanel.TIMER_ROW_SP)
        HealthMark(readout.notices, Modifier.padding(start = 6.dp))
        Spacer(Modifier.width(12.dp))
        LiveWaveform(
            level = readout.level,
            active = true,
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
 * The health lines, once there is no room left to spell them out: the most
 * urgent one's mark, in the same glyph and colour as its line (see
 * [NoticeLine]) so it reads as the same news at a smaller size — a warning
 * triangle for a threat to the recording, the amber spinner for a reconnect,
 * the ink bolt for a live transcript that is over. TalkBack reads out every
 * line it stands for.
 *
 * The notices arrive most urgent first, so the first one that needs attention
 * picks the mark.
 */
@Composable
private fun HealthMark(notices: List<PanelNotice>, modifier: Modifier = Modifier) {
    val attention = notices.filter { it.needsAttention }
    val lead = attention.firstOrNull() ?: return
    val description = attention.joinToString("\n") { it.text }
    Box(
        modifier = modifier
            .size(18.dp)
            .clearAndSetSemantics { contentDescription = description },
        contentAlignment = Alignment.Center,
    ) {
        when (lead.tone) {
            NoticeTone.RECONNECTING -> ReconnectingSpinner(size = 14.dp)
            NoticeTone.TRANSCRIPT_STOPPED -> Icon(
                imageVector = MeetingIcons.TranscriptStopped,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.size(18.dp),
            )
            NoticeTone.ALARM, NoticeTone.INFO -> Icon(
                imageVector = Icons.Default.Warning,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.error,
                modifier = Modifier.size(18.dp),
            )
        }
    }
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
