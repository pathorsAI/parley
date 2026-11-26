package com.pathors.parley.ui

import android.net.Uri
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import com.pathors.parley.R
import com.pathors.parley.kit.ImportSplitPlan
import com.pathors.parley.meeting.importPartTitle

/** A picked file that is too long for one hosted session, waiting on the user's answer. */
data class PendingSplitImport(val uri: Uri, val title: String, val plan: ImportSplitPlan)

/**
 * Asked before any decoding starts: this file will be imported as
 * [PendingSplitImport.plan]'s parts, each its own recording. Cancelling imports
 * nothing.
 */
@Composable
fun ImportSplitDialog(
    pending: PendingSplitImport,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val count = pending.plan.count
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.import_split_title, count)) },
        text = {
            Text(
                text = stringResource(
                    R.string.import_split_body,
                    formatLongDuration(context, pending.plan.durationMs),
                    count,
                    formatLongDuration(context, pending.plan.partDurationMs),
                    importPartTitle(context, pending.title, 1, count),
                    importPartTitle(context, pending.title, 2, count),
                ),
                // The file name can be long; an AlertDialog clips rather than scrolls.
                modifier = Modifier.verticalScroll(rememberScrollState()),
            )
        },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(stringResource(R.string.import_split_confirm, count))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) }
        },
    )
}
