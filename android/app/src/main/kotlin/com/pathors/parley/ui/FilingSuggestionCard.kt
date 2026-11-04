package com.pathors.parley.ui

import android.content.Context
import android.os.Build
import android.provider.Settings
import android.view.HapticFeedbackConstants
import android.view.View
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.geometry.lerp
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.pathors.parley.R
import com.pathors.parley.cloud.CloudFolder
import com.pathors.parley.filing.FilingCardController
import com.pathors.parley.filing.FilingPhase
import com.pathors.parley.filing.FilingUiState
import com.pathors.parley.filing.FolderTarget
import com.pathors.parley.kit.FilingFolderSuggestion
import com.pathors.parley.kit.FilingMotion
import com.pathors.parley.library.FolderDirectory
import com.pathors.parley.library.FolderScope
import com.pathors.parley.library.SaveDestination
import com.pathors.parley.ui.theme.ParleyTextStyles
import kotlin.math.roundToInt
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The filing suggestion: the name this recording could have, and the folder it
 * could live in — the Android half of iOS `FilingSuggestionCard` (#450). Shown
 * on the meeting screen for the recording that just landed, and on the
 * recording page above Summary | Transcript whenever the recording has a
 * suggestion pending.
 *
 * It is a SUGGESTION, not a form, and it is drawn like one: a small secondary
 * heading, the proposed name in ink, the candidate folders as outlined chips,
 * and the actions as blue text. No card, no fill — the chips are the only
 * shapes, because they are the only things here that are choices.
 *
 * It is also a form with ONE commit, Save. Everything else only changes what
 * Save will do: a tester filed a meeting into the wrong customer back when a
 * chip tap was the whole answer, and pressed Return expecting to rename only.
 *
 * - **The name** is the proposal, and tapping it edits it in place. Done on
 *   the keyboard closes the field and keeps what was typed; Save writes it.
 * - **The chips** are the folders, best first, at most three; the first one
 *   starts selected. A folder that does not exist yet is dashed and captioned
 *   "New folder", because Save creates it; the rest say "Existing folder". The
 *   model's reason is read by TalkBack after the chip's name. Tapping a chip
 *   selects it (filled, with a tick); tapping the selected one selects none.
 * - **Choose another…** opens the folder picker — the personal folders with
 *   the chips' existing ones on top, then each organization's — and its
 *   confirm selects that place, drawn as one more chip.
 * - **Save** writes the name as the field shows it and the selected folder in
 *   one push, and the offer is over. **Skip suggestion** answers it with no.
 *
 * ## Motion
 *
 * The card arrives on a spring (16 dp low, 98 %, transparent → in place). The
 * proposed name types itself in once per session, 22 ms a character. On
 * Save, a ghost of the card flies from the name into the selected chip, the
 * chip pops, a success haptic plays, and only then is the answer written. With
 * the system's "Remove animations" on, all of it is skipped and the write
 * happens at once. Numbers: [FilingMotion].
 *
 * ## Hooks
 *
 * [FilingCardCueState.washed] tints the card (the guide's "look here") and
 * [FilingCardCueState.choosing] holds the picker open; both belong to the
 * screen's [FilingCardController.cues], which is what a guide drives.
 */
@Composable
fun FilingSuggestionCard(
    card: FilingCardController,
    modifier: Modifier = Modifier,
    gutter: Dp = 0.dp,
) {
    val state by card.state.collectAsState()
    val washed by card.cues.washed.collectAsState()
    val choosing by card.cues.choosing.collectAsState()
    val directory by card.directory.collectAsState()
    val actions = remember(card) { FilingCardActions.of(card) }
    FilingSuggestionCard(
        state = state,
        actions = actions,
        cues = FilingCardCueState(washed = washed, choosing = choosing),
        directory = directory,
        modifier = modifier,
        gutter = gutter,
    )
}

/** What the card can ask for. See [FilingCardController] for what each one writes. */
@Immutable
class FilingCardActions(
    /** Save: the field's title (null = the proposed one) and the selected folder. */
    val onSave: (String?) -> Unit,
    /** A chip: select it, or none when it is the selected one. */
    val onToggle: (FilingFolderSuggestion) -> Unit,
    /** The picker's confirm: select that place, under that chip label. */
    val onChoose: (FolderTarget, String) -> Unit,
    /** "New folder" in "Choose another…"; a throw keeps the picker up with its error. */
    val onCreate: suspend (String) -> CloudFolder,
    val onSkip: () -> Unit,
    /** Open or close "Choose another…". */
    val onChoosingChange: (Boolean) -> Unit,
) {
    companion object {
        fun of(card: FilingCardController) = FilingCardActions(
            onSave = card::save,
            onToggle = card::toggle,
            onChoose = card::choose,
            onCreate = { name -> card.createFolder(name) },
            onSkip = card::skip,
            onChoosingChange = { open -> if (open) card.openPicker() else card.closePicker() },
        )
    }
}

/** What the screen, or a guide, has asked of the card from outside. */
@Immutable
data class FilingCardCueState(
    /** Washed in the tint: a guide's "look here". */
    val washed: Boolean = false,
    /** The folder picker is up. */
    val choosing: Boolean = false,
)

/**
 * @param gutter the page's horizontal margin. The card's text is inset by it;
 *   the chips scroll under it rather than being cut at it, so the row reads as
 *   continuing.
 */
@Composable
fun FilingSuggestionCard(
    state: FilingUiState,
    actions: FilingCardActions,
    cues: FilingCardCueState,
    modifier: Modifier = Modifier,
    gutter: Dp = 0.dp,
    /** The organizations "Choose another…" lists after the personal folders. */
    directory: FolderDirectory = FolderDirectory(),
) {
    if (state.phase == FilingPhase.THINKING) {
        FilingThinking(modifier.padding(horizontal = gutter))
        return
    }
    val offering = state.phase == FilingPhase.OFFERING && state.hasSomethingToOffer
    val reduceMotion = rememberAnimationsRemoved()
    val arrivalOffset = with(LocalDensity.current) { FilingMotion.ARRIVAL_OFFSET_DP.dp.roundToPx() }
    // Starts hidden, so the first appearance is an arrival rather than a pop-in.
    val arrival = remember { MutableTransitionState(false) }
    LaunchedEffect(offering) { arrival.targetState = offering }
    AnimatedVisibility(
        visibleState = arrival,
        modifier = modifier,
        enter = arrivalTransition(reduceMotion, arrivalOffset),
        exit = fadeOut(),
    ) {
        FilingBlock(
            state = state,
            actions = actions,
            washed = cues.washed,
            gutter = gutter,
            reduceMotion = reduceMotion,
        )
    }
    if (cues.choosing && offering) FilingPicker(state, directory, actions)
}

/** From 16 dp low, 98 % and transparent to where it sits, on the lap's spring. */
private fun arrivalTransition(reduceMotion: Boolean, offsetPx: Int): EnterTransition {
    if (reduceMotion) return EnterTransition.None
    return fadeIn(spring(stiffness = FilingMotion.SPRING_STIFFNESS)) +
        slideInVertically(
            spring(dampingRatio = FilingMotion.SPRING_DAMPING, stiffness = FilingMotion.SPRING_STIFFNESS),
        ) { offsetPx } +
        scaleIn(
            spring(dampingRatio = FilingMotion.SPRING_DAMPING, stiffness = FilingMotion.SPRING_STIFFNESS),
            initialScale = FilingMotion.ARRIVAL_SCALE,
        )
}

/**
 * The pass is reading the meeting. Said out loud, because it is the reason the
 * meeting screen has not gone back to the library the way it used to.
 */
@Composable
private fun FilingThinking(modifier: Modifier) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
        Spacer(Modifier.width(10.dp))
        Text(
            text = stringResource(R.string.filing_thinking),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun FilingBlock(
    state: FilingUiState,
    actions: FilingCardActions,
    washed: Boolean,
    gutter: Dp,
    reduceMotion: Boolean,
) {
    val flight = rememberFlight(reduceMotion)
    val editor = rememberTitleEditor(state.editableTitle)
    val typedCount = rememberTypedCount(state.editableTitle, reduceMotion)
    val wash by animateColorAsState(
        targetValue = if (washed) {
            MaterialTheme.colorScheme.primary.copy(alpha = FilingMotion.WASH_ALPHA)
        } else {
            Color.Transparent
        },
        animationSpec = tween(WASH_FADE_MS),
        label = "filing-wash",
    )
    val busy = state.isWriting || flight.inFlight
    val full = editor.draft.ifEmpty { state.editableTitle }
    val inset = Modifier.padding(horizontal = gutter)

    Box(
        Modifier
            .fillMaxWidth()
            .background(wash)
            .onGloballyPositioned { flight.root = it },
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            FilingHeader(enabled = !busy, onSkip = actions.onSkip, modifier = inset)
            FilingTitle(
                title = TitleView(
                    shown = typedCount?.let { FilingMotion.typed(full, it) } ?: full,
                    full = full,
                    was = state.proposedTitle?.let { state.currentTitle },
                    renamed = state.showsRenamed,
                    busy = busy,
                ),
                editor = editor,
                onSave = { save(state, editor, flight, actions) },
                modifier = inset.onGloballyPositioned { flight.title = it },
            )
            if (state.proposedFolders.isNotEmpty() || state.chosenElsewhere != null) {
                FolderChips(
                    state = state,
                    flight = flight,
                    enabled = !busy,
                    gutter = gutter,
                    onToggle = actions.onToggle,
                    onChooseAnother = { actions.onChoosingChange(true) },
                )
            }
            if (state.writeFailed) {
                Text(
                    text = stringResource(R.string.filing_write_failed),
                    style = ParleyTextStyles.caption2,
                    color = MaterialTheme.colorScheme.error,
                    modifier = inset,
                )
            }
        }
        FlightGhost(flight, full)
    }
}

/** Save: the name as the field shows it, and the selected chip — flown into. */
private fun save(state: FilingUiState, editor: TitleEditor, flight: Flight, actions: FilingCardActions) {
    editor.editing = false
    val typed = editor.draft.trim().ifEmpty { null }
    val key = state.selectedFolder?.let(::filingChipKey)
    if (key == null) {
        actions.onSave(typed)
    } else {
        flight.fly(key) { actions.onSave(typed) }
    }
}

/**
 * Identity for a chip: a folder that does not exist yet is keyed by its name,
 * and a place picked in the picker by where it is.
 */
internal fun filingChipKey(target: FolderTarget): String = when (target) {
    is FolderTarget.Existing -> target.id
    is FolderTarget.New -> "new:${target.name}"
    FolderTarget.Root -> "root"
    is FolderTarget.Org -> "org:${target.orgId}:${target.folderId.orEmpty()}"
}

@Composable
private fun FilingHeader(enabled: Boolean, onSkip: () -> Unit, modifier: Modifier) {
    Row(modifier = modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(
            text = stringResource(R.string.filing_heading),
            style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier
                .weight(1f)
                .semantics { heading() },
        )
        TextButton(onClick = onSkip, enabled = enabled) {
            Text(
                text = stringResource(R.string.filing_skip),
                style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.Normal),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

// ── the name ─────────────────────────────────────────────────────────────────

/** The title as the card draws it. */
@Immutable
private class TitleView(
    /** What is on screen: typed in part while it types itself in. */
    val shown: String,
    /** The whole title, for TalkBack and the flight's ghost. */
    val full: String,
    /** What the recording is called now, while the proposed name is on offer. */
    val was: String?,
    val renamed: Boolean,
    val busy: Boolean,
)

/** The field's text and whether it is open. The draft follows the offer while the field is closed. */
@Stable
private class TitleEditor(initial: String) {
    var draft by mutableStateOf(initial)
    var editing by mutableStateOf(false)

    /** Done: close the field and keep what was typed, for Save. An emptied field goes back to [fallback]. */
    fun close(fallback: String) {
        editing = false
        if (draft.isBlank()) draft = fallback
    }
}

@Composable
private fun rememberTitleEditor(editableTitle: String): TitleEditor {
    val editor = remember { TitleEditor(editableTitle) }
    LaunchedEffect(editableTitle) { if (!editor.editing) editor.draft = editableTitle }
    return editor
}

/**
 * How much of the title has typed itself in, or null for all of it. Once per
 * session per title ([FilingMotion.typedTitles]): the moment is Parley
 * *writing* a name, and a name that retyped itself on every visit would read
 * as a loading effect. Only the title the card arrived with types; a rename
 * is the user's own words, shown whole.
 */
@Composable
private fun rememberTypedCount(title: String, reduceMotion: Boolean): Int? {
    val arrivedWith = remember { title }
    var typed by remember {
        mutableStateOf(if (reduceMotion || FilingMotion.typedTitles.contains(arrivedWith)) null else 0)
    }
    LaunchedEffect(arrivedWith) {
        if (reduceMotion || !FilingMotion.typedTitles.claim(arrivedWith)) {
            typed = null
            return@LaunchedEffect
        }
        try {
            for (count in 0 until FilingMotion.characterCount(arrivedWith)) {
                typed = count
                delay(FilingMotion.PER_CHARACTER_MS)
            }
        } finally {
            typed = null
        }
    }
    return typed
}

/**
 * The proposed name, editable in place, with Save beside it. Under it, while
 * the proposal is on offer, what the recording is called now — "Meeting Sep
 * 7, 3:20 PM" is most of the argument for the suggestion; once the name has
 * been answered, "Renamed ✓" instead.
 */
@Composable
private fun FilingTitle(
    title: TitleView,
    editor: TitleEditor,
    onSave: () -> Unit,
    modifier: Modifier,
) {
    Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) {
                if (editor.editing) {
                    TitleField(editor, onDone = { editor.close(title.full) })
                } else {
                    TitleText(title, enabled = !title.busy, onEdit = { editor.editing = true })
                }
            }
            Spacer(Modifier.width(8.dp))
            if (title.busy) {
                CircularProgressIndicator(
                    modifier = Modifier
                        .padding(horizontal = 16.dp)
                        .size(16.dp),
                    strokeWidth = 2.dp,
                )
            } else {
                TextButton(onClick = onSave) {
                    Text(stringResource(R.string.filing_save), style = ParleyTextStyles.bodyEmphasized)
                }
            }
        }
        TitleCaption(title)
    }
}

@Composable
private fun TitleText(title: TitleView, enabled: Boolean, onEdit: () -> Unit) {
    val editLabel = stringResource(R.string.filing_edit_title)
    Row(
        modifier = Modifier
            .heightIn(min = 48.dp)
            .clickable(enabled = enabled, onClickLabel = editLabel, role = Role.Button, onClick = onEdit)
            // The whole name, not the half typed so far: TalkBack reads it once.
            .clearAndSetSemantics {
                contentDescription = title.full
                role = Role.Button
                onClick(label = editLabel) {
                    onEdit()
                    true
                }
                if (!enabled) disabled()
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            // The proposed name is the model's words, never a lookup key.
            text = title.shown,
            style = MaterialTheme.typography.titleLarge,
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        Spacer(Modifier.width(6.dp))
        Icon(
            imageVector = Icons.Default.Edit,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.outline,
            modifier = Modifier.size(16.dp),
        )
    }
}

/** The name in a field. Done closes it — Save is the rename; a title is one line. */
@Composable
private fun TitleField(editor: TitleEditor, onDone: () -> Unit) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    BasicTextField(
        value = editor.draft,
        onValueChange = { editor.draft = it },
        singleLine = true,
        textStyle = MaterialTheme.typography.titleLarge.copy(color = MaterialTheme.colorScheme.onSurface),
        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { onDone() }),
        modifier = Modifier
            .fillMaxWidth()
            .focusRequester(focus),
        decorationBox = { inner ->
            Column(Modifier.padding(vertical = 10.dp)) {
                Box {
                    if (editor.draft.isEmpty()) {
                        Text(
                            text = stringResource(R.string.filing_title),
                            style = MaterialTheme.typography.titleLarge,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    inner()
                }
                HorizontalDivider(thickness = 0.5.dp, color = MaterialTheme.colorScheme.outlineVariant)
            }
        },
    )
}

@Composable
private fun TitleCaption(title: TitleView) {
    val style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.Normal)
    val color = MaterialTheme.colorScheme.onSurfaceVariant
    when {
        title.was != null -> Text(
            text = stringResource(R.string.filing_was, title.was),
            style = style,
            color = color,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )

        title.renamed -> Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.Check, contentDescription = null, tint = color, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(4.dp))
            Text(text = stringResource(R.string.filing_renamed), style = style, color = color)
        }
    }
}

// ── the folders ──────────────────────────────────────────────────────────────

@Composable
private fun FolderChips(
    state: FilingUiState,
    flight: Flight,
    enabled: Boolean,
    gutter: Dp,
    onToggle: (FilingFolderSuggestion) -> Unit,
    onChooseAnother: () -> Unit,
) {
    val selected = state.selectedFolder
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = gutter),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        state.proposedFolders.forEach { folder ->
            val target = FolderTarget.of(folder)
            val key = filingChipKey(target)
            FolderChip(
                folder = folder,
                selected = target == selected,
                popping = flight.popping == key,
                enabled = enabled,
                onClick = { onToggle(folder) },
                modifier = Modifier.onGloballyPositioned { flight.chips[key] = it },
            )
        }
        state.chosenElsewhere?.let { chosen ->
            val key = filingChipKey(chosen.target)
            ChosenChip(
                label = chosen.label,
                isOrg = chosen.target is FolderTarget.Org,
                popping = flight.popping == key,
                enabled = enabled,
                // Picked elsewhere, changed elsewhere: tapping it reopens the picker.
                onClick = onChooseAnother,
                modifier = Modifier.onGloballyPositioned { flight.chips[key] = it },
            )
        }
        val chooseLabel = stringResource(R.string.filing_choose_another)
        ChipFrame(dashed = false, selected = false, enabled = enabled, onClick = onChooseAnother, label = chooseLabel) {
            ChipName(LibraryIcons.Folder, chooseLabel, MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/**
 * An outlined chip: the name in the tint (it is a thing to tap), a caption
 * saying what Save does to the folder list, and a dashed outline for the
 * folder that does not exist yet. Selected, it fills with the tint and leads
 * with a tick — the folder Save will file into.
 */
@Composable
private fun FolderChip(
    folder: FilingFolderSuggestion,
    selected: Boolean,
    popping: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier,
) {
    val isNew = folder.folderId == null
    val caption = stringResource(if (isNew) R.string.filing_new_folder else R.string.filing_existing_folder)
    val selectedLabel = stringResource(R.string.filing_selected)
    ChipFrame(
        dashed = isNew,
        selected = selected,
        enabled = enabled,
        onClick = onClick,
        // The reason after the name and what the chip does — where iOS reads
        // it as the hint.
        label = listOfNotNull(folder.name, caption, folder.reason, selectedLabel.takeIf { selected })
            .filter { it.isNotBlank() }
            .joinToString(", "),
        modifier = modifier.popScale(popping),
    ) {
        ChipName(
            icon = when {
                selected -> Icons.Default.Check
                isNew -> LibraryIcons.NewFolder
                else -> LibraryIcons.Folder
            },
            name = folder.name,
            tint = MaterialTheme.colorScheme.primary,
        )
        Text(text = caption, style = ParleyTextStyles.caption2, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** The place picked in "Choose another…", always selected — it is only drawn while it is the choice. */
@Composable
private fun ChosenChip(
    label: String,
    isOrg: Boolean,
    popping: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier,
) {
    val caption = stringResource(if (isOrg) R.string.folder_picker_org_badge else R.string.filing_existing_folder)
    ChipFrame(
        dashed = false,
        selected = true,
        enabled = enabled,
        onClick = onClick,
        label = listOf(label, caption, stringResource(R.string.filing_selected)).joinToString(", "),
        modifier = modifier.popScale(popping),
    ) {
        ChipName(icon = Icons.Default.Check, name = label, tint = MaterialTheme.colorScheme.primary)
        Text(text = caption, style = ParleyTextStyles.caption2, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** The chip's pop as the flight lands in it. */
@Composable
private fun Modifier.popScale(popping: Boolean): Modifier {
    val scale by animateFloatAsState(
        targetValue = if (popping) FilingMotion.POP_SCALE else 1f,
        animationSpec = spring(dampingRatio = POP_DAMPING, stiffness = POP_STIFFNESS),
        label = "filing-chip-pop",
    )
    return graphicsLayer {
        scaleX = scale
        scaleY = scale
    }
}

@Composable
private fun ChipName(icon: ImageVector, name: String, tint: Color) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(imageVector = icon, contentDescription = null, tint = tint, modifier = Modifier.size(14.dp))
        Spacer(Modifier.width(5.dp))
        Text(
            text = name,
            style = MaterialTheme.typography.titleSmall,
            color = tint,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun ChipFrame(
    dashed: Boolean,
    selected: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    val outline = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant
    val fill = if (selected) MaterialTheme.colorScheme.primary.copy(alpha = FilingMotion.WASH_ALPHA) else Color.Transparent
    val shape = MaterialTheme.shapes.medium
    Column(
        modifier = modifier
            .heightIn(min = 48.dp)
            .clip(shape)
            .background(fill)
            .chipOutline(outline, dashed)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .clearAndSetSemantics {
                contentDescription = label
                role = Role.Button
                this.selected = selected
                onClick {
                    onClick()
                    true
                }
                if (!enabled) disabled()
            }
            .padding(horizontal = 12.dp, vertical = 7.dp),
        verticalArrangement = Arrangement.spacedBy(1.dp, Alignment.CenterVertically),
        content = content,
    )
}

/** A 1 dp hairline round the chip, dashed for a folder that does not exist yet. */
private fun Modifier.chipOutline(color: Color, dashed: Boolean): Modifier = drawBehind {
    val stroke = 1.dp.toPx()
    val dash = if (dashed) PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx())) else null
    drawRoundRect(
        color = color,
        topLeft = Offset(stroke / 2, stroke / 2),
        size = Size(size.width - stroke, size.height - stroke),
        cornerRadius = CornerRadius(CHIP_RADIUS.toPx()),
        style = Stroke(width = stroke, pathEffect = dash),
    )
}

// ── choose another ───────────────────────────────────────────────────────────

/**
 * "Choose another…": the personal folders with the chips' real ones offered
 * first, then each organization's. Its confirm selects the place for Save;
 * picking an organization shares a copy there and keeps the recording in the
 * personal library, which is what the default save location means by one.
 */
@Composable
private fun FilingPicker(state: FilingUiState, directory: FolderDirectory, actions: FilingCardActions) {
    val suggestedIds = state.proposedFolders.mapNotNull { it.folderId }
    val suggested = suggestedIds.mapNotNull { id -> state.existingFolders.firstOrNull { it.id == id } }
    val personal = FolderScope(null, state.existingFolders)
    val scopes = listOf(personal) + directory.scopesFor(null).drop(1)
    val labels = FilingPickLabels(state.existingFolders, directory)
    FolderPickerSheet(
        scopes = scopes,
        current = SaveDestination(folderId = state.currentFolderId),
        selected = state.selectedFolder?.let(::destinationOf),
        suggested = suggested,
        // Unfiled is not an answer to "where should this live".
        showsRoot = false,
        title = stringResource(R.string.folder_picker_save_title),
        confirmLabel = stringResource(R.string.folder_picker_choose),
        orgHandoff = OrgHandoff.COPY,
        onConfirm = { destination ->
            val target = targetOf(destination)
            actions.onChoose(target, labels.of(destination))
        },
        onCreate = actions.onCreate,
        onDismiss = { actions.onChoosingChange(false) },
    )
}

/** What a picked place's chip is called: the folder, or "Organization · Folder". */
private class FilingPickLabels(private val personal: List<CloudFolder>, private val directory: FolderDirectory) {
    fun of(destination: SaveDestination): String {
        val orgId = destination.orgId
        if (orgId == null) return personal.firstOrNull { it.id == destination.folderId }?.name.orEmpty()
        val org = directory.orgName(orgId).orEmpty()
        val folder = directory.folderName(destination) ?: return org
        // Verbatim, as the account sheet writes it: two names and a separator.
        return "$org · $folder"
    }
}

private fun targetOf(destination: SaveDestination): FolderTarget {
    val orgId = destination.orgId
    val folderId = destination.folderId
    return when {
        orgId != null -> FolderTarget.Org(orgId, folderId)
        folderId != null -> FolderTarget.Existing(folderId)
        else -> FolderTarget.Root
    }
}

/** The picker's row for a selection, where it has one: a folder not made yet has none. */
private fun destinationOf(target: FolderTarget): SaveDestination? = when (target) {
    is FolderTarget.Existing -> SaveDestination(folderId = target.id)
    FolderTarget.Root -> SaveDestination.PERSONAL_ROOT
    is FolderTarget.Org -> SaveDestination(orgId = target.orgId, folderId = target.folderId)
    is FolderTarget.New -> null
}

// ── the flight ───────────────────────────────────────────────────────────────

/**
 * The accept in flight: which chip the card is flying into, how far along,
 * and which chip is popping. The name's and the chips' layout positions are
 * recorded as they are placed, and read when a flight starts.
 */
@Stable
private class Flight(
    private val scope: CoroutineScope,
    private val reduceMotion: Boolean,
    private val view: View,
) {
    var root: LayoutCoordinates? = null
    var title: LayoutCoordinates? = null
    val chips = mutableStateMapOf<String, LayoutCoordinates>()

    var flying by mutableStateOf<String?>(null)
        private set
    var popping by mutableStateOf<String?>(null)
        private set
    var from by mutableStateOf(Rect.Zero)
        private set
    var to by mutableStateOf(Rect.Zero)
        private set
    val progress = Animatable(0f)

    val inFlight: Boolean get() = flying != null

    /**
     * Fly into [key]'s chip, pop it, then [write]. With animations removed —
     * or when either end cannot be found — the write happens at once.
     */
    fun fly(key: String, write: () -> Unit) {
        if (flying != null) return
        val start = boundsOf(title)
        val end = boundsOf(chips[key])
        if (reduceMotion || start == null || end == null) {
            write()
            return
        }
        from = start
        to = end
        flying = key
        scope.launch {
            progress.snapTo(0f)
            val glide = launch {
                progress.animateTo(
                    1f,
                    spring(dampingRatio = FilingMotion.SPRING_DAMPING, stiffness = FilingMotion.SPRING_STIFFNESS),
                )
            }
            delay(FilingMotion.FLY_MS)
            popping = key
            successHaptic(view)
            delay(FilingMotion.POP_MS)
            popping = null
            glide.cancel()
            flying = null
            write()
        }
    }

    private fun boundsOf(target: LayoutCoordinates?): Rect? {
        val base = root ?: return null
        if (target == null || !target.isAttached || !base.isAttached) return null
        return base.localBoundingBoxOf(target, clipBounds = false)
    }
}

@Composable
private fun rememberFlight(reduceMotion: Boolean): Flight {
    val scope = rememberCoroutineScope()
    val view = LocalView.current
    return remember(scope, reduceMotion, view) { Flight(scope, reduceMotion, view) }
}

/** The card, in miniature, on its way from the name into a chip: a tinted slip with the title on it. */
@Composable
private fun FlightGhost(flight: Flight, title: String) {
    if (flight.flying == null) return
    val progress = flight.progress.value
    val rect = lerp(flight.from, flight.to, progress)
    val density = LocalDensity.current
    Box(
        modifier = Modifier
            .offset { IntOffset(rect.left.roundToInt(), rect.top.roundToInt()) }
            .size(with(density) { rect.width.toDp() }, with(density) { rect.height.toDp() })
            .graphicsLayer { alpha = 1f - (1f - FilingMotion.GHOST_LANDED_ALPHA) * progress.coerceIn(0f, 1f) }
            .clip(MaterialTheme.shapes.medium)
            .background(MaterialTheme.colorScheme.primary.copy(alpha = FilingMotion.WASH_ALPHA))
            .clearAndSetSemantics {},
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = title,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = 6.dp),
        )
    }
}

/**
 * The card landed in its folder — iOS `LapMotion.success()`. `CONFIRM` on API
 * 30+, the platform's own word for "that worked". Never load-bearing: it
 * honours the system's touch-feedback setting.
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
@Composable
private fun rememberAnimationsRemoved(): Boolean {
    val context = LocalContext.current
    return remember(context) { animationsRemoved(context) }
}

private fun animationsRemoved(context: Context): Boolean =
    Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f

private val CHIP_RADIUS = 12.dp

/** The wash fades in and out over this long — iOS `.easeOut(duration: 0.6)`. */
private const val WASH_FADE_MS = 600

/** The chip's pop: iOS `.spring(response: 0.2, dampingFraction: 0.5)`. */
private const val POP_DAMPING = 0.5f
private val POP_STIFFNESS = FilingMotion.stiffnessFor(0.2)
