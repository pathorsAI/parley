package com.pathors.parley.ui

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.pathors.parley.BuildConfig
import com.pathors.parley.R
import com.pathors.parley.auth.CustomTabsLauncher
import com.pathors.parley.cloud.HostedQuota
import com.pathors.parley.playback.AudioStorageSection
import com.pathors.parley.ui.theme.ParleyTextStyles
import com.pathors.parley.ui.theme.ThemePreference
import com.pathors.parley.ui.theme.rememberThemePreference
import com.pathors.parley.ui.theme.rememberThemePreferenceStore
import java.util.Locale
import kotlinx.coroutines.launch

/**
 * Everything the phone lets you settle: who is signed in, what the plan has
 * left, what has not reached the cloud yet, how much of the device the app is
 * using, how it looks, what language it speaks, which version it is — and the
 * two ways out, signing out and deleting the account for good.
 *
 * ## Why this is still a bottom sheet
 *
 * iOS puts the same material on a pushed `SettingsView`, and this has grown to
 * roughly that much material. It stays a sheet anyway, for two reasons. The
 * modest one: the summoned-and-dismissed surface *is* the Android grammar for a
 * settings pane reached from an avatar button, and promoting it to a route would
 * buy a second top app bar and a back-stack entry for content that still fits one
 * expanded sheet. The load-bearing one: the sheet is opened from `HomeScreen`'s
 * top bar and from the `parley://demo/account` cue that `HomeScreen` watches, so
 * a route would have to be wired through a file this change does not own.
 *
 * What did change is that the sheet now opens fully expanded and scrolls its own
 * content — at the largest font scales the old half-height sheet would have shown
 * the email address and nothing else.
 *
 * Usage comes from `GET /me/usage`, the same numbers the relay enforces — so a
 * "quota exhausted" banner during a meeting and this sheet always agree. Sync
 * reads only on-device state, so it stays readable while offline; that is exactly
 * when someone needs to see that a finished recording is queued rather than lost.
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
fun AccountSheet(viewModel: HomeViewModel, onDismiss: () -> Unit) {
    val account by viewModel.account.collectAsState()
    val library by viewModel.state.collectAsState()
    // Fully expanded, never half: there is more here than a half-height sheet can
    // show, and a settings pane that opens mid-scroll reads as broken.
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var confirmingDelete by remember { mutableStateOf(false) }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        // Expanded, this sheet is as tall as the screen, so it is the first one
        // in the app that can reach the status bar — without this the drag handle
        // is drawn behind the clock.
        contentWindowInsets = { WindowInsets.systemBars.only(WindowInsetsSides.Vertical) },
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(start = 24.dp, end = 24.dp, bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = stringResource(R.string.account_title),
                style = MaterialTheme.typography.titleLarge,
            )

            AccountIdentity(account)

            account.quota?.let { quota -> UsageSection(quota) }

            SyncSection(
                pending = library.pending.size,
                uploading = library.uploading,
                onRetry = viewModel::uploadNow,
            )

            AudioStorageSection()

            AppearanceSection()

            LanguageSection()

            AboutSection()

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
 * Light, dark, or whatever the phone is doing.
 *
 * The app used to have no say: the theme read `isSystemInDarkTheme()` and that
 * was the end of it. It reads a stored preference now, and this is the only
 * place to set it — iOS offers the same three (`SettingsView`'s appearance
 * picker), and someone who keeps their phone on auto but wants one app dark
 * has nowhere else to say so.
 */
@Composable
private fun AppearanceSection() {
    val store = rememberThemePreferenceStore()
    val current = rememberThemePreference()
    val scope = rememberCoroutineScope()

    SectionHeader(R.string.account_appearance)
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
        ThemePreference.entries.forEachIndexed { index, preference ->
            SegmentedButton(
                selected = preference == current,
                onClick = { scope.launch { store.set(preference) } },
                shape = SegmentedButtonDefaults.itemShape(
                    index = index,
                    count = ThemePreference.entries.size,
                ),
            ) {
                Text(stringResource(appearanceLabel(preference)))
            }
        }
    }
}

@StringRes
private fun appearanceLabel(preference: ThemePreference): Int = when (preference) {
    ThemePreference.SYSTEM -> R.string.account_appearance_system
    ThemePreference.LIGHT -> R.string.account_appearance_light
    ThemePreference.DARK -> R.string.account_appearance_dark
}

/**
 * Who is signed in and which plan they are on — or why neither is known yet.
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
            account.quota?.plan?.takeIf { it.isNotEmpty() }?.let { plan ->
                Text(
                    text = stringResource(R.string.account_plan, plan),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/**
 * What the plan has left, as two bars.
 *
 * These were two lines of prose ("Transcription: 24 min of 600 min"), which is
 * the one presentation that makes a quota hard to read: nobody divides in their
 * head, so "am I about to run out" took arithmetic. A bar answers it at a glance,
 * and turns red once the relay would start refusing — the same threshold, not a
 * softer warning shade, because past it transcription stops.
 */
@Composable
private fun UsageSection(quota: HostedQuota) {
    SectionHeader(R.string.account_usage_title)

    QuotaBar(
        label = stringResource(R.string.account_usage_transcription),
        used = (quota.sttSecondsUsed ?: 0.0) / SECONDS_PER_HOUR,
        limit = quota.sttSecondsLimit?.let { it / SECONDS_PER_HOUR },
        unit = stringResource(R.string.account_usage_unit_hours),
    )
    QuotaBar(
        label = stringResource(R.string.account_usage_credits),
        used = quota.llmCreditsUsed ?: 0.0,
        limit = quota.llmCreditsLimit,
        unit = stringResource(R.string.account_usage_unit_credits),
    )

    quota.periodResetTs?.let { reset ->
        Text(
            text = stringResource(R.string.account_period_reset, formatDate(reset)),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/**
 * One metered resource. An unmetered plan gets the number without a bar — a
 * track that can never fill would be a progress indicator for a thing that has
 * no progress.
 */
@Composable
private fun QuotaBar(label: String, used: Double, limit: Double?, unit: String) {
    val bounded = limit?.takeIf { it > 0.0 }
    val over = bounded != null && used >= bounded

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            Text(
                text = label,
                style = ParleyTextStyles.bodyEmphasized,
                modifier = Modifier.weight(1f),
            )
            Text(
                text = if (bounded != null) {
                    stringResource(
                        R.string.account_usage_amount,
                        formatQuotaAmount(used),
                        formatQuotaLimit(bounded),
                        unit,
                    )
                } else {
                    stringResource(
                        R.string.account_usage_amount_unlimited,
                        formatQuotaAmount(used),
                        unit,
                    )
                },
                style = MaterialTheme.typography.bodySmall,
                color = if (over) {
                    MaterialTheme.colorScheme.error
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
            )
        }
        if (bounded != null) {
            LinearProgressIndicator(
                progress = { (used / bounded).toFloat().coerceIn(0f, 1f) },
                modifier = Modifier.fillMaxWidth(),
                color = if (over) {
                    MaterialTheme.colorScheme.error
                } else {
                    MaterialTheme.colorScheme.primary
                },
                trackColor = MaterialTheme.colorScheme.surfaceVariant,
            )
        }
    }
}

/**
 * How many finished recordings are still on the phone, and a way to push them.
 *
 * The library screen already shows this as a header above the queued rows, but
 * that header only exists while the queue is non-empty — so the one question this
 * answers, "is everything safely uploaded?", had no place that could say yes.
 * Reads on-device state only, which is why it keeps working offline.
 */
@Composable
private fun SyncSection(pending: Int, uploading: Boolean, onRetry: () -> Unit) {
    SectionHeader(R.string.account_sync_title)

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = if (pending > 0) {
                pluralStringResource(R.plurals.account_sync_pending, pending, pending)
            } else {
                stringResource(R.string.account_sync_done)
            },
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f),
        )
        if (pending > 0) {
            if (uploading) {
                CircularProgressIndicator(Modifier.size(20.dp))
            } else {
                TextButton(onClick = onRetry) {
                    Text(stringResource(R.string.account_sync_retry))
                }
            }
        }
    }

    Text(
        text = stringResource(R.string.account_sync_detail),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/**
 * Which language the app is speaking, and the one place that can change it.
 *
 * Android owns per-app language from 13 on (the manifest's `localeConfig` is what
 * makes Parley appear in that list), and a second switch in here could only take
 * effect on the next launch anyway. So this names the current language and opens
 * the place that actually changes it — the same call iOS `SettingsView` makes.
 */
@Composable
private fun LanguageSection() {
    val context = LocalContext.current
    val locale = LocalConfiguration.current.locales[0]

    SectionHeader(R.string.account_language)

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            // The language named in itself — 中文, not "Chinese" — because the
            // person reading it is reading it in that language.
            text = locale.getDisplayName(locale).replaceFirstChar { it.titlecase(locale) },
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f),
        )
        TextButton(onClick = { openLanguageSettings(context) }) {
            Text(stringResource(R.string.account_language_change))
        }
    }

    Text(
        text = stringResource(R.string.account_language_detail),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/**
 * Android 13+ has a per-app language screen; everything older only has the app's
 * own details page, which is at least where the system language lives two taps
 * away. Either can be missing on an odd OEM build, hence the fallthrough.
 */
private fun openLanguageSettings(context: Context) {
    val target = Uri.fromParts("package", context.packageName, null)
    val candidates = buildList {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            add(Intent(Settings.ACTION_APP_LOCALE_SETTINGS, target))
        }
        add(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, target))
    }
    for (intent in candidates) {
        // A non-Activity context cannot start an activity in the caller's task.
        if (context !is Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
            return
        } catch (_: ActivityNotFoundException) {
            // Try the next one.
        }
    }
}

/**
 * Version, and the three addresses the app is obliged to be reachable at.
 *
 * The privacy policy is the reason this section exists at all: Play rejects an
 * app that does not link to one from inside itself, and Android had no link
 * anywhere. The version number is the other half — a bug report that cannot name
 * a build is a bug report nobody can act on. Build number alongside the name
 * because that is what identifies an artifact on Play.
 */
@Composable
private fun AboutSection() {
    val context = LocalContext.current

    SectionHeader(R.string.account_about_title)

    Text(
        text = stringResource(
            R.string.account_version,
            BuildConfig.VERSION_NAME,
            BuildConfig.VERSION_CODE,
        ),
        style = MaterialTheme.typography.bodyMedium,
    )

    LinkButton(R.string.link_desktop) { CustomTabsLauncher.launch(context, ParleyLinks.WEBSITE) }
    LinkButton(R.string.link_privacy_policy) {
        CustomTabsLauncher.launch(context, ParleyLinks.PRIVACY)
    }
    LinkButton(R.string.link_support) { CustomTabsLauncher.launch(context, ParleyLinks.SUPPORT) }

    Text(
        text = stringResource(R.string.account_about_detail),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun LinkButton(@StringRes label: Int, onClick: () -> Unit) {
    TextButton(onClick = onClick, contentPadding = ZERO_START_PADDING) {
        Text(stringResource(label))
    }
}

/**
 * A rule and a title. Every section in this sheet is separated the same way, so
 * that a sheet this long reads as a list of topics rather than one long column.
 */
@Composable
private fun SectionHeader(@StringRes title: Int) {
    HorizontalDivider(Modifier.padding(vertical = 8.dp))
    Text(
        text = stringResource(title),
        style = MaterialTheme.typography.titleSmall,
    )
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

/** `24.3`, matching the one decimal iOS shows for the same number. */
private fun formatQuotaAmount(value: Double): String =
    String.format(Locale.getDefault(), "%.1f", value.coerceAtLeast(0.0))

/** Limits are whole numbers on every plan we sell, so they lose the decimal. */
private fun formatQuotaLimit(value: Double): String =
    String.format(Locale.getDefault(), "%.0f", value)

private const val SECONDS_PER_HOUR = 3600.0

/**
 * Links read as a list, not as a row of buttons, so they start at the same
 * left edge as the text above them rather than at a button's inset.
 */
private val ZERO_START_PADDING = PaddingValues(start = 0.dp, top = 8.dp, end = 8.dp, bottom = 8.dp)
