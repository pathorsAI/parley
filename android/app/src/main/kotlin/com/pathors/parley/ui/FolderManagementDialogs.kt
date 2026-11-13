package com.pathors.parley.ui

import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import com.pathors.parley.R
import com.pathors.parley.cloud.CloudFolder

/**
 * The chip row's name dialog: a new folder, or a new name for one that exists
 * — iOS `LibraryView`'s `FolderNaming`.
 */
internal sealed interface FolderNaming {
    data object Create : FolderNaming

    data class Rename(val folder: CloudFolder) : FolderNaming
}

/** What the chip row's long-press menu and trailing "+" ask for. */
internal class FolderChipActions(
    val onCreate: () -> Unit = {},
    val onRename: (CloudFolder) -> Unit = {},
    val onDelete: (CloudFolder) -> Unit = {},
)

/**
 * The name field for [naming], prefilled with the folder's name on a rename
 * (selected, so typing replaces it) and empty for a new folder. The confirm is
 * off while the trimmed name is blank, as on iOS; an unchanged rename is let
 * through and dropped by [LibraryRules.folderNameToCommit].
 */
@Composable
internal fun FolderNameDialog(
    naming: FolderNaming,
    onConfirm: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val initial = (naming as? FolderNaming.Rename)?.folder?.name.orEmpty()
    var draft by remember(naming) {
        mutableStateOf(TextFieldValue(initial, selection = TextRange(0, initial.length)))
    }
    val focus = remember { FocusRequester() }
    LaunchedEffect(naming) { focus.requestFocus() }
    val canConfirm = draft.text.isNotBlank()
    val confirm = {
        if (canConfirm) onConfirm(draft.text)
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                stringResource(
                    when (naming) {
                        FolderNaming.Create -> R.string.library_folder_new
                        is FolderNaming.Rename -> R.string.library_folder_rename_title
                    },
                ),
            )
        },
        text = {
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it },
                placeholder = { Text(stringResource(R.string.library_folder_name_hint)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.Sentences,
                    imeAction = ImeAction.Done,
                ),
                keyboardActions = KeyboardActions(onDone = { confirm() }),
                modifier = Modifier.focusRequester(focus),
            )
        },
        confirmButton = {
            TextButton(onClick = confirm, enabled = canConfirm) {
                Text(
                    stringResource(
                        when (naming) {
                            FolderNaming.Create -> R.string.library_folder_create
                            is FolderNaming.Rename -> R.string.library_folder_save
                        },
                    ),
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) }
        },
    )
}

/**
 * The second press before a folder goes. The body says what happens to what is
 * in it, because "delete" next to a folder of recordings reads as deleting
 * them: [recordingCount] of them move to Unfiled and none is deleted.
 */
@Composable
internal fun DeleteFolderDialog(
    folder: CloudFolder,
    recordingCount: Int,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.library_folder_delete_title, folder.name)) },
        text = {
            Text(
                text = if (recordingCount == 0) {
                    stringResource(R.string.library_folder_delete_empty)
                } else {
                    pluralStringResource(R.plurals.library_folder_delete_body, recordingCount, recordingCount)
                },
                modifier = Modifier.verticalScroll(rememberScrollState()),
            )
        },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(
                    text = stringResource(R.string.library_folder_delete),
                    color = MaterialTheme.colorScheme.error,
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) }
        },
    )
}
