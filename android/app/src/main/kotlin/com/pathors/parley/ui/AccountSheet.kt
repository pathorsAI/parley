package com.pathors.parley.ui

import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.pathors.parley.R
import com.pathors.parley.cloud.HostedQuota

/**
 * Who is signed in, what the plan has left, and the two ways out — signing out,
 * and deleting the account for good.
 *
 * Usage comes from `GET /me/usage`, the same numbers the relay enforces — so a
 * "quota exhausted" banner during a meeting and this sheet always agree.
 *
 * Account deletion lives here because this is the account surface, and because
 * Google Play requires an in-app deletion route for any app that offers account
 * creation. It mirrors iOS Settings → Account: a destructive button that only
 * arms a confirmation dialog, and a second, separately-labelled destructive tap
 * inside that dialog to actually go through with it. One stray tap can never
 * delete an account.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AccountSheet(
    viewModel: HomeViewModel,
    onDismiss: () -> Unit,
    onSetUpVoiceTyping: () -> Unit,
) {
    val account by viewModel.account.collectAsState()
    val sheetState = rememberModalBottomSheetState()
    var confirmingDelete by remember { mutableStateOf(false) }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 24.dp, end = 24.dp, bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = stringResource(R.string.account_title),
                style = MaterialTheme.typography.titleLarge,
            )

            AccountIdentity(account)

            HorizontalDivider(Modifier.padding(vertical = 8.dp))

            // Voice typing has no home of its own in the library, and this is the
            // app's only settings-shaped surface. The steps themselves live on
            // their own screen because one of them — granting the microphone —
            // needs an Activity the keyboard does not have; see
            // ui/VoiceTypingSetupScreen.kt.
            TextButton(onClick = onSetUpVoiceTyping) {
                Text(stringResource(R.string.account_voice_typing))
            }

            HorizontalDivider(Modifier.padding(vertical = 8.dp))

            TextButton(
                onClick = {
                    viewModel.signOut()
                    onDismiss()
                },
            ) {
                Text(
                    text = stringResource(R.string.account_sign_out),
                    color = MaterialTheme.colorScheme.error,
                )
            }

            DeleteAccountSection(
                account = account,
                onArm = {
                    viewModel.clearDeleteAccountError()
                    confirmingDelete = true
                },
            )
        }
    }

    if (confirmingDelete) {
        DeleteAccountDialog(
            onConfirm = {
                confirmingDelete = false
                viewModel.deleteAccount()
            },
            onDismiss = { confirmingDelete = false },
        )
    }
}

/**
 * Who is signed in and what the plan has left — or why neither is known yet.
 */
@Composable
private fun AccountIdentity(account: HomeViewModel.AccountState) {
    when {
        account.loading -> Text(
            text = stringResource(R.string.account_loading),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        account.failed -> Text(
            text = stringResource(R.string.account_load_failed),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.error,
        )

        else -> {
            account.user?.let { user ->
                Text(text = user.email, style = MaterialTheme.typography.bodyLarge)
            }
            account.quota?.let { quota -> QuotaLines(quota) }
        }
    }
}

/**
 * The first step of deletion: a destructive button that only arms the
 * confirmation dialog, plus whatever the last attempt failed with.
 *
 * Same condition as iOS: shown once `me()` has confirmed who is signed in.
 * While the account is merely unreachable there is no point offering a call
 * that cannot reach the server either.
 */
@Composable
private fun DeleteAccountSection(account: HomeViewModel.AccountState, onArm: () -> Unit) {
    if (account.user == null) return

    TextButton(onClick = onArm, enabled = !account.deleting) {
        Text(
            text = stringResource(
                if (account.deleting) {
                    R.string.account_delete_in_progress
                } else {
                    R.string.account_delete
                }
            ),
            color = MaterialTheme.colorScheme.error,
        )
    }

    account.deleteError?.let { error ->
        Text(
            text = stringResource(deleteErrorMessage(error)),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error,
        )
    }
}

@StringRes
private fun deleteErrorMessage(error: DeleteAccountError): Int = when (error) {
    DeleteAccountError.OWNS_ORGANIZATIONS -> R.string.account_delete_error_owns_organizations
    DeleteAccountError.FAILED -> R.string.account_delete_error_failed
}

/**
 * The second step. Its body spells out exactly what is destroyed — the account,
 * every synced recording and its audio, permanently — rather than asking "are you
 * sure?", and the confirm button repeats the action instead of saying "OK", so
 * the destructive tap is never ambiguous.
 */
@Composable
private fun DeleteAccountDialog(onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.account_delete_confirm_title)) },
        text = { Text(stringResource(R.string.account_delete_confirm_body)) },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(
                    text = stringResource(R.string.account_delete_confirm_action),
                    color = MaterialTheme.colorScheme.error,
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.action_cancel))
            }
        },
    )
}

@Composable
private fun QuotaLines(quota: HostedQuota) {
    val unlimited = stringResource(R.string.account_unlimited)

    quota.plan?.takeIf { it.isNotEmpty() }?.let { plan ->
        Text(
            text = stringResource(R.string.account_plan, plan),
            style = MaterialTheme.typography.bodyMedium,
        )
    }

    Text(
        text = stringResource(R.string.account_usage_title),
        style = MaterialTheme.typography.titleSmall,
        modifier = Modifier.padding(top = 8.dp),
    )

    val sttUsed = formatSeconds(quota.sttSecondsUsed ?: 0.0)
    Text(
        text = quota.sttSecondsLimit
            ?.let { stringResource(R.string.account_stt_usage, sttUsed, formatSeconds(it)) }
            ?: stringResource(R.string.account_stt_usage, sttUsed, unlimited),
        style = MaterialTheme.typography.bodyMedium,
    )

    val llmUsed = formatCredits(quota.llmCreditsUsed ?: 0.0)
    Text(
        text = quota.llmCreditsLimit
            ?.let { stringResource(R.string.account_llm_usage, llmUsed, formatCredits(it)) }
            ?: stringResource(R.string.account_llm_usage, llmUsed, unlimited),
        style = MaterialTheme.typography.bodyMedium,
    )

    quota.periodResetTs?.let { reset ->
        Text(
            text = stringResource(R.string.account_period_reset, formatDate(reset)),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
