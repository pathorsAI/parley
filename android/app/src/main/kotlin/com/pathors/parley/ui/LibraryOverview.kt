package com.pathors.parley.ui

import android.provider.Settings
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pathors.parley.R
import com.pathors.parley.cloud.RecordingSource
import com.pathors.parley.cloud.RecordingSummary
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// The pieces of the Library's overview — the phone's take on the desktop's 總覽
// (`src/components/home/HomeScreen.tsx`) and the Android half of iOS
// `LibraryOverview.swift`: a row of blue light bars behind the top of the page,
// the folders as one sideways row of cards, the four newest recordings, and the
// empty states. `HomeScreen` puts them together, because the state they act on
// (the scope, the folders, the dialogs) is its own; everything here only draws
// and reports taps.

// ── Backdrop ─────────────────────────────────────────────────────────────────

/**
 * One bar of the desktop's `HomeBackdrop`: its column (left/right insets, % of
 * the width), height and vertical offset from the layer's middle (desktop px),
 * core colour and opacity, and where along its height the core sits.
 */
private class BackdropBar(
    val left: Float,
    val right: Float,
    val h: Float,
    val dy: Float,
    val core: Long,
    val coreAlpha: Float = 1f,
    val o: Float,
    val at: Float = 0.5f,
)

private val BACKDROP_BARS = listOf(
    BackdropBar(0f, 92.31f, 689.363f, 3.18f, 0xFF1469D4, o = 0.3f),
    BackdropBar(7.71f, 84.6f, 445.749f, -410.63f, 0xFF1979DA, o = 0.4f),
    BackdropBar(15.42f, 76.89f, 353.586f, 14.1f, 0xFF1D86E0, o = 0.5f, at = 0.49519f),
    BackdropBar(23.16f, 69.15f, 297.546f, -200.59f, 0xFF2191E4, o = 0.6f),
    BackdropBar(30.75f, 61.59f, 258f, -58.36f, 0xFF2191E4, coreAlpha = 0.9f, o = 0.7f),
    BackdropBar(38.47f, 53.82f, 223.018f, -228.03f, 0xFF2AACEF, coreAlpha = 0.8f, o = 0.8f),
    BackdropBar(46.16f, 46.17f, 381f, -203.86f, 0xFF2DB6F3, coreAlpha = 0.7f, o = 1f),
    BackdropBar(53.82f, 38.47f, 261.839f, -288.18f, 0xFF2AACEF, coreAlpha = 0.8f, o = 0.8f),
    BackdropBar(61.57f, 30.72f, 294.053f, -76.34f, 0xFF259DE9, coreAlpha = 0.9f, o = 0.7f),
    BackdropBar(69.24f, 23.07f, 264.968f, -394.47f, 0xFF2191E4, o = 0.6f),
    BackdropBar(76.94f, 15.35f, 328.745f, -228.99f, 0xFF1D86E0, o = 0.5f, at = 0.49519f),
    BackdropBar(84.65f, 7.68f, 511f, -112.86f, 0xFF1979DA, o = 0.4f),
    BackdropBar(92.36f, -0.05f, 571.586f, -322.1f, 0xFF1469D4, o = 0.3f),
)

/** The desktop layer: 595 px tall, its top 172 px above the page. */
private const val BACKDROP_LAYER_TOP = -172f
private const val BACKDROP_LAYER_HEIGHT = 595f

/** Desktop px → dp, vertically (iOS's 0.85). */
private const val BACKDROP_SCALE = 0.85f

/** The desktop's rise: up from 49.56 px below, half a second each, 60 ms apart. */
private const val BACKDROP_RISE = 49.56f
private const val BACKDROP_RISE_MS = 500
private const val BACKDROP_STAGGER_MS = 60L
private val BackdropRiseEasing = CubicBezierEasing(0.16f, 1f, 0.3f, 1f)

/**
 * How far down the page the lowest bar reaches (the first one, ending 473 px
 * down on the desktop). The backdrop is this tall and no taller.
 */
internal val OverviewBackdropHeight: Dp = (473f * BACKDROP_SCALE).dp

/**
 * The desktop's `HomeBackdrop`, bar for bar — iOS `OverviewBackdrop`: thirteen
 * vertical light bars, mirrored left to right so the tall, dark-cored bars sit
 * on the right, each fading to transparent at both ends, rising into place
 * 60 ms apart when the page opens — over a faint blue wash that fades into the
 * page, and faded out itself at the bottom, where the page goes on below it.
 *
 * The desktop's geometry is kept in its own pixels and scaled down vertically,
 * because a phone column is a third of the desktop's width: at full height the
 * bars came out as thin stripes three times taller than they are wide.
 * Horizontally they keep the desktop's percentages, so the rhythm of the row is
 * the same.
 *
 * Fading to transparent rather than to a colour is what lets the same bars sit
 * on the dark page. Drawn in one offscreen layer, so the bottom fade can mask
 * the bars and the wash together. Purely decorative: no semantics, and still
 * when the system's animator scale is off.
 */
@Composable
internal fun OverviewBackdrop(modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    val dark = scheme.background.luminance() < 0.5f
    val context = LocalContext.current
    val still = remember(context) {
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    }
    val rises = remember { BACKDROP_BARS.map { Animatable(if (still) 1f else 0f) } }
    LaunchedEffect(Unit) {
        if (still) return@LaunchedEffect
        rises.forEachIndexed { i, rise ->
            launch {
                delay(i * BACKDROP_STAGGER_MS)
                rise.animateTo(1f, tween(BACKDROP_RISE_MS, easing = BackdropRiseEasing))
            }
        }
    }
    // The desktop's pale blue at 20% on light, its primary at a whisper on dark.
    val washTop = if (dark) scheme.primary.copy(alpha = 0.06f) else Color(0xFFF0F9FF).copy(alpha = 0.2f)
    val layerAlpha = if (dark) 0.15f else 0.2f
    Canvas(
        modifier
            .fillMaxWidth()
            .height(OverviewBackdropHeight)
            .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
            .clearAndSetSemantics {},
    ) {
        drawRect(Brush.verticalGradient(listOf(washTop, washTop.copy(alpha = 0f))))
        val unit = 1.dp.toPx() * BACKDROP_SCALE
        val middle = (BACKDROP_LAYER_TOP + BACKDROP_LAYER_HEIGHT / 2) * unit
        // Mirrored, as on the desktop.
        scale(scaleX = -1f, scaleY = 1f) {
            BACKDROP_BARS.forEachIndexed { i, bar ->
                val risen = rises[i].value
                val x = size.width * bar.left / 100f
                val w = size.width * (100f - bar.left - bar.right) / 100f
                val h = bar.h * unit
                val top = middle + bar.dy * unit - h / 2 + (1f - risen) * BACKDROP_RISE * unit
                val core = Color(bar.core).copy(alpha = bar.coreAlpha)
                drawRect(
                    brush = Brush.verticalGradient(
                        0f to core.copy(alpha = 0f),
                        bar.at to core,
                        1f to core.copy(alpha = 0f),
                        startY = top,
                        endY = top + h,
                    ),
                    topLeft = Offset(x, top),
                    size = Size(w, h),
                    alpha = bar.o * layerAlpha * risen,
                )
            }
        }
        // Faded out at the bottom; the top is the window's edge, where the
        // bars run off as on the desktop.
        drawRect(
            brush = Brush.verticalGradient(0f to Color.Black, 0.7f to Color.Black, 1f to Color.Transparent),
            blendMode = BlendMode.DstIn,
        )
    }
}

// ── Page header ──────────────────────────────────────────────────────────────

/**
 * The top of the Library — iOS `TabPageHeader`: the page's title at
 * large-title size, leading, with the page's actions level with it on the
 * trailing side, and room above it under the status bar. Drawn in the page
 * rather than as a `TopAppBar`: an app bar's title is 22sp and its height is
 * Material's, so it could neither be the large title nor be given the room
 * above that lets the light bars show behind it.
 */
@Composable
internal fun LibraryPageHeader(title: String, actions: @Composable RowScope.() -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 20.dp, end = 16.dp, top = 24.dp, bottom = 10.dp),
    ) {
        Text(
            text = title,
            style = MaterialTheme.typography.headlineLarge,
            color = MaterialTheme.colorScheme.onBackground,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .weight(1f)
                .semantics { heading() },
        )
        Spacer(Modifier.width(8.dp))
        actions()
    }
}

/**
 * The header's actions as one control — iOS `HeaderActions`, its glass capsule
 * drawn as a translucent pill of the page's raised surface, so the light bars
 * still show through it a little. The buttons inside keep Material's 48dp
 * touch targets; the pill is as tall as they are.
 */
@Composable
internal fun HeaderActions(content: @Composable RowScope.() -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .heightIn(min = 48.dp)
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.surfaceContainerHigh.copy(alpha = 0.85f))
            .padding(horizontal = 4.dp),
        content = content,
    )
}

/**
 * A search field in the page — iOS `PageSearchField`: the magnifier, the field,
 * and a clear button once there is something to clear, in a filled capsule.
 *
 * Always there rather than summoned (the transcript's [SearchField] is summoned),
 * because the Library's overview is where somebody arrives looking for a
 * meeting, and the field is the shortest way to one. Not focused on appearance
 * for the same reason: the page is read first, typed into second. `Done`, not
 * `Search`: the list is filtered by the time the key could be pressed.
 */
@Composable
internal fun PageSearchField(
    query: String,
    onQueryChange: (String) -> Unit,
    hint: String,
    modifier: Modifier = Modifier,
) {
    val focusManager = LocalFocusManager.current
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier
            .fillMaxWidth()
            .height(44.dp)
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.surfaceContainerHigh.copy(alpha = 0.85f))
            .padding(start = 14.dp, end = 4.dp),
    ) {
        Icon(
            imageVector = Icons.Default.Search,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(20.dp),
        )
        Spacer(Modifier.width(8.dp))
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
            if (query.isEmpty()) {
                Text(
                    text = hint,
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            BasicTextField(
                value = query,
                onValueChange = onQueryChange,
                singleLine = true,
                textStyle = LocalTextStyle.current.merge(MaterialTheme.typography.bodyLarge)
                    .copy(color = MaterialTheme.colorScheme.onSurface),
                cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { focusManager.clearFocus() }),
                modifier = Modifier
                    .fillMaxWidth()
                    .semantics { contentDescription = hint },
            )
        }
        if (query.isNotEmpty()) {
            IconButton(onClick = { onQueryChange("") }) {
                Icon(
                    imageVector = Icons.Default.Clear,
                    contentDescription = stringResource(R.string.action_clear),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        } else {
            Spacer(Modifier.width(10.dp))
        }
    }
}

// ── Section heading ──────────────────────────────────────────────────────────

/**
 * The desktop's `text-xs font-semibold text-muted-foreground` heading — iOS
 * `OverviewHeading` — with an optional link at the trailing end.
 */
@Composable
internal fun OverviewHeading(title: String, modifier: Modifier = Modifier, trailing: @Composable () -> Unit = {}) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 32.dp),
    ) {
        Text(
            text = title,
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier
                .weight(1f)
                .semantics { heading() },
        )
        trailing()
    }
}

/**
 * A heading's trailing link — 查看全部 →, + 新增資料夾: a small blue label with
 * its glyph, the glyph after the text for a way on (an arrow), before it for an
 * action (a plus) — iOS `OverviewLinkLabelStyle`. The touch target is the 48dp
 * minimum around the small label.
 */
@Composable
internal fun OverviewLink(text: String, leading: Boolean, onClick: () -> Unit) {
    val blue = MaterialTheme.colorScheme.primary
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(3.dp),
        modifier = Modifier
            .heightIn(min = 48.dp)
            .clip(CircleShape)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 6.dp),
    ) {
        if (leading) {
            Icon(Icons.Default.Add, contentDescription = null, tint = blue, modifier = Modifier.size(14.dp))
        }
        Text(text = text, style = MaterialTheme.typography.labelSmall, color = blue)
        if (!leading) {
            Icon(
                Icons.AutoMirrored.Filled.ArrowForward,
                contentDescription = null,
                tint = blue,
                modifier = Modifier.size(14.dp),
            )
        }
    }
}

// ── Folder cards ─────────────────────────────────────────────────────────────

/**
 * The folder drawing's own size in the UX file (3541:9358), and the size it is
 * shown at on a phone. The drawing is laid out in its 151×136 coordinates and
 * scaled as one, so the papers, the tab and the front keep their proportions
 * exactly; the name and count are laid out at the shown size instead, so they
 * stay at the type scale rather than shrinking with it.
 */
private const val FOLDER_DRAWN_W = 151f
private const val FOLDER_DRAWN_H = 136f
private val FolderShownWidth = 140.dp
private val FolderShownHeight = FolderShownWidth * (FOLDER_DRAWN_H / FOLDER_DRAWN_W)
private const val FOLDER_SCALE = 140f / FOLDER_DRAWN_W

/** The front's outline, with its tab — `folder-front.svg`'s one path. */
private val FolderFrontPath: Path by lazy {
    PathParser().parsePathString(
        "M151 99C151 103.418 147.418 107 143 107H8C3.58172 107 0 103.418 0 99V8C0 3.58172 3.58172 0 8 0" +
            "H70.46C73.9891 0 77.1013 2.31248 78.1197 5.69144L81.9223 18.3086C82.9407 21.6875 86.0529 24 89.582 24" +
            "H143C147.418 24 151 27.5817 151 32V99Z",
    ).toPath()
}

/**
 * The folder cards' colours, from the desktop's (light / dark). Not the theme:
 * these are the drawing's own greys and paper whites, which no other screen
 * uses. The front's two stops are the SVG's visible (second) gradient, resting
 * and pressed.
 */
private class FolderPalette(private val dark: Boolean) {
    private fun pick(light: Long, darkValue: Long, alpha: Float = 1f) = Color(if (dark) darkValue else light).copy(alpha = alpha)
    val back = pick(0xFFE1E1E1, 0xFF1C2533)
    val backPressed = pick(0xFFD4E5EF, 0xFF1D3350)
    val paperBack = pick(0xFFFFFFFF, 0xFF2B3646, alpha = 0.8f)
    val paperFront = pick(0xFFFFFFFF, 0xFF334052)
    val frontTop = pick(0xFFE6E6E6, 0xFF2A3442)
    val frontTopPressed = pick(0xFFCFEBFF, 0xFF26507F)
    val frontBottom = pick(0xFFFFFFFF, 0xFF1A222E)
    val frontBottomPressed = pick(0xFFFFFFFF, 0xFF162741)
    val name = pick(0xFF333333, 0xFFE5E7EB)
    val namePressed = pick(0xFF3B82F6, 0xFF60A5FA)
    val count = pick(0xFFA3A3A3, 0xFF8B95A3)
}

/**
 * The desktop `FolderCard` — iOS `FolderCard`: a grey back panel, two sheets of
 * paper tucked in at 7° (left out when the folder is empty — an empty folder is
 * drawn empty), the folder's front with its tab, and the name and recording
 * count on the front. Pressed, it takes the desktop's hover look: the back
 * turns blue, the papers rise, the front takes its blue wash and the name its
 * blue.
 *
 * A long press opens Rename and Delete, the folder chips' long-press menu.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun FolderCard(
    name: String,
    count: Int,
    onOpen: () -> Unit,
    onRename: () -> Unit,
    onDelete: () -> Unit,
) {
    val palette = FolderPalette(MaterialTheme.colorScheme.background.luminance() < 0.5f)
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val press by animateFloatAsState(if (pressed) 1f else 0f, tween(350, easing = CubicBezierEasing(0.2f, 0.8f, 0.2f, 1f)), label = "folder-press")
    val nameColor by animateColorAsState(if (pressed) palette.namePressed else palette.name, tween(350), label = "folder-name")
    var menuOpen by remember { mutableStateOf(false) }
    val countText = pluralStringResource(R.plurals.library_folder_card_count, count, count)
    val actionsLabel = stringResource(R.string.library_folder_actions)
    Box {
        Box(
            modifier = Modifier
                .width(FolderShownWidth)
                .height(FolderShownHeight)
                .semantics(mergeDescendants = true) { contentDescription = "$name, $countText" }
                .combinedClickable(
                    interactionSource = interaction,
                    indication = null,
                    role = Role.Button,
                    onLongClickLabel = actionsLabel,
                    onLongClick = { menuOpen = true },
                    onClick = onOpen,
                ),
        ) {
            Canvas(Modifier.matchParentSize()) {
                // The drawing's own units to pixels: the shown width over the drawn one.
                val toPx = size.width / FOLDER_DRAWN_W
                scale(toPx, toPx, pivot = Offset.Zero) {
                    drawFolder(palette, press, empty = count == 0)
                }
            }
            // The name slot: 93 px down the drawing, 12 px in from each side.
            Column(
                verticalArrangement = Arrangement.spacedBy(1.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 12.dp * FOLDER_SCALE, end = 12.dp * FOLDER_SCALE, top = 93.dp * FOLDER_SCALE),
            ) {
                Text(
                    text = name,
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.Normal,
                    color = nameColor,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = countText,
                    style = MaterialTheme.typography.labelSmall.copy(fontSize = 11.sp, lineHeight = 14.sp),
                    fontWeight = FontWeight.Normal,
                    color = palette.count,
                    maxLines = 1,
                )
            }
        }
        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.library_folder_rename)) },
                leadingIcon = { Icon(Icons.Default.Edit, contentDescription = null) },
                onClick = {
                    menuOpen = false
                    onRename()
                },
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.library_folder_delete), color = MaterialTheme.colorScheme.error) },
                leadingIcon = { Icon(Icons.Default.Delete, contentDescription = null, tint = MaterialTheme.colorScheme.error) },
                onClick = {
                    menuOpen = false
                    onDelete()
                },
            )
        }
    }
}

/** The folder in its own 151×136 coordinates; [press] runs 0 (resting) to 1 (pressed). */
private fun DrawScope.drawFolder(palette: FolderPalette, press: Float, empty: Boolean) {
    // Back panel.
    drawRoundRect(
        color = androidx.compose.ui.graphics.lerp(palette.back, palette.backPressed, press),
        size = Size(151f, 106f),
        cornerRadius = CornerRadius(8f),
    )
    if (!empty) {
        drawPaper(Offset(9.89f, 10.9f), Size(111.626f, 116.122f), Size(99.601f, 104.765f), palette.paperBack, press)
        drawPaper(Offset(29.14f, 31.16f), Size(106f, 95.204f), Size(96.473f, 84.074f), palette.paperFront, press)
    }
    // The front, its grey wash turning blue under the finger.
    translate(top = 29f) {
        drawPath(
            path = FolderFrontPath,
            brush = Brush.verticalGradient(
                listOf(
                    androidx.compose.ui.graphics.lerp(palette.frontTop, palette.frontTopPressed, press),
                    androidx.compose.ui.graphics.lerp(palette.frontBottom, palette.frontBottomPressed, press),
                ),
                startY = 0f,
                endY = 107f,
            ),
        )
    }
}

/** A sheet of paper turned 7°, centred in its box, with the desktop's soft shadow; pressed, it rises. */
private fun DrawScope.drawPaper(origin: Offset, box: Size, sheet: Size, fill: Color, press: Float) {
    val left = origin.x + 3.11f * press + (box.width - sheet.width) / 2
    val top = origin.y - 10.9f * press + (box.height - sheet.height) / 2
    val pivot = Offset(left + sheet.width / 2, top + sheet.height / 2)
    rotate(7f, pivot) {
        // `shadow-[0px_4px_7px_0px_rgba(0,0,0,0.1)]`, as three soft steps.
        for (step in 1..3) {
            val spread = step * 1.5f
            drawRoundRect(
                color = Color.Black.copy(alpha = 0.03f),
                topLeft = Offset(left - spread / 2, top + 4f - spread / 2),
                size = Size(sheet.width + spread, sheet.height + spread),
                cornerRadius = CornerRadius(4f + spread),
            )
        }
        drawRoundRect(color = fill, topLeft = Offset(left, top), size = sheet, cornerRadius = CornerRadius(4f))
    }
}

// ── Rows ─────────────────────────────────────────────────────────────────────

/**
 * Where a recording came from, as a glyph rather than a word, as the desktop's
 * list marks it — iOS `RecordingSourceIcon`: the waveform for a meeting
 * recorded live, a document with an arrow going up for a file that was
 * uploaded. Secondary grey: a fact about the row, not something to tap.
 * TalkBack reads 現場 / 上傳.
 */
@Composable
internal fun RecordingSourceIcon(source: String, modifier: Modifier = Modifier) {
    val live = source != RecordingSource.UPLOAD
    Icon(
        imageVector = if (live) LibraryIcons.Waveform else LibraryIcons.UploadDoc,
        contentDescription = stringResource(if (live) R.string.recording_source_live else R.string.recording_source_upload),
        tint = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier.size(16.dp),
    )
}

/**
 * A recording's meta, as the desktop's list gives it — iOS
 * `RecordingMetaLine`: when the meeting was ([formatRowTimestamp]: the
 * locale's own format, the year only outside this one) and how many people
 * spoke. Nothing from the transcript — a row says which meeting this is, the
 * recording says what was in it — and no duration, folder or findings count,
 * which the folder pages, the recording and its summary already carry.
 *
 * Shared by the overview's recent rows and the full list, so the two lists read
 * the same. A count of zero is left out rather than shown as "0".
 */
@Composable
internal fun RecordingMetaLine(recording: RecordingSummary, modifier: Modifier = Modifier) {
    val style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Normal, fontFeatureSettings = "tnum")
    val color = MaterialTheme.colorScheme.onSurfaceVariant
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        modifier = modifier,
    ) {
        Text(
            text = formatRowTimestamp(recording.createdAt),
            style = style,
            color = color,
            maxLines = 1,
            softWrap = false,
        )
        recording.speakerCount?.takeIf { it > 0 }?.let { speakers ->
            val label = stringResource(R.string.recording_meta_speakers)
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                modifier = Modifier.clearAndSetSemantics { contentDescription = "$label $speakers" },
            ) {
                Icon(LibraryIcons.Group, contentDescription = null, tint = color, modifier = Modifier.size(14.dp))
                Text(text = speakers.toString(), style = style, color = color, maxLines = 1, softWrap = false)
            }
        }
    }
}

/**
 * Nothing to list — the desktop's `EmptyRecords`, iOS `EmptyRecordsView`: its
 * empty-box illustration, a title, and a hint that says how this place fills
 * up. [action], when given, sits under the hint: the library's own door into
 * import, for instance.
 */
@Composable
internal fun EmptyRecords(
    title: String,
    hint: String,
    modifier: Modifier = Modifier,
    action: (@Composable () -> Unit)? = null,
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = modifier
            .fillMaxWidth()
            .padding(top = 56.dp, bottom = 24.dp),
    ) {
        EmptyRecordsIllustration(Modifier.size(width = 120.dp, height = 105.84.dp))
        Spacer(Modifier.height(20.dp))
        Text(
            text = title,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(4.dp))
        Text(
            text = hint,
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Normal,
            color = MaterialTheme.colorScheme.outline,
            textAlign = TextAlign.Center,
            modifier = Modifier.widthIn(max = 280.dp),
        )
        if (action != null) {
            Spacer(Modifier.height(10.dp))
            action()
        }
    }
}

/** The SVG's viewBox. */
private const val EMPTY_BOX_W = 80.2525f
private const val EMPTY_BOX_H = 70.5882f

/**
 * The empty box's path data, straight from `public/library/empty-records.svg`
 * (and its `-dark` twin, which differs only in colour).
 */
private object EmptyBoxPaths {
    private fun path(d: String): Path = PathParser().parsePathString(d).toPath()

    val leftFace by lazy { path("M0.16631 58.2022V28.5393L47.1326 39.3258V70.5618L0.16631 58.2022Z") }
    val rightFace by lazy { path("M80.1663 20.7059L46.284 39.6657V70.5882L80.1663 50.9513V20.7059Z") }
    val rim by lazy { path("M0.16631 28.7059L36.5708 11.0535L80.1663 21.1765") }
    val handle by lazy {
        path(
            "M24.9508 40.8807L20.3911 39.7753L16.6346 38.8362C15.2038 38.4785 13.7388 39.2827 13.2724 40.6818" +
                "C12.7498 42.2497 13.68 43.9291 15.2864 44.3177L23.6296 46.3363C25.087 46.6888 26.5641 45.8336 26.984 44.3942" +
                "C27.4322 42.8575 26.5065 41.2578 24.9508 40.8807Z",
        )
    }
    val sheet by lazy {
        path(
            "M14.1663 31.7808V7.71653C14.1663 5.1739 16.5075 3.27655 18.995 3.80331L53.495 11.1092" +
                "C55.3438 11.5007 56.6663 13.1326 56.6663 15.0224V33.7808L46.6663 39.2808L14.1663 31.7808Z",
        )
    }

    /**
     * The sheet's dashed outline. The SVG draws its dashes as separate
     * segments; a dash effect along the same outline draws the same line
     * without the hundred-odd subpaths.
     */
    val sheetOutline by lazy {
        path(
            "M14.1663 31.7808V7.71653C14.1663 5.1739 16.5075 3.27655 18.995 3.80331L53.495 11.1092" +
                "C55.3438 11.5007 56.6663 13.1326 56.6663 15.0224V33.7808",
        )
    }
}

/**
 * The desktop's empty-box illustration — iOS `EmptyRecordsIllustration` —
 * drawn here as vectors from the very same path data rather than as a
 * `VectorDrawable`, which Compose rasterises once at its intrinsic size and
 * scales as a bitmap: the box came out soft. Drawn live, every line is as sharp
 * as the screen. The SVG's two masks (a stroke kept inside its own face) are a
 * clip to the face here.
 */
@Composable
internal fun EmptyRecordsIllustration(modifier: Modifier = Modifier) {
    val dark = MaterialTheme.colorScheme.background.luminance() < 0.5f
    val leftFace = Color(if (dark) 0xFF1E2836 else 0xFFFAFAFA)
    val rightFace = Color(if (dark) 0xFF253141 else 0xFFF5F5F5)
    val ink = Color(if (dark) 0xFF7B8899 else 0xFF535353)
    val sheet = Color(if (dark) 0xFF1F3D63 else 0xFFE5F6FF)
    val dashes = Color(if (dark) 0xFF4A86C5 else 0xFFC7ECFD)
    Canvas(modifier.clearAndSetSemantics {}) {
        scale(size.width / EMPTY_BOX_W, size.height / EMPTY_BOX_H, pivot = Offset.Zero) {
            listOf(
                Triple(EmptyBoxPaths.leftFace, leftFace, StrokeJoin.Miter),
                Triple(EmptyBoxPaths.rightFace, rightFace, StrokeJoin.Round),
            ).forEach { (face, fill, join) ->
                drawPath(face, fill)
                // The SVG's `mask` on a 1.52 stroke: half of it, inside the face.
                clipPath(face) { drawPath(face, ink, style = Stroke(width = 1.52471f, join = join)) }
            }
            drawPath(EmptyBoxPaths.rim, ink, style = Stroke(width = 0.762353f))
            drawPath(EmptyBoxPaths.handle, ink)
            drawPath(EmptyBoxPaths.handle, ink, style = Stroke(width = 0.762353f))
            drawPath(EmptyBoxPaths.sheet, sheet.copy(alpha = 0.7f))
            drawPath(
                EmptyBoxPaths.sheetOutline,
                dashes,
                style = Stroke(width = 1f, pathEffect = PathEffect.dashPathEffect(floatArrayOf(1f, 1f))),
            )
        }
    }
}

/**
 * 最近錄音 with nothing in it — iOS `RecentEmptyBox`: a dashed box with the
 * sentence, and the sample offered under it when the checklist is not already
 * offering it.
 */
@Composable
internal fun RecentEmptyBox(offersSample: Boolean, transcribing: Boolean, onUseSample: () -> Unit) {
    val rule = MaterialTheme.colorScheme.outlineVariant
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
        modifier = Modifier
            .fillMaxWidth()
            .drawBehind {
                val stroke = 1.dp.toPx()
                drawRoundRect(
                    color = rule,
                    topLeft = Offset(stroke / 2, stroke / 2),
                    size = Size(size.width - stroke, size.height - stroke),
                    cornerRadius = CornerRadius(8.dp.toPx()),
                    style = Stroke(
                        width = stroke,
                        pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx())),
                    ),
                )
            }
            .padding(horizontal = 12.dp, vertical = 20.dp),
    ) {
        Text(
            text = stringResource(R.string.library_recent_empty),
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Normal,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        if (offersSample) {
            if (transcribing) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                    Text(
                        text = stringResource(R.string.getting_started_transcribing),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                TextButton(onClick = onUseSample) { Text(stringResource(R.string.library_use_sample)) }
            }
        }
    }
}
