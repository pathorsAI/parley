package com.pathors.parley.ui

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
import androidx.compose.material.icons.filled.Search
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.pathors.parley.R
import com.pathors.parley.cloud.CloudFolder
import com.pathors.parley.kit.FolderSearch
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * "Move to folder": the scope's folders as a searchable list, in a sheet —
 * the Android half of iOS `FolderPickerSheet`.
 *
 * A menu of folders is fine for four and hopeless for forty, and a folder is a
 * customer, so forty is what a working account has. The search field is the
 * first thing under the title, and a name that matches nothing turns the first
 * row into "Create “…”" — so filing a call with a new customer is: type the
 * name, tap the top row, tap Create. Matching is [FolderSearch], the same rules
 * iOS uses.
 *
 * The sheet decides nothing about *how* a recording moves. [onSelect] is the
 * caller's own move (a meta re-push for a personal recording, a PATCH for an
 * org one), and [onCreate] is the caller's create-then-move — null where there
 * is no endpoint to create a folder with (an organization's library), which
 * hides the row rather than offering something that cannot work.
 *
 * iOS also has a "Suggested" section fed by its on-device filing suggestion.
 * Android has no filing suggestion to feed it, so the section is not here.
 *
 * @param currentFolderId where the recording is filed now; null is Unfiled.
 *   Callers pass the *live* folder (orphans are Unfiled), so the tick agrees
 *   with the page the row was on.
 * @param onSelect a folder was picked (null = Unfiled). Not called for the
 *   folder the recording is already in. The sheet dismisses itself either way.
 * @param onCreate create a folder with this name and move the recording into
 *   it. A throw keeps the sheet up with an error under the field.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FolderPickerSheet(
    folders: List<CloudFolder>,
    currentFolderId: String?,
    onSelect: (String?) -> Unit,
    onCreate: (suspend (String) -> Unit)?,
    onDismiss: () -> Unit,
) {
    // Fully expanded from the start. iOS opens at its medium detent and grows
    // on focus; a half-height Material sheet asked to expand while the IME is
    // animating in stays where it was, leaving the keyboard over the list.
    // The picker is a list someone searches, so it takes the room up front.
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    var query by remember { mutableStateOf("") }
    var creating by remember { mutableStateOf(false) }
    // A TextFieldValue so the name prefilled from the search opens with the
    // cursor at its end, where someone finishing the name will type.
    var newName by remember { mutableStateOf(TextFieldValue("")) }
    var busy by remember { mutableStateOf(false) }
    var createFailed by remember { mutableStateOf(false) }

    val unfiled = stringResource(R.string.library_folder_unfiled)
    val matches = remember(folders, query) { FolderSearch.filter(folders, query) { it.name } }
    val trimmed = FolderSearch.normalized(query)
    // Unfiled is a place too; it answers to its own name like a folder does.
    val showsUnfiled = FolderSearch.matches(unfiled, query)

    fun select(folderId: String?) {
        if (busy) return
        if (folderId != currentFolderId) onSelect(folderId)
        onDismiss()
    }

    fun openCreate() {
        newName = TextFieldValue(trimmed, selection = TextRange(trimmed.length))
        createFailed = false
        creating = true
    }

    // A name that already exists is a pick, not a second folder with the same
    // customer in it.
    fun create() {
        val name = FolderSearch.normalized(newName.text)
        val create = onCreate ?: return
        if (name.isEmpty() || busy) return
        FolderSearch.exactMatch(folders, name) { it.name }?.let { existing ->
            select(existing.id)
            return
        }
        busy = true
        createFailed = false
        scope.launch {
            try {
                create(name)
                onDismiss()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                createFailed = true
                busy = false
            }
        }
    }

    // Return in the search field: one match is a pick, no match is the create
    // row opened with the name already in it.
    fun submitSearch() {
        if (trimmed.isEmpty()) return
        when {
            matches.size == 1 -> select(matches.single().id)
            matches.isEmpty() && onCreate != null -> openCreate()
        }
    }

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
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 24.dp, end = 12.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(
                        text = stringResource(R.string.folder_picker_title),
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Text(
                        text = stringResource(R.string.folder_picker_subtitle),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) }
            }

            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp),
                placeholder = { Text(stringResource(R.string.folder_picker_search)) },
                leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
                trailingIcon = {
                    if (query.isNotEmpty()) {
                        IconButton(onClick = { query = "" }) {
                            Icon(Icons.Default.Clear, stringResource(R.string.action_clear))
                        }
                    }
                },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { submitSearch() }),
            )
            Spacer(Modifier.size(8.dp))
            HorizontalDivider()

            LazyColumn(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
                contentPadding = PaddingValues(bottom = 24.dp),
            ) {
                if (onCreate != null) {
                    item(key = "create") {
                        if (creating) {
                            CreateField(
                                name = newName,
                                onNameChange = {
                                    newName = it
                                    createFailed = false
                                },
                                busy = busy,
                                failed = createFailed,
                                onCreate = ::create,
                            )
                        } else {
                            PickerRow(
                                icon = LibraryIcons.NewFolder,
                                title = if (trimmed.isNotEmpty() && matches.isEmpty()) {
                                    stringResource(R.string.folder_picker_create_named, trimmed)
                                } else {
                                    stringResource(R.string.folder_picker_new)
                                },
                                accent = true,
                                isCurrent = false,
                                enabled = !busy,
                                onClick = ::openCreate,
                            )
                        }
                    }
                }
                items(matches, key = { "folder-" + it.id }) { folder ->
                    PickerRow(
                        icon = LibraryIcons.Folder,
                        title = folder.name,
                        isCurrent = folder.id == currentFolderId,
                        enabled = !busy,
                        onClick = { select(folder.id) },
                    )
                }
                if (showsUnfiled) {
                    item(key = "unfiled") {
                        PickerRow(
                            icon = LibraryIcons.Unfiled,
                            title = unfiled,
                            isCurrent = currentFolderId == null,
                            enabled = !busy,
                            onClick = { select(null) },
                        )
                    }
                }
                if (matches.isEmpty() && !showsUnfiled && onCreate == null) {
                    item(key = "none") {
                        Text(
                            text = stringResource(R.string.folder_picker_no_match),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 24.dp, vertical = 16.dp),
                        )
                    }
                }
            }
        }
    }
}

/**
 * One place to put the recording. Plain rows with no fill; the tint is kept for
 * what means something — the current folder's tick and the create action.
 */
@Composable
private fun PickerRow(
    icon: ImageVector,
    title: String,
    isCurrent: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
    accent: Boolean = false,
) {
    val currentLabel = stringResource(R.string.folder_picker_current)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clickable(enabled = enabled, onClick = onClick)
            .semantics { selected = isCurrent }
            .padding(horizontal = 24.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = if (accent) {
                MaterialTheme.colorScheme.primary
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            },
            modifier = Modifier.size(22.dp),
        )
        Spacer(Modifier.width(16.dp))
        Text(
            text = title,
            style = MaterialTheme.typography.bodyLarge,
            color = if (accent) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (isCurrent) {
            Spacer(Modifier.width(8.dp))
            Icon(
                imageVector = Icons.Default.Check,
                contentDescription = currentLabel,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}

/** The create row, opened: the name (prefilled from the search) and Create. */
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
