package com.pathors.parley.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.pathors.parley.R
import com.pathors.parley.cloud.CloudFolder
import com.pathors.parley.cloud.CloudOrg
import com.pathors.parley.kit.FolderSearch
import com.pathors.parley.library.FolderScope
import com.pathors.parley.library.SaveDestination
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** What choosing an organization from the personal library does to the recording, said under the header. */
enum class OrgHandoff {
    /** "Move to…": the copy goes in, the personal original is deleted. */
    MOVE,

    /** The filing card: a copy is shared in, the personal recording stays. */
    COPY,
}

/**
 * "Move to…": every place a recording can go, as a searchable list in a sheet,
 * one section per library — the personal one first, then each organization
 * under its own name. The Android half of iOS `FolderPickerSheet`, grown to
 * cover the organizations the desktop's move dialog already does.
 *
 * A menu of folders is fine for four and hopeless for forty, and a folder is a
 * customer, so forty is what a working account has. The search field is the
 * first thing under the title, and a name that matches nothing turns the first
 * row into "Create “…”". Matching is [FolderSearch], the same rules iOS uses.
 *
 * **A tap selects; the button files.** Tapping a row (or Return on the only
 * match) moves the selection, drawn as a tinted row with a tick; nothing is
 * written until the header's confirm button. One tap used to be the whole
 * move, and a tester filed a meeting into the wrong customer that way. A
 * folder made with Create is selected the same way, not filed into.
 *
 * The sheet decides nothing about *how* a recording moves. [onConfirm] is the
 * caller's own move, and [onCreate] makes a folder in the FIRST scope — null
 * where there is no endpoint to create one with, which hides the row rather
 * than offering something that cannot work.
 *
 * [suggested] is iOS's "Suggested" section: the filing card's "Choose
 * another…" opens the picker with the suggestion's own folders listed first.
 * A suggested folder that is not in the personal scope (deleted meanwhile) is
 * not offered.
 *
 * @param current where the recording is now, as the library renders it
 *   (orphans are the root), so its row says "Current folder" and the confirm
 *   button stays off while it is selected. Null when the recording is nowhere
 *   yet worth naming.
 * @param onConfirm the confirm button, with the selection. The sheet dismisses
 *   itself after.
 * @param selected what the sheet opens with selected: where the recording is,
 *   unless the caller is holding a choice of its own (the filing card's).
 * @param onCreate create a folder with this name in the first scope. A throw
 *   keeps the sheet up with an error under the field.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FolderPickerSheet(
    scopes: List<FolderScope>,
    current: SaveDestination?,
    onConfirm: (SaveDestination) -> Unit,
    onCreate: (suspend (String) -> CloudFolder)?,
    onDismiss: () -> Unit,
    selected: SaveDestination? = current,
    suggested: List<CloudFolder> = emptyList(),
    showsRoot: Boolean = true,
    title: String = stringResource(R.string.folder_picker_title),
    confirmLabel: String = stringResource(R.string.folder_picker_move_here),
    orgHandoff: OrgHandoff = OrgHandoff.MOVE,
) {
    // Fully expanded from the start. iOS opens at its medium detent and grows
    // on focus; a half-height Material sheet asked to expand while the IME is
    // animating in stays where it was, leaving the keyboard over the list.
    // The picker is a list someone searches, so it takes the room up front.
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val picker = remember { FolderPickerState(selected) }
    val listed = remember(scopes, picker.created) { picker.withCreated(scopes) }
    val unfiled = stringResource(R.string.library_folder_unfiled)
    val orgRoot = stringResource(R.string.folder_picker_org_root)
    val items = remember(listed, suggested, picker.query, showsRoot, unfiled, orgRoot) {
        FolderPickerRules.items(listed, picker.query, suggested, { if (it.org == null) unfiled else orgRoot }, showsRoot)
    }
    val trimmed = FolderSearch.normalized(picker.query)
    val matches = FolderPickerRules.folderMatches(items)
    val target = PickerTarget(listed.firstOrNull(), onCreate)
    // Only a personal recording changes hands by going to an organization.
    val handoffOrg = picker.selected?.orgId
        ?.takeIf { scopes.firstOrNull()?.org == null }
        ?.let { id -> listed.firstOrNull { it.orgId == id }?.org }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        // Full height reaches the status bar, so the top inset is honoured
        // (without it the drag handle sits behind the clock, as AccountSheet
        // found) — and safeDrawing rather than systemBars, so the keyboard's
        // inset is too and the last rows stay reachable above it.
        contentWindowInsets = { WindowInsets.safeDrawing.only(WindowInsetsSides.Vertical) },
    ) {
        // Always the full height, whatever the search has narrowed the list
        // to: a sheet that shrank with every keystroke would jump under the
        // thumb, and at full height the top inset above sits where it belongs.
        Column(Modifier.fillMaxSize()) {
            PickerHeader(
                title = title,
                confirmLabel = confirmLabel,
                canConfirm = !picker.busy && FolderPickerRules.canConfirm(picker.selected, current),
                onConfirm = {
                    picker.selected?.let(onConfirm)
                    onDismiss()
                },
                onDismiss = onDismiss,
            )
            if (handoffOrg != null) HandoffNote(handoffOrg, orgHandoff)
            PickerSearchField(
                query = picker.query,
                onQueryChange = { picker.query = it },
                onSearch = { picker.submitSearch(target, matches, trimmed) },
            )
            Spacer(Modifier.size(8.dp))
            HorizontalDivider()
            PickerList(
                list = PickerListModel(
                    items = items,
                    selected = picker.selected,
                    current = current,
                    showsNoMatch = FolderPickerRules.showsNoMatch(items, onCreate != null),
                    busy = picker.busy,
                ),
                createRow = if (onCreate != null) {
                    {
                        CreateRow(
                            picker = picker,
                            named = FolderPickerRules.offersNamedCreate(trimmed, matches.size),
                            trimmed = trimmed,
                            onCreate = { picker.create(target, scope) },
                        )
                    }
                } else {
                    null
                },
                onSelect = { picker.selected = it },
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
            )
        }
    }
}

/** Where a create goes, and the caller's create. */
private class PickerTarget(
    /** The scope a new folder is made in: the first one. */
    val createScope: FolderScope?,
    val onCreate: (suspend (String) -> CloudFolder)?,
)

/** The sheet's own state: the search, the selection, and the create row once it is open. */
@Stable
private class FolderPickerState(initial: SaveDestination?) {
    var query by mutableStateOf("")
    var selected by mutableStateOf(initial)
    var creating by mutableStateOf(false)

    // A TextFieldValue so the name prefilled from the search opens with the
    // cursor at its end, where someone finishing the name will type.
    var newName by mutableStateOf(TextFieldValue(""))
    var busy by mutableStateOf(false)
    var createFailed by mutableStateOf(false)

    /**
     * Folders made here, shown in the first scope at once. The caller's own
     * list catches up when its state does; the two are merged by id.
     */
    var created by mutableStateOf(emptyList<CloudFolder>())

    fun withCreated(scopes: List<FolderScope>): List<FolderScope> {
        if (created.isEmpty() || scopes.isEmpty()) return scopes
        val first = scopes.first()
        val known = first.folders.mapTo(HashSet()) { it.id }
        return listOf(first.copy(folders = first.folders + created.filterNot { it.id in known })) + scopes.drop(1)
    }

    fun openCreate(trimmed: String) {
        newName = TextFieldValue(trimmed, selection = TextRange(trimmed.length))
        createFailed = false
        creating = true
    }

    fun editName(value: TextFieldValue) {
        newName = value
        createFailed = false
    }

    fun submitSearch(target: PickerTarget, matches: List<SaveDestination>, trimmed: String) {
        when (FolderPickerRules.submitAction(trimmed, matches.size, target.onCreate != null)) {
            FolderPickerRules.SubmitAction.SELECT_ONLY_MATCH -> selected = matches.single()
            FolderPickerRules.SubmitAction.OPEN_CREATE -> openCreate(trimmed)
            FolderPickerRules.SubmitAction.NOTHING -> Unit
        }
    }

    fun create(target: PickerTarget, scope: CoroutineScope) {
        val create = target.onCreate
        val home = target.createScope
        val folders = home?.folders.orEmpty() + created
        when (val action = FolderPickerRules.createAction(newName.text, folders, create != null, busy)) {
            FolderPickerRules.CreateAction.Ignore -> Unit
            is FolderPickerRules.CreateAction.SelectExisting -> {
                selected = SaveDestination(orgId = home?.orgId, folderId = action.folderId)
                creating = false
            }
            is FolderPickerRules.CreateAction.Create -> if (create != null) {
                launchCreate(scope, action.name, home?.orgId, create)
            }
        }
    }

    /** The create request itself. A throw keeps the sheet up with the error under the field. */
    private fun launchCreate(
        scope: CoroutineScope,
        name: String,
        orgId: String?,
        create: suspend (String) -> CloudFolder,
    ) {
        busy = true
        createFailed = false
        scope.launch {
            try {
                val folder = create(name)
                created = created + folder
                selected = SaveDestination(orgId = orgId, folderId = folder.id)
                creating = false
                query = ""
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                createFailed = true
            } finally {
                busy = false
            }
        }
    }
}

/** The rows under the search field, as the list draws them. */
private class PickerListModel(
    val items: List<FolderPickerRules.Item>,
    val selected: SaveDestination?,
    val current: SaveDestination?,
    val showsNoMatch: Boolean,
    val busy: Boolean,
)

@Composable
private fun PickerHeader(
    title: String,
    confirmLabel: String,
    canConfirm: Boolean,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 24.dp, end = 16.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(text = title, style = MaterialTheme.typography.titleMedium)
            Text(
                text = stringResource(R.string.folder_picker_subtitle),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) }
        Spacer(Modifier.width(4.dp))
        Button(onClick = onConfirm, enabled = canConfirm) { Text(confirmLabel) }
    }
}

/** What choosing [org] will do, said before the button is pressed rather than after. */
@Composable
private fun HandoffNote(org: CloudOrg, handoff: OrgHandoff) {
    Text(
        text = stringResource(
            when (handoff) {
                OrgHandoff.MOVE -> R.string.folder_picker_org_move_note
                OrgHandoff.COPY -> R.string.folder_picker_org_copy_note
            },
            org.name,
        ),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 24.dp, end = 24.dp, bottom = 8.dp),
    )
}

@Composable
private fun PickerSearchField(query: String, onQueryChange: (String) -> Unit, onSearch: () -> Unit) {
    OutlinedTextField(
        value = query,
        onValueChange = onQueryChange,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp),
        placeholder = { Text(stringResource(R.string.folder_picker_search)) },
        leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
        trailingIcon = {
            if (query.isNotEmpty()) {
                IconButton(onClick = { onQueryChange("") }) {
                    Icon(Icons.Default.Clear, stringResource(R.string.action_clear))
                }
            }
        },
        singleLine = true,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        keyboardActions = KeyboardActions(onSearch = { onSearch() }),
    )
}

/**
 * The create row first (null where there is no create), then the rows
 * [FolderPickerRules.items] laid out, and "no match" when there is nothing at all.
 */
@Composable
private fun PickerList(
    list: PickerListModel,
    createRow: (@Composable () -> Unit)?,
    onSelect: (SaveDestination) -> Unit,
    modifier: Modifier = Modifier,
) {
    LazyColumn(
        modifier = modifier,
        contentPadding = PaddingValues(bottom = 24.dp),
    ) {
        if (createRow != null) {
            item(key = "create") { createRow() }
        }
        // Section labels are rows rather than sticky headers, as on iOS: a
        // pinned header needs a fill behind it, which this page does without.
        items(list.items, key = ::itemKey) { item ->
            when (item) {
                FolderPickerRules.Item.SuggestedHeader -> SectionLabel(stringResource(R.string.folder_picker_suggested))
                is FolderPickerRules.Item.ScopeHeader -> ScopeHeader(item.org)
                is FolderPickerRules.Item.Place -> PickerRow(
                    icon = if (item.isRoot) LibraryIcons.Unfiled else LibraryIcons.Folder,
                    title = item.name,
                    isSelected = item.destination == list.selected,
                    isCurrent = item.destination == list.current,
                    enabled = !list.busy,
                    onClick = { onSelect(item.destination) },
                )
            }
        }
        if (list.showsNoMatch) {
            item(key = "none") { NoMatchRow() }
        }
    }
}

private fun itemKey(item: FolderPickerRules.Item): String = when (item) {
    FolderPickerRules.Item.SuggestedHeader -> "suggested-label"
    is FolderPickerRules.Item.ScopeHeader -> "scope-" + (item.org?.id ?: "personal")
    is FolderPickerRules.Item.Place ->
        (if (item.suggested) "suggested-" else "place-") + item.destination.encode()
}

/**
 * A library's label: "Personal", or the organization's name with an
 * "Organization" tag beside it. The tester's question was which folders were
 * theirs and which the team's, and a name alone does not say.
 */
@Composable
private fun ScopeHeader(org: CloudOrg?) {
    val name = org?.name.orEmpty()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 24.dp, end = 24.dp, top = 20.dp, bottom = 4.dp)
            .semantics(mergeDescendants = true) { heading() },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = if (org == null) Icons.Default.Person else LibraryIcons.Group,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(16.dp),
        )
        Spacer(Modifier.width(8.dp))
        Text(
            text = when {
                org == null -> stringResource(R.string.library_scope_personal)
                name.isEmpty() -> stringResource(R.string.folder_picker_org_badge)
                else -> name
            },
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        if (org != null && name.isNotEmpty()) {
            Spacer(Modifier.width(8.dp))
            Text(
                text = stringResource(R.string.folder_picker_org_badge),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier
                    .border(1.dp, MaterialTheme.colorScheme.outlineVariant, MaterialTheme.shapes.small)
                    .padding(horizontal = 6.dp, vertical = 1.dp),
            )
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 24.dp, end = 24.dp, top = 16.dp, bottom = 4.dp),
    )
}

@Composable
private fun NoMatchRow() {
    Text(
        text = stringResource(R.string.folder_picker_no_match),
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 24.dp, vertical = 16.dp),
    )
}

/**
 * The create row: "New folder…" (or "Create “…”" when [named]), and once tapped
 * the name field with Create.
 */
@Composable
private fun CreateRow(
    picker: FolderPickerState,
    named: Boolean,
    trimmed: String,
    onCreate: () -> Unit,
) {
    if (picker.creating) {
        CreateField(
            name = picker.newName,
            onNameChange = picker::editName,
            busy = picker.busy,
            failed = picker.createFailed,
            onCreate = onCreate,
        )
    } else {
        PickerRow(
            icon = LibraryIcons.NewFolder,
            title = if (named) {
                stringResource(R.string.folder_picker_create_named, trimmed)
            } else {
                stringResource(R.string.folder_picker_new)
            },
            accent = true,
            isSelected = false,
            isCurrent = false,
            enabled = !picker.busy,
            onClick = { picker.openCreate(trimmed) },
        )
    }
}

/**
 * One place to put the recording. Plain rows with no fill except the selected
 * one, washed in the tint with a tick — the one place the confirm button will
 * file into. Where the recording is now says so in a caption instead.
 */
@Composable
private fun PickerRow(
    icon: ImageVector,
    title: String,
    isSelected: Boolean,
    isCurrent: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
    accent: Boolean = false,
) {
    val tinted = accent || isSelected
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .background(
                if (isSelected) {
                    MaterialTheme.colorScheme.primary.copy(alpha = SELECTED_WASH_ALPHA)
                } else {
                    Color.Transparent
                },
            )
            .clickable(enabled = enabled, onClick = onClick)
            .semantics { selected = isSelected }
            .padding(horizontal = 24.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = if (tinted) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(22.dp),
        )
        Spacer(Modifier.width(16.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text = title,
                style = MaterialTheme.typography.bodyLarge,
                color = if (tinted) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            if (isCurrent) {
                Text(
                    text = stringResource(R.string.folder_picker_current),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (isSelected) {
            Spacer(Modifier.width(8.dp))
            Icon(
                imageVector = Icons.Default.Check,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}

/**
 * The create row, opened: the name (prefilled from the search) and Create.
 * Done on the keyboard creates the folder and selects it; it files nothing.
 */
@Composable
private fun CreateField(
    name: TextFieldValue,
    onNameChange: (TextFieldValue) -> Unit,
    busy: Boolean,
    failed: Boolean,
    onCreate: () -> Unit,
) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 24.dp, end = 16.dp, top = 8.dp, bottom = 8.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                imageVector = LibraryIcons.NewFolder,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(22.dp),
            )
            Spacer(Modifier.width(12.dp))
            OutlinedTextField(
                value = name,
                onValueChange = onNameChange,
                enabled = !busy,
                singleLine = true,
                placeholder = { Text(stringResource(R.string.folder_picker_name_hint)) },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { onCreate() }),
                modifier = Modifier
                    .weight(1f)
                    .focusRequester(focus),
            )
            Spacer(Modifier.width(4.dp))
            if (busy) {
                CircularProgressIndicator(
                    modifier = Modifier
                        .padding(12.dp)
                        .size(20.dp),
                    strokeWidth = 2.dp,
                )
            } else {
                TextButton(onClick = onCreate, enabled = FolderSearch.normalized(name.text).isNotEmpty()) {
                    Text(stringResource(R.string.folder_picker_create))
                }
            }
        }
        if (failed) {
            Text(
                text = stringResource(R.string.folder_picker_create_failed),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(start = 34.dp),
            )
        }
    }
}

/** The selected row's wash: the filing card's own tint, at a strength a list row can carry. */
private const val SELECTED_WASH_ALPHA = 0.10f
