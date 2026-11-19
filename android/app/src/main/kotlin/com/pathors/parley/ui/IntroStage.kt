package com.pathors.parley.ui

import android.content.Context
import android.provider.Settings
import androidx.annotation.StringRes
import androidx.compose.animation.Crossfade
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pathors.parley.R
import com.pathors.parley.kit.LapMotion
import com.pathors.parley.kit.LapMotion.WelcomeBeat
import com.pathors.parley.kit.LapMotion.WelcomeSchedule
import com.pathors.parley.kit.SampleManifest
import com.pathors.parley.ui.theme.ParleyTheme
import com.pathors.parley.ui.theme.ThemePreference
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.sin
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * What the welcome demo shows, read from the bundled sample: the call's first
 * two lines with who said them and when, the customer's folder, the title
 * Parley gave the call, its first two findings and first two action items.
 * iOS `IntroStage.init`.
 */
@Immutable
data class IntroFilm(
    val lines: List<Line>,
    val folderName: String,
    val cardTitle: String,
    val points: List<String>,
    val actions: List<String>,
) {
    /** [time] is where it was said, as the Record tab prints it: 0:12. */
    data class Line(val speaker: String, val isMe: Boolean, val text: String, val time: String)

    /** When everything happens — `LapMotion.WelcomeSchedule`, tested in parleykit. */
    val schedule: WelcomeSchedule = WelcomeSchedule(lines.map { it.text.length })

    companion object {
        private const val LINES = 2
        private const val ME = "me"

        fun of(manifest: SampleManifest): IntroFilm = IntroFilm(
            lines = manifest.segments.take(LINES).map { segment ->
                val isMe = segment.speaker == ME
                val seconds = (segment.startMs / 1000).toInt()
                Line(
                    speaker = if (isMe) manifest.speakers.me else manifest.speakers.them,
                    isMe = isMe,
                    text = segment.text,
                    time = "%d:%02d".format(seconds / 60, seconds % 60),
                )
            },
            folderName = manifest.suggestion?.folders?.firstOrNull()?.name.orEmpty(),
            cardTitle = manifest.suggestion?.title.orEmpty(),
            points = manifest.findings.orEmpty().take(LINES).map { it.field("title") },
            actions = manifest.actionItems.orEmpty().take(LINES).map { it.field("text") },
        )

        private fun kotlinx.serialization.json.JsonElement.field(name: String): String =
            ((this as? JsonObject)?.get(name))?.jsonPrimitive?.contentOrNull.orEmpty()
    }
}

/**
 * The welcome screen's demo: Parley in four steps — record, transcribe, file,
 * hand to AI. A port of iOS `IntroStage.swift`, itself the desktop's
 * `IntroStage` beat for beat, drawn with the phone app's own screens.
 *
 * The four steps land first as a row, then the demo walks through them one at
 * a time on a small phone screen over the app's tab bar: the Record tab starts
 * recording, two transcript lines type under their speakers; the Library shows
 * the new recording's row, which flies into its customer's folder chip; then
 * the recording's page fills in action items and the brief while the MCP plug
 * lights. Only the current step's part is at full strength. It rests on its
 * final frame, where Replay runs it again; tapping a step plays from that step.
 * With the system's animations removed it shows the final frame and offers
 * neither.
 *
 * Every piece is a pure function of the time since the run began, against
 * [IntroFilm.schedule] — one frame clock drives it all.
 */
@Composable
fun IntroStage(film: IntroFilm, modifier: Modifier = Modifier, frozenAt: Double? = null) {
    val context = LocalContext.current
    val schedule = film.schedule
    val reduceMotion = remember { animationsRemoved(context) }
    val still = frozenAt ?: schedule.end.takeIf { reduceMotion }
    var run by remember { mutableStateOf(Run(from = 0.0, serial = 0, fromOverview = true)) }
    val time = remember { mutableDoubleStateOf(still ?: 0.0) }

    LaunchedEffect(run, still) {
        if (still != null) {
            time.doubleValue = still
            return@LaunchedEffect
        }
        time.doubleValue = run.from
        val origin = withFrameNanos { it }
        while (time.doubleValue < schedule.end) {
            withFrameNanos { now -> time.doubleValue = run.from + (now - origin) / NANOS_PER_SECOND }
        }
    }

    val t = time.doubleValue
    val beat = schedule.beat(t)
    val interactive = still == null
    val play: (WelcomeBeat) -> Unit = { from ->
        run = Run(WelcomeSchedule.start(from), run.serial + 1, from == WelcomeBeat.OVERVIEW)
    }

    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        StepRow(schedule, t, beat, fromOverview = run.fromOverview && interactive, onPlay = play.takeIf { interactive })
        Phone(film, t, beat)
        Caption(beat, onReplay = if (interactive) ({ play(WelcomeBeat.OVERVIEW) }) else null)
    }
}

/** One run of the demo: where it starts and whether the row lands step by step. */
private data class Run(val from: Double, val serial: Int, val fromOverview: Boolean)

/** The desktop's ease, `cubic-bezier(.2,.8,.2,1)`. */
private val Ease = CubicBezierEasing(0.2f, 0.8f, 0.2f, 1f)

private fun <T> ease(ms: Int): FiniteAnimationSpec<T> = tween(ms, easing = Ease)

/** 0…1 over [duration] from [at], eased — the CSS keyframe animations as functions of time. */
private fun progress(t: Double, at: Double, duration: Double): Float {
    val x = ((t - at) / duration).coerceIn(0.0, 1.0)
    return (1 - (1 - x).pow(3)).toFloat()
}

/** Parts already shown step back while another step plays; at rest everything is full. */
private fun dim(part: WelcomeBeat, beat: WelcomeBeat): Float =
    if (beat != WelcomeBeat.READY && beat != part && beat > part) 0.4f else 1f

/** The iOS system greys the demo draws with. */
private class Greys(dark: Boolean) {
    val gray4 = Color(if (dark) 0xFF3A3A3C else 0xFFD1D1D6)
    val gray5 = Color(if (dark) 0xFF2C2C2E else 0xFFE5E5EA)
    val gray6 = Color(if (dark) 0xFF1C1C1E else 0xFFF2F2F7)
}

@Composable
private fun mini(size: Int, weight: FontWeight = FontWeight.Normal, tabular: Boolean = false): TextStyle =
    MaterialTheme.typography.bodySmall.copy(
        fontSize = size.sp,
        lineHeight = (size * 1.3f).sp,
        fontWeight = weight,
        fontFeatureSettings = if (tabular) "tnum" else null,
    )

// ── the step row ─────────────────────────────────────────────────────────────

private enum class StepState { UPCOMING, CURRENT, DONE }

/**
 * The four steps as a row, each a label over a bar: upcoming (muted), current
 * (blue, its bar filling), done (checked, full). Every column is as tall as
 * the tallest label and keeps its bar at the bottom.
 */
@Composable
private fun StepRow(
    schedule: WelcomeSchedule,
    t: Double,
    beat: WelcomeBeat,
    fromOverview: Boolean,
    onPlay: ((WelcomeBeat) -> Unit)?,
) {
    val labels = listOf(
        R.string.intro_step_record,
        R.string.intro_step_transcript,
        R.string.intro_step_file,
        R.string.intro_step_ai,
    )
    val primary = MaterialTheme.colorScheme.primary
    val greys = Greys(onboardingPalette().dark)
    val playHint = stringResource(R.string.intro_play_from_step)
    Row(
        Modifier
            .fillMaxWidth()
            .height(IntrinsicSize.Min),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        WelcomeBeat.STEPS.forEachIndexed { i, step ->
            val state = when {
                beat == step -> StepState.CURRENT
                beat > step -> StepState.DONE
                else -> StepState.UPCOMING
            }
            val rise = if (fromOverview) progress(t, WelcomeSchedule.overviewLanding(i), 0.4) else 1f
            val ink by animateColorAsState(
                when (state) {
                    StepState.UPCOMING -> MaterialTheme.colorScheme.onSurfaceVariant
                    StepState.CURRENT -> primary
                    StepState.DONE -> MaterialTheme.colorScheme.onSurface
                },
                ease(500),
                label = "step-ink",
            )
            val dot by animateColorAsState(
                if (state == StepState.UPCOMING) greys.gray5 else primary,
                ease(500),
                label = "step-dot",
            )
            val label = stringResource(labels[i])
            val fill = if (state == StepState.UPCOMING) 0f else schedule.fill(step, t).toFloat().coerceIn(0f, 1f)
            Column(
                Modifier
                    .weight(1f)
                    .fillMaxHeight()
                    .graphicsLayer {
                        alpha = rise
                        translationY = 6.dp.toPx() * (1f - rise)
                    }
                    .clickable(enabled = onPlay != null) { onPlay?.invoke(step) }
                    .clearAndSetSemantics { contentDescription = "$label. $playHint" },
            ) {
                Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    Box(
                        Modifier
                            .size(15.dp)
                            .background(dot, CircleShape),
                        contentAlignment = Alignment.Center,
                    ) {
                        if (state == StepState.DONE) {
                            Icon(Icons.Filled.Check, null, tint = Color.White, modifier = Modifier.size(9.dp))
                        } else {
                            Text(
                                "${i + 1}",
                                style = mini(9, FontWeight.SemiBold, tabular = true),
                                color = if (state == StepState.UPCOMING) MaterialTheme.colorScheme.onSurfaceVariant else Color.White,
                            )
                        }
                    }
                    Text(label, style = mini(12, FontWeight.Medium), color = ink, maxLines = 2)
                }
                Spacer(Modifier.weight(1f).heightIn(min = 8.dp))
                Box(
                    Modifier
                        .fillMaxWidth()
                        .height(4.dp)
                        .clip(CircleShape)
                        .background(greys.gray5),
                ) {
                    Box(
                        Modifier
                            .fillMaxWidth(fill)
                            .fillMaxHeight()
                            .background(primary, CircleShape),
                    )
                }
            }
        }
    }
}

// ── the phone ────────────────────────────────────────────────────────────────

/** Which of the app's own screens the demo is on. */
private enum class DemoScreen { RECORD, LIBRARY, DETAIL }

private fun screenFor(beat: WelcomeBeat): DemoScreen = when (beat) {
    WelcomeBeat.OVERVIEW, WelcomeBeat.RECORD, WelcomeBeat.TRANSCRIPT -> DemoScreen.RECORD
    WelcomeBeat.FOLDER -> DemoScreen.LIBRARY
    WelcomeBeat.MCP, WelcomeBeat.READY -> DemoScreen.DETAIL
}

/** A small phone screen: the current page over the floating tab bar. */
@Composable
private fun Phone(film: IntroFilm, t: Double, beat: WelcomeBeat) {
    val shape = RoundedCornerShape(24.dp)
    val screen = screenFor(beat)
    val description = stringResource(R.string.intro_how_it_works)
    Box(
        Modifier
            .fillMaxWidth()
            .height(320.dp)
            .clip(shape)
            .background(MaterialTheme.colorScheme.background)
            .border(0.5.dp, MaterialTheme.colorScheme.outlineVariant, shape)
            .clearAndSetSemantics { contentDescription = description },
    ) {
        Crossfade(targetState = screen, animationSpec = ease(400), label = "demo-screen") { shown ->
            Box(
                Modifier
                    .fillMaxSize()
                    .padding(bottom = 52.dp),
            ) {
                when (shown) {
                    DemoScreen.RECORD -> RecordScreen(film, t, beat)
                    DemoScreen.LIBRARY -> LibraryScreen(film, t)
                    DemoScreen.DETAIL -> DetailScreen(film, t)
                }
            }
        }
        TabBar(
            selected = if (screen == DemoScreen.RECORD) 0 else 1,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 8.dp),
        )
    }
}

/** The app's floating tab bar: Record, Library, Settings. */
@Composable
private fun TabBar(selected: Int, modifier: Modifier = Modifier) {
    val greys = Greys(onboardingPalette().dark)
    val tabs: List<Pair<ImageVector, Int>> = listOf(
        OnboardingIcons.RecordTab to R.string.intro_tab_record,
        OnboardingIcons.LibraryTab to R.string.intro_tab_library,
        Icons.Filled.Settings to R.string.intro_tab_settings,
    )
    Row(
        modifier
            .shadow(6.dp, CircleShape, clip = false)
            .clip(CircleShape)
            .background(greys.gray6)
            .border(0.5.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f), CircleShape)
            .padding(3.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        tabs.forEachIndexed { i, (icon, label) ->
            val tint by animateColorAsState(
                if (i == selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                ease(400),
                label = "tab-tint",
            )
            val wash by animateColorAsState(
                if (i == selected) greys.gray5 else Color.Transparent,
                ease(400),
                label = "tab-wash",
            )
            Column(
                Modifier
                    .size(width = 58.dp, height = 36.dp)
                    .background(wash, CircleShape),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Icon(icon, null, tint = tint, modifier = Modifier.size(14.dp))
                Text(stringResource(label), style = mini(8, FontWeight.Medium), color = tint, maxLines = 1)
            }
        }
    }
}

// ── Record tab ───────────────────────────────────────────────────────────────

@Composable
private fun RecordScreen(film: IntroFilm, t: Double, beat: WelcomeBeat) {
    Column(Modifier.fillMaxSize()) {
        Transcript(
            film,
            t,
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .alpha(dim(WelcomeBeat.TRANSCRIPT, beat)),
        )
        RecordPanel(t, beat, Modifier.alpha(dim(WelcomeBeat.RECORD, beat)))
    }
}

/** Two transcript lines typing in, under "speaker · time"; each speaker named once its line is in. */
@Composable
private fun Transcript(film: IntroFilm, t: Double, modifier: Modifier) {
    val primary = MaterialTheme.colorScheme.primary
    Column(
        modifier.padding(start = 14.dp, end = 14.dp, top = 16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        film.lines.forEachIndexed { index, line ->
            val shown = film.schedule.typedCount(index, t)
            if (shown > 0) {
                val done = film.schedule.lineDone(index, t)
                val named by animateFloatAsState(if (done) 1f else 0f, ease(400), label = "named")
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Row(Modifier.alpha(named), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                        Text(
                            line.speaker,
                            style = mini(10, FontWeight.Medium),
                            color = if (line.isMe) primary else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(
                            line.time,
                            style = mini(10, FontWeight.Medium, tabular = true),
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = TERTIARY),
                        )
                    }
                    Text(
                        LapMotion.typed(line.text, shown),
                        style = mini(13),
                        color = MaterialTheme.colorScheme.onSurface,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

/**
 * The Record tab's panel. Idle it is the clock at zero over the blue record
 * button; recording it gains the status line, the clock runs, the waveform
 * moves, and the button turns into the red stop.
 */
@Composable
private fun RecordPanel(t: Double, beat: WelcomeBeat, modifier: Modifier) {
    val recording = beat >= WelcomeBeat.RECORD
    val since = maxOf(0.0, t - WelcomeSchedule.start(WelcomeBeat.RECORD))
    val landing = if (recording) progress(t, WelcomeSchedule.start(WelcomeBeat.RECORD), 0.5) else 0f
    // `ob-blink`: 0.7 s each way between full and a quarter.
    val phase = (since % 1.4) / 0.7
    val blink = (if (phase <= 1) 1 - 0.75 * phase else 0.25 + 0.75 * (phase - 1)).toFloat()
    val seconds = if (recording) since.toInt() else 0
    val red = ParleyTheme.colors.recording
    val greys = Greys(onboardingPalette().dark)
    val divider = MaterialTheme.colorScheme.outlineVariant
    Column(
        modifier
            .fillMaxWidth()
            .drawBehind { drawLine(divider, Offset(0f, 0f), Offset(size.width, 0f), 0.5.dp.toPx()) }
            .padding(top = 6.dp, bottom = 4.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(
            Modifier
                .size(width = 28.dp, height = 3.dp)
                .background(greys.gray4, CircleShape),
        )
        Row(
            Modifier.alpha(landing),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            Box(
                Modifier
                    .size(6.dp)
                    .alpha(blink)
                    .background(red, CircleShape),
            )
            Text(
                stringResource(R.string.intro_recording_live),
                style = mini(10),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Text(
            "%d:%02d".format(seconds / 60, seconds % 60),
            style = mini(22, FontWeight.SemiBold, tabular = true),
            color = if (recording) {
                MaterialTheme.colorScheme.onSurface
            } else {
                MaterialTheme.colorScheme.onSurface.copy(alpha = TERTIARY)
            },
        )
        PanelWaveform(t, recording, greys)
        val scale = if (recording) 0.85f + 0.15f * landing else 1f
        Box(
            Modifier
                .size(34.dp)
                .graphicsLayer {
                    scaleX = scale
                    scaleY = scale
                }
                .background(if (recording) red else MaterialTheme.colorScheme.primary, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            if (recording) {
                Box(Modifier.size(11.dp).background(Color.White, RoundedCornerShape(2.dp)))
            } else {
                Box(Modifier.size(12.dp).background(Color.White, CircleShape))
            }
        }
    }
}

/** The panel's waveform: flat while idle, moving while recording. */
@Composable
private fun PanelWaveform(t: Double, live: Boolean, greys: Greys) {
    val primary = MaterialTheme.colorScheme.primary
    Canvas(Modifier.size(width = (BARS * 4 - 2).dp, height = 16.dp)) {
        val bar = 2.dp.toPx()
        val step = 4.dp.toPx()
        for (i in 0 until BARS) {
            val active = live && i >= BARS / 2
            val wobble = abs(sin(t * 5.3 + i * 0.9) * cos(t * 2.1 + i * 0.37))
            val h = if (active) (2 + 14 * wobble).dp.toPx() else bar
            val x = i * step + bar / 2
            drawLine(
                color = if (active) primary else greys.gray4,
                start = Offset(x, (size.height - h) / 2 + bar / 2),
                end = Offset(x, (size.height + h) / 2 - bar / 2),
                strokeWidth = bar,
                cap = StrokeCap.Round,
            )
        }
    }
}

private const val BARS = 36

// ── Library tab ──────────────────────────────────────────────────────────────

/**
 * The Library tab mid-filing: the folder chips over the list, the new
 * recording's row on top of it, which then flies into its customer's chip —
 * the chip lit for the step, flashing as the row lands.
 */
@Composable
private fun LibraryScreen(film: IntroFilm, t: Double) {
    val card = film.schedule.card(t)
    val flashing = film.schedule.folderFlashing(t)
    var chipCenter by remember { mutableStateOf(Offset.Zero) }
    var rowCenter by remember { mutableStateOf(Offset.Zero) }
    val appear by animateFloatAsState(
        if (card != WelcomeSchedule.Card.HIDDEN) 1f else 0f,
        ease(CARD_FLY_MS),
        label = "row-appear",
    )
    val fly by animateFloatAsState(
        if (card == WelcomeSchedule.Card.FLYING || card == WelcomeSchedule.Card.FILED) 1f else 0f,
        ease(CARD_FLY_MS),
        label = "row-fly",
    )
    val filed = card == WelcomeSchedule.Card.FILED

    Column(
        Modifier
            .fillMaxSize()
            .padding(start = 14.dp, end = 14.dp, top = 16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            stringResource(R.string.intro_tab_library),
            style = mini(20, FontWeight.Bold),
            color = MaterialTheme.colorScheme.onSurface,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            LibraryChip(stringResource(R.string.intro_chip_all), selected = true)
            LibraryChip(stringResource(R.string.intro_chip_unfiled), selected = false)
            LibraryChip(
                film.folderName,
                selected = false,
                lit = true,
                flashing = flashing,
                modifier = Modifier.onGloballyPositioned { chipCenter = it.boundsInRoot().center },
            )
        }
        Box {
            Column {
                PlaceholderRow()
                PlaceholderRow()
            }
            // The row keeps its place in the layout; it moves and fades only in
            // its own drawing layer, toward the chip.
            LibraryRow(
                film,
                Modifier
                    .onGloballyPositioned { rowCenter = it.boundsInRoot().center }
                    .graphicsLayer {
                        val toChip = chipCenter - rowCenter
                        translationX = toChip.x * fly
                        translationY = toChip.y * fly
                        val scale = (0.85f + 0.15f * appear) * (1f - 0.75f * fly)
                        scaleX = scale
                        scaleY = scale
                        alpha = if (filed) 0f else appear * (1f - 0.85f * fly)
                    },
            )
        }
    }
}

@Composable
private fun LibraryChip(
    label: String,
    selected: Boolean,
    modifier: Modifier = Modifier,
    lit: Boolean = false,
    flashing: Boolean = false,
) {
    val primary = MaterialTheme.colorScheme.primary
    val wash by animateFloatAsState(
        if (lit) (if (flashing) 0.22f else 0.1f) else 0f,
        ease(500),
        label = "chip-wash",
    )
    val ink = if (selected || lit) primary else MaterialTheme.colorScheme.onSurfaceVariant
    Column(modifier.width(IntrinsicSize.Max), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(
            Modifier
                .background(primary.copy(alpha = wash), CircleShape)
                .padding(horizontal = if (lit) 6.dp else 0.dp, vertical = if (lit) 3.dp else 0.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            if (lit) Icon(LibraryIcons.Folder, null, tint = ink, modifier = Modifier.size(10.dp))
            Text(
                label,
                style = mini(11, if (selected || lit) FontWeight.SemiBold else FontWeight.Normal),
                color = ink,
                maxLines = 1,
            )
        }
        Box(
            Modifier
                .fillMaxWidth()
                .height(1.dp)
                .background(if (selected) primary else Color.Transparent),
        )
    }
}

/** The new recording as the library lists it: LIVE, its title, a line. */
@Composable
private fun LibraryRow(film: IntroFilm, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(10.dp)
    Column(
        modifier
            .fillMaxWidth()
            .shadow(4.dp, shape, clip = false)
            .background(MaterialTheme.colorScheme.background, shape)
            .border(0.5.dp, MaterialTheme.colorScheme.outlineVariant, shape)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                stringResource(R.string.intro_live_badge),
                style = mini(9, FontWeight.SemiBold),
                color = ParleyTheme.colors.recording,
            )
            Text(
                film.cardTitle,
                style = mini(12, FontWeight.SemiBold),
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Text(
            film.points.firstOrNull().orEmpty(),
            style = mini(10),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** The rest of the list, as grey bars: there, but not what to look at. */
@Composable
private fun PlaceholderRow() {
    val greys = Greys(onboardingPalette().dark)
    val divider = MaterialTheme.colorScheme.outlineVariant
    Column(
        Modifier
            .fillMaxWidth()
            .drawBehind {
                drawLine(divider, Offset(0f, size.height), Offset(size.width, size.height), 0.5.dp.toPx())
            }
            .padding(vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Box(Modifier.size(width = 150.dp, height = 7.dp).background(greys.gray5, CircleShape))
        Box(Modifier.size(width = 210.dp, height = 6.dp).background(greys.gray6, CircleShape))
    }
}

// ── the recording's page ─────────────────────────────────────────────────────

/**
 * The meeting over: its page, filed under the customer, on the summary face —
 * action items, then the brief — with the MCP plug lighting up as the record is
 * handed to Claude or ChatGPT.
 */
@Composable
private fun DetailScreen(film: IntroFilm, t: Double) {
    val total = film.actions.size + film.points.size
    val shown = film.schedule.reportLines(total, t)
    val primary = MaterialTheme.colorScheme.primary
    val greys = Greys(onboardingPalette().dark)
    Column(
        Modifier
            .fillMaxSize()
            .padding(start = 14.dp, end = 14.dp, top = 14.dp),
        verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(
                Icons.AutoMirrored.Filled.KeyboardArrowLeft,
                null,
                tint = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.size(16.dp),
            )
            Text(
                film.cardTitle,
                style = mini(12, FontWeight.SemiBold),
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            McpPlug(film.schedule.plugLit(t), greys)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
            Icon(LibraryIcons.Folder, null, tint = primary, modifier = Modifier.size(10.dp))
            Text(film.folderName, style = mini(10, FontWeight.Medium), color = primary)
            Icon(Icons.Filled.KeyboardArrowDown, null, tint = primary, modifier = Modifier.size(10.dp))
        }
        Row(
            Modifier
                .fillMaxWidth()
                .background(greys.gray6, CircleShape)
                .padding(2.dp),
        ) {
            Box(
                Modifier
                    .weight(1f)
                    .heightIn(min = 22.dp)
                    .background(MaterialTheme.colorScheme.background, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    stringResource(R.string.intro_summary),
                    style = mini(10, FontWeight.SemiBold),
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
            Box(Modifier.weight(1f).heightIn(min = 22.dp), contentAlignment = Alignment.Center) {
                Text(
                    stringResource(R.string.intro_transcript),
                    style = mini(10),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        ReportSection(R.string.intro_action_items, film.actions, offset = 0, shown = shown, t = t, film = film, action = true)
        ReportSection(R.string.intro_brief, film.points, offset = film.actions.size, shown = shown, t = t, film = film, action = false)
    }
}

/** The MCP plug: greyed until the hand-off, then lit. */
@Composable
private fun McpPlug(lit: Boolean, greys: Greys) {
    val primary = MaterialTheme.colorScheme.primary
    val light by animateFloatAsState(if (lit) 1f else 0f, ease(500), label = "plug")
    val tint = androidx.compose.ui.graphics.lerp(
        MaterialTheme.colorScheme.onSurface.copy(alpha = TERTIARY),
        primary,
        light,
    )
    val fill = androidx.compose.ui.graphics.lerp(greys.gray6, primary.copy(alpha = 0.1f), light)
    Box(
        Modifier
            .size(26.dp)
            .background(fill, CircleShape)
            .border(2.dp, primary.copy(alpha = 0.25f * light), CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Icon(OnboardingIcons.Plug, null, tint = tint, modifier = Modifier.size(13.dp))
    }
}

@Composable
private fun ReportSection(
    @StringRes title: Int,
    rows: List<String>,
    offset: Int,
    shown: Int,
    t: Double,
    film: IntroFilm,
    action: Boolean,
) {
    Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Text(
            stringResource(title),
            style = mini(10, FontWeight.SemiBold),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        rows.forEachIndexed { i, text ->
            if (offset + i < shown) {
                val rise = progress(t, film.schedule.reportLineStart(offset + i), 0.4)
                Row(
                    Modifier.graphicsLayer {
                        alpha = rise
                        translationY = 6.dp.toPx() * (1f - rise)
                    },
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    if (action) {
                        Icon(
                            OnboardingIcons.Circle,
                            null,
                            tint = MaterialTheme.colorScheme.onSurface.copy(alpha = TERTIARY),
                            modifier = Modifier.size(11.dp),
                        )
                    } else {
                        Box(Modifier.size(width = 2.dp, height = 11.dp).background(MaterialTheme.colorScheme.onSurface))
                    }
                    Text(
                        text,
                        style = mini(12, if (action) FontWeight.Normal else FontWeight.Medium),
                        color = MaterialTheme.colorScheme.onSurface,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

// ── the caption ──────────────────────────────────────────────────────────────

/** One line naming the beat, and Replay at rest. */
@Composable
private fun Caption(beat: WelcomeBeat, onReplay: (() -> Unit)?) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 22.dp),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Crossfade(targetState = beat, animationSpec = ease(400), modifier = Modifier.weight(1f), label = "caption") {
            Text(
                stringResource(captionOf(it)),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (beat == WelcomeBeat.READY && onReplay != null) {
            Row(
                Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .clickable(onClick = onReplay)
                    .padding(horizontal = 4.dp, vertical = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Icon(Icons.Filled.Refresh, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(14.dp))
                Text(
                    stringResource(R.string.intro_replay),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
        }
    }
}

@StringRes
private fun captionOf(beat: WelcomeBeat): Int = when (beat) {
    WelcomeBeat.OVERVIEW -> R.string.intro_caption_overview
    WelcomeBeat.RECORD -> R.string.intro_caption_record
    WelcomeBeat.TRANSCRIPT -> R.string.intro_caption_transcript
    WelcomeBeat.FOLDER -> R.string.intro_caption_folder
    WelcomeBeat.MCP -> R.string.intro_caption_mcp
    WelcomeBeat.READY -> R.string.intro_caption_ready
}

/**
 * Whether the system's animations are off — Settings › Accessibility › "Remove
 * animations", which zeroes the animator duration scale.
 */
private fun animationsRemoved(context: Context): Boolean =
    Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f

private const val NANOS_PER_SECOND = 1_000_000_000.0
private const val TERTIARY = 0.3f
private val CARD_FLY_MS = (WelcomeSchedule.CARD_FLY * 1000).toInt()

// ── previews ─────────────────────────────────────────────────────────────────

/** A cast for previews, the zh-TW sample's opening. */
internal val previewIntroFilm = IntroFilm(
    lines = listOf(
        IntroFilm.Line("你", isMe = true, text = "林經理午安，謝謝您今天抽時間。", time = "0:00"),
        IntroFilm.Line("林經理", isMe = false, text = "旺季一天大概三百多通，平常兩百左右。", time = "0:06"),
    ),
    folderName = "泓昇科技",
    cardTitle = "泓昇科技 · 客服語音系統需求訪談",
    points = listOf("夜間漏接是最大痛點", "六成以上是重複性查詢"),
    actions = listOf("今天下班前寄導入數據與報價給林經理", "下週三 15:00 demo"),
)

@Composable
private fun StagePreview(at: Double, preference: ThemePreference = ThemePreference.LIGHT) {
    ParleyTheme(preference = preference) {
        Surface {
            IntroStage(previewIntroFilm, Modifier.padding(24.dp), frozenAt = at)
        }
    }
}

@Preview(name = "Welcome demo — the final frame", showBackground = true, widthDp = 380)
@Composable
private fun IntroStageFinalPreview() = StagePreview(previewIntroFilm.schedule.end)

@Preview(name = "Welcome demo — recording", showBackground = true, widthDp = 380)
@Composable
private fun IntroStageRecordPreview() = StagePreview(WelcomeSchedule.start(WelcomeBeat.TRANSCRIPT) + 0.6)

@Preview(name = "Welcome demo — filing", showBackground = true, widthDp = 380)
@Composable
private fun IntroStageFilingPreview() = StagePreview(WelcomeSchedule.start(WelcomeBeat.FOLDER) + 0.4)

@Preview(name = "Welcome demo — dark, final frame", showBackground = true, widthDp = 380)
@Composable
private fun IntroStageDarkPreview() = StagePreview(previewIntroFilm.schedule.end, ThemePreference.DARK)
