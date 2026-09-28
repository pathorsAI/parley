package com.pathors.parley.ui

import android.content.Context
import android.provider.Settings
import androidx.annotation.StringRes
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.pathors.parley.R
import com.pathors.parley.kit.LapMotion
import com.pathors.parley.kit.SampleManifest
import com.pathors.parley.ui.theme.ParleyPalette
import com.pathors.parley.ui.theme.ParleyTheme
import com.pathors.parley.ui.theme.ThemePreference

/**
 * What the sign-in page's film shows, read from the bundled sample: the call's
 * first three lines (clipped to fit) with who said them, the customer's folder
 * and the title Parley gave the call.
 */
@Immutable
data class IntroFilm(
    val lines: List<Line>,
    val folderName: String,
    val cardTitle: String,
) {
    data class Line(val speaker: String, val isMe: Boolean, val text: String)

    /** When everything happens — `LapMotion.introBeats`, tested in parleykit. */
    val schedule: LapMotion.IntroSchedule = LapMotion.introBeats(lines.map { it.text.length })

    companion object {
        private const val LINES = 3
        private const val ME = "me"

        /** The film for [manifest]: iOS `IntroStage.init`. */
        fun of(manifest: SampleManifest): IntroFilm = IntroFilm(
            lines = manifest.segments.take(LINES).map { segment ->
                val isMe = segment.speaker == ME
                Line(
                    speaker = if (isMe) manifest.speakers.me else manifest.speakers.them,
                    isMe = isMe,
                    text = LapMotion.clip(segment.text),
                )
            },
            folderName = manifest.suggestion?.folders?.firstOrNull()?.name.orEmpty(),
            cardTitle = manifest.suggestion?.title.orEmpty(),
        )
    }
}

/**
 * The sign-in page's little film: the product's four beats, assembling
 * themselves once in about seven seconds and then resting. A port of iOS
 * `IntroStage.swift` (#450).
 *
 * The page used to carry three static points, which said what the app does in
 * the one register nobody reads on a first screen. This shows it instead, with
 * the app's own pieces in the app's own visual language (plain text, hairlines,
 * one tint): a recording starts; the sample call's first three lines type
 * themselves in with who said them; the suggestion card flies into the
 * customer's folder; the share mark lights. One caption under the stage names
 * the beat.
 *
 * Every piece is a pure function of the time since the stage appeared, against
 * [IntroFilm.schedule]. It plays once — a rotation keeps the final frame rather
 * than replaying. With the system's animations removed (Settings ›
 * Accessibility › "Remove animations") it starts on its final frame. TalkBack
 * reads the three points the page used to print, rather than a film it cannot
 * see.
 *
 * [frozenAt] pins the clock (seconds), for previews; null plays the film.
 */
@Composable
fun IntroStage(film: IntroFilm, modifier: Modifier = Modifier, frozenAt: Double? = null) {
    val context = LocalContext.current
    val removed = remember { animationsRemoved(context) }
    val still = frozenAt ?: film.schedule.end.takeIf { removed }
    val clock = rememberFilmClock(film.schedule.end, still)
    val t = clock.value
    val description = listOf(R.string.intro_point_record, R.string.intro_point_folder, R.string.intro_point_share)
        .map { stringResource(it) }
        .joinToString(". ")

    Column(
        modifier = modifier.clearAndSetSemantics { contentDescription = description },
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = STAGE_MIN_HEIGHT),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            RecordingPill(film.schedule, t)
            Transcript(film, t)
            FolderBeat(film, t)
            ShareMark(film.schedule, t)
        }
        Caption(film.schedule.beat(t) ?: LapMotion.IntroBeat.RECORDING)
    }
}

/**
 * Seconds since the stage appeared, one value per frame until the film ends.
 * [still] non-null holds the clock there instead.
 */
@Composable
private fun rememberFilmClock(end: Double, still: Double?): State<Double> {
    val played = rememberSaveable { mutableStateOf(false) }
    val time = remember { mutableDoubleStateOf(still ?: if (played.value) end else 0.0) }
    LaunchedEffect(end, still) {
        if (still != null || played.value) {
            time.doubleValue = still ?: end
            return@LaunchedEffect
        }
        val start = withFrameNanos { it }
        while (time.doubleValue < end) {
            withFrameNanos { now -> time.doubleValue = (now - start) / NANOS_PER_SECOND }
        }
        played.value = true
    }
    return time
}

/** (a) Recording: a red dot that blinks, and the clock. */
@Composable
private fun RecordingPill(schedule: LapMotion.IntroSchedule, t: Double) {
    val shown = t >= schedule.recording
    val grow = animateFloatAsState(if (shown) 1f else 0f, lapSpring(), label = "pill")
    val dot = ParleyTheme.colors.recording
    Row(
        modifier = Modifier
            .graphicsLayer {
                val scale = PILL_START_SCALE + (1f - PILL_START_SCALE) * grow.value
                scaleX = scale
                scaleY = scale
                alpha = grow.value.coerceIn(0f, 1f)
                transformOrigin = TransformOrigin(0f, 0.5f)
            }
            .border(0.5.dp, MaterialTheme.colorScheme.outlineVariant, CircleShape)
            .padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(
            Modifier
                .size(8.dp)
                .background(dot.copy(alpha = if (schedule.dotLit(t)) 1f else DOT_DIM), CircleShape),
        )
        Text(
            text = stringResource(R.string.intro_recording_now),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurface,
        )
        Text(
            text = PILL_CLOCK,
            style = MaterialTheme.typography.labelMedium.copy(fontFeatureSettings = "tnum"),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/**
 * (b) Transcript: each line types itself in, then its speaker's name fades in
 * above it — "you" in the tint, the other side muted, as the live screen marks
 * who is talking.
 */
@Composable
private fun Transcript(film: IntroFilm, t: Double) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        film.lines.forEachIndexed { index, line ->
            TypedLine(
                line = line,
                typed = film.schedule.typedCount(index, t),
                named = film.schedule.nameShown(index, t),
            )
        }
    }
}

@Composable
private fun TypedLine(line: IntroFilm.Line, typed: Int, named: Boolean) {
    val nameAlpha = animateFloatAsState(if (named) 1f else 0f, fade(), label = "name")
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
            text = line.speaker,
            style = MaterialTheme.typography.labelSmall,
            color = if (line.isMe) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.graphicsLayer { alpha = nameAlpha.value },
        )
        // The full line sits under the typed one, invisible, so the block has
        // its final height from the start and nothing below it jumps as the
        // words arrive.
        Box {
            Text(text = line.text, style = MaterialTheme.typography.bodySmall, modifier = Modifier.alpha(0f))
            Text(
                text = LapMotion.typed(line.text, typed),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}

/**
 * (c) Filing: the customer's folder slides in; the suggestion card — the name
 * Parley gave the call — drops into it, and the row flashes once.
 */
@Composable
private fun FolderBeat(film: IntroFilm, t: Double) {
    val schedule = film.schedule
    val shown = t >= schedule.folder
    val landed = t >= schedule.cardFly
    val enter = animateFloatAsState(if (shown) 1f else 0f, lapSpring(), label = "folder")
    val wash = animateFloatAsState(
        targetValue = if (schedule.folderFlashing(t)) FLASH_ALPHA else 0f,
        animationSpec = tween(FLASH_MS),
        label = "flash",
    )
    val tint = MaterialTheme.colorScheme.primary
    val hairline = MaterialTheme.colorScheme.outlineVariant

    Column(
        modifier = Modifier.graphicsLayer { alpha = enter.value.coerceIn(0f, 1f) },
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        AnimatedVisibility(visible = !landed, exit = fadeOut(fade()) + shrinkVertically(lapSpring())) {
            SuggestionCard(film.cardTitle)
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .graphicsLayer { translationX = -FOLDER_SLIDE.toPx() * (1f - enter.value) }
                .drawBehind {
                    val stroke = 0.5.dp.toPx()
                    val y = size.height - stroke / 2
                    drawLine(hairline, Offset(0f, y), Offset(size.width, y), stroke)
                }
                .background(tint.copy(alpha = wash.value), RoundedCornerShape(ParleyPalette.RADIUS_DP.dp))
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(LibraryIcons.Folder, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(text = film.folderName, style = MaterialTheme.typography.titleSmall, maxLines = 1)
            Spacer(Modifier.width(8.dp))
            AnimatedVisibility(
                visible = landed,
                enter = fadeIn(fade()) + scaleIn(lapSpring(), initialScale = CARD_START_SCALE),
            ) {
                SuggestionCard(film.cardTitle, Modifier.graphicsLayer {
                    scaleX = CARD_LANDED_SCALE
                    scaleY = CARD_LANDED_SCALE
                    transformOrigin = TransformOrigin(1f, 0.5f)
                })
            }
        }
    }
}

@Composable
private fun SuggestionCard(title: String, modifier: Modifier = Modifier) {
    Text(
        text = title,
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurface,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = modifier
            .border(0.5.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(ParleyPalette.RADIUS_DP.dp))
            .padding(horizontal = 8.dp, vertical = 5.dp),
    )
}

/** (d) Hand-off: the share mark fades in, then lights in the tint with a soft ring. */
@Composable
private fun ShareMark(schedule: LapMotion.IntroSchedule, t: Double) {
    val appear = animateFloatAsState(if (schedule.shareShown(t)) 1f else 0f, fade(), label = "share")
    val light = animateFloatAsState(if (t >= schedule.share) 1f else 0f, lapSpring(), label = "lit")
    val tint = MaterialTheme.colorScheme.primary
    val idle = MaterialTheme.colorScheme.outline
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .graphicsLayer { alpha = appear.value },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .size(RING_SIZE)
                .graphicsLayer {
                    val scale = RING_START_SCALE + (1f - RING_START_SCALE) * light.value
                    scaleX = scale
                    scaleY = scale
                    alpha = light.value.coerceIn(0f, 1f)
                }
                .border(6.dp, tint.copy(alpha = RING_ALPHA), CircleShape),
        )
        Icon(
            imageVector = Icons.Filled.Share,
            contentDescription = null,
            tint = lerp(idle, tint, light.value.coerceIn(0f, 1f)),
        )
    }
}

/** One line under the stage naming the beat, cross-fading as the beat changes. */
@Composable
private fun Caption(beat: LapMotion.IntroBeat) {
    Crossfade(targetState = beat, animationSpec = fade(), label = "caption") { shown ->
        Text(
            text = stringResource(captionOf(shown)),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@StringRes
private fun captionOf(beat: LapMotion.IntroBeat): Int = when (beat) {
    LapMotion.IntroBeat.RECORDING -> R.string.intro_caption_recording
    LapMotion.IntroBeat.TRANSCRIPT -> R.string.intro_caption_transcript
    LapMotion.IntroBeat.FOLDER -> R.string.intro_caption_folder
    LapMotion.IntroBeat.SHARE -> R.string.intro_caption_share
}

/**
 * The lap's one spring — iOS `LapMotion.spring` — for anything that moves.
 * Internal so the rest of the lap (the guide bar, the filing card) can move on
 * the same curve.
 */
internal fun <T> lapSpring(): FiniteAnimationSpec<T> = spring(
    dampingRatio = LapMotion.SPRING_DAMPING.toFloat(),
    stiffness = LapMotion.springStiffness.toFloat(),
)

/** iOS `.easeOut(duration: 0.4)`, for anything that only fades. */
private fun <T> fade(): FiniteAnimationSpec<T> = tween(FADE_MS)

/**
 * Whether the system's animations are off — Settings › Accessibility › "Remove
 * animations", which zeroes the animator duration scale.
 */
private fun animationsRemoved(context: Context): Boolean =
    Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f

private const val NANOS_PER_SECOND = 1_000_000_000.0
private const val PILL_CLOCK = "00:12"
private const val PILL_START_SCALE = 0.6f
private const val DOT_DIM = 0.25f
private const val FLASH_ALPHA = 0.10f
private const val FLASH_MS = 500
private const val FADE_MS = 400
private const val CARD_START_SCALE = 0.6f
private const val CARD_LANDED_SCALE = 0.9f
private const val RING_START_SCALE = 0.7f
private const val RING_ALPHA = 0.25f
private val RING_SIZE = 40.dp
private val FOLDER_SLIDE = 24.dp
private val STAGE_MIN_HEIGHT = 300.dp

// ── previews ─────────────────────────────────────────────────────────────────

private val previewFilm = IntroFilm(
    lines = listOf(
        IntroFilm.Line("你", isMe = true, text = "林經理午安，謝謝您今天抽時間。"),
        IntroFilm.Line("林經理", isMe = false, text = "旺季一天大概三百多通，平常兩百左右。"),
        IntroFilm.Line("你", isMe = true, text = "了解，所以夜間的漏接是目前最大的痛點。"),
    ),
    folderName = "泓昇科技",
    cardTitle = "泓昇科技 · 客服語音系統需求訪談",
)

@Preview(name = "Intro — the final frame", showBackground = true, widthDp = 380)
@Composable
private fun IntroStageFinalPreview() {
    ParleyTheme(preference = ThemePreference.LIGHT) {
        Surface { IntroStage(previewFilm, Modifier.padding(24.dp), frozenAt = previewFilm.schedule.end) }
    }
}

@Preview(name = "Intro — mid-transcript", showBackground = true, widthDp = 380)
@Composable
private fun IntroStageTypingPreview() {
    ParleyTheme(preference = ThemePreference.LIGHT) {
        val midLine = previewFilm.schedule.lines[1].start + 0.2
        Surface { IntroStage(previewFilm, Modifier.padding(24.dp), frozenAt = midLine) }
    }
}

@Preview(name = "Intro — dark, final frame", showBackground = true, widthDp = 380)
@Composable
private fun IntroStageDarkPreview() {
    ParleyTheme(preference = ThemePreference.DARK) {
        Surface { IntroStage(previewFilm, Modifier.padding(24.dp), frozenAt = previewFilm.schedule.end) }
    }
}
