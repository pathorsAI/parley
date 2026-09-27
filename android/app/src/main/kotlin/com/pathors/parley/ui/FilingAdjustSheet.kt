package com.pathors.parley.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import com.pathors.parley.R
import com.pathors.parley.filing.FilingUiState
import com.pathors.parley.filing.FolderTarget

/**
 * `Adjust`: the name in a field, and the rest of the pass's answer — the
 * Android half of iOS `FilingAdjustSheet`.
 *
 * The folder list is the model's candidates, best-first, then "Choose another
 * folder…", which opens the library's own [FolderPickerSheet] over the
 * registry the pass already listed (no second fetch that could fail on its own,
 * or show a different list than the one the suggestion was made against). Its
 * "New folder" row names a folder to create; nothing is created until Save.
 *
 * Both edits are handed over together: applying them one at a time would be
 * two read-modify-writes against the same meta, and the second would carry a
 * copy read before the first landed.
 *
 * @param openPicker the screenshot demo's hook — the picker opened with nobody
 *   tapping.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FilingAdjustSheet(
    state: FilingUiState,
    onSave: (title: String, folder: FolderTarget?) -> Unit,
    onDismiss: () -> Unit,
    openPicker: Boolean = false,
) {
    var title by rememberSaveable { mutableStateOf(state.proposedTitle ?: state.currentTitle) }
    // Null is "leave it where it is". Tapping the ticked row unticks it, which
    // is the only way to accept a rename without a move.
    var chosen by remember { mutableStateOf(state.proposedFolder?.let(FolderTarget::of)) }
    var picking by remember { mutableStateOf(false) }
    LaunchedEffect(openPicker) { if (openPicker) picking = true }

    ModalBottomSheet(
        onDismissRequest = { if (!state.isWriting) onDismiss() },
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        contentWindowInsets = { WindowInsets.safeDrawing.only(WindowInsetsSides.Vertical) },
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(start = 24.dp, end = 12.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            AdjustHeader(busy = state.isWriting, onCancel = onDismiss, onSave = { onSave(title, chosen) })
            TitleField(title = title, onChange = { title = it })
            if (state.writeFailed) {
                Text(
                    text = stringResource(R.string.filing_write_failed),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            FolderChoices(
                state = state,
                chosen = chosen,
                onChoose = { chosen = it },
                onPickOther = { picking = true },
            )
        }
    }

    if (picking) {
        FolderPickerSheet(
            folders = state.existingFolders,
            currentFolderId = pickerTick(chosen, state.currentFolderId),
            onSelect = { id -> chosen = id?.let(FolderTarget::Existing) ?: FolderTarget.Root },
            onCreate = { name -> chosen = FolderTarget.New(name) },
            onDismiss = { picking = false },
        )
    }
}

/** The folder the picker ticks: the one chosen here, else where the recording already is. */
private fun pickerTick(chosen: FolderTarget?, currentFolderId: String?): String? = when (chosen) {
    is FolderTarget.Existing -> chosen.id
    FolderTarget.Root -> null
    else -> currentFolderId
}

@Composable
private fun AdjustHeader(busy: Boolean, onCancel: () -> Unit, onSave: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            text = stringResource(R.string.filing_adjust),
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.weight(1f),
        )
        TextButton(onClick = onCancel, enabled = !busy) {
            Text(stringResource(R.string.action_cancel))
        }
        if (busy) {
            CircularProgressIndicator(
                modifier = Modifier
                    .padding(horizontal = 16.dp)
                    .size(18.dp),
                strokeWidth = 2.dp,
            )
        } else {
            TextButton(onClick = onSave) {
                Text(stringResource(R.string.filing_save), fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

@Composable
private fun TitleField(title: String, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = title,
        onValueChange = onChange,
        label = { Text(stringResource(R.string.filing_title)) },
        trailingIcon = {
            if (title.isNotEmpty()) {
                IconButton(onClick = { onChange("") }) {
                    Icon(Icons.Default.Clear, contentDescription = stringResource(R.string.action_clear))
                }
            }
        },
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, autoCorrectEnabled = false),
        modifier = Modifier
            .fillMaxWidth()
            .padding(end = 12.dp),
    )
}

/**
 * The model's candidates, then whatever was picked from the full list, then
 * the way into that list. One folder is never two rows: a pick that is also a
 * candidate ticks the candidate.
 */
@Composable
private fun FolderChoices(
    state: FilingUiState,
    chosen: FolderTarget?,
    onChoose: (FolderTarget?) -> Unit,
    onPickOther: () -> Unit,
) {
    val candidates = state.proposedFolders.map { it to FolderTarget.of(it) }
    Column {
        Text(
            text = stringResource(R.string.filing_move_to_folder),
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        candidates.forEach { (folder, target) ->
            FilingChoiceRow(
                name = folder.name,
                reason = folder.reason,
                isNew = folder.folderId == null,
                chosen = chosen == target,
                enabled = !state.isWriting,
                onClick = { onChoose(if (chosen == target) null else target) },
            )
        }
        if (chosen != null && candidates.none { it.second == chosen }) {
            FilingChoiceRow(
                name = pickedName(chosen, state),
                reason = "",
                isNew = chosen is FolderTarget.New,
                chosen = true,
                enabled = !state.isWriting,
                onClick = { onChoose(null) },
            )
        }
        OtherFolderRow(enabled = !state.isWriting, onClick = onPickOther)
    }
}

@Composable
private fun pickedName(target: FolderTarget, state: FilingUiState): String = when (target) {
    is FolderTarget.Existing -> state.existingFolders.firstOrNull { it.id == target.id }?.name.orEmpty()
    is FolderTarget.New -> target.name
    FolderTarget.Root -> stringResource(R.string.library_folder_unfiled)
}

@Composable
private fun OtherFolderRow(enabled: Boolean, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = LibraryIcons.Folder,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(20.dp),
        )
        Spacer(Modifier.width(12.dp))
        Text(
            text = stringResource(R.string.filing_other_folder),
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.primary,
        )
    }
}

/** Blue, because it is the one thing on the list that is true right now. */
@Composable
internal fun ChoiceTick(chosen: Boolean) {
    Spacer(Modifier.width(8.dp))
    Icon(
        imageVector = Icons.Default.Check,
        contentDescription = null,
        tint = if (chosen) MaterialTheme.colorScheme.primary else Color.Transparent,
        modifier = Modifier
            .padding(end = 12.dp)
            .size(20.dp),
    )
}
