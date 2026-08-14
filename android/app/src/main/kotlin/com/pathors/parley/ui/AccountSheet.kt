package com.pathors.parley.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.pathors.parley.R
import com.pathors.parley.cloud.HostedQuota

/**
 * Who is signed in, what the plan has left, and the way out.
 *
 * Usage comes from `GET /me/usage`, the same numbers the relay enforces — so a
 * "quota exhausted" banner during a meeting and this sheet always agree.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AccountSheet(viewModel: HomeViewModel, onDismiss: () -> Unit) {
    val account by viewModel.account.collectAsState()
    val sheetState = rememberModalBottomSheetState()

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
        }
    }
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
