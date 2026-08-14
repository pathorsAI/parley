package com.pathors.parley.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.pathors.parley.AppContainer
import com.pathors.parley.cloud.CloudException
import com.pathors.parley.cloud.CloudUser
import com.pathors.parley.cloud.HostedQuota
import com.pathors.parley.cloud.RecordingSummary
import com.pathors.parley.upload.PendingUpload
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** What went wrong loading the library. The screen owns the copy for each case. */
enum class HomeError { NETWORK, SERVER, SIGNED_OUT }

/**
 * Why account deletion did not happen. The sheet owns the copy for each case.
 *
 * [OWNS_ORGANIZATIONS] is deliberately its own case: it is the only one the user
 * can do something about, and telling them to "try again" would be a lie.
 */
enum class DeleteAccountError { OWNS_ORGANIZATIONS, FAILED }

/**
 * The library screen's state: what the cloud has, what is still waiting to get
 * there, and the account details behind the avatar button.
 *
 * The pending queue is read from disk rather than mirrored in memory, because the
 * uploader mutates it from its own coroutines — the file system is the single
 * source of truth for "what has not reached the cloud yet".
 */
class HomeViewModel(private val container: AppContainer) : ViewModel() {

    data class UiState(
        val loading: Boolean = true,
        val recordings: List<RecordingSummary> = emptyList(),
        val pending: List<PendingUpload> = emptyList(),
        val uploading: Boolean = false,
        val error: HomeError? = null,
    )

    data class AccountState(
        val loading: Boolean = false,
        val user: CloudUser? = null,
        val quota: HostedQuota? = null,
        val failed: Boolean = false,
        /** True while `DELETE /me` is in flight — the destructive action is disabled. */
        val deleting: Boolean = false,
        val deleteError: DeleteAccountError? = null,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private val _account = MutableStateFlow(AccountState())
    val account: StateFlow<AccountState> = _account.asStateFlow()

    fun refresh() {
        viewModelScope.launch {
            _state.value = _state.value.copy(loading = true)
            val pending = withContext(Dispatchers.IO) { container.uploadQueue.list() }
            val result = runCatching { container.cloud.listRecordings() }
            _state.value = result.fold(
                onSuccess = { recordings ->
                    _state.value.copy(
                        loading = false,
                        recordings = recordings,
                        pending = pending,
                        error = null,
                    )
                },
                onFailure = { error ->
                    _state.value.copy(
                        loading = false,
                        pending = pending,
                        error = classify(error),
                    )
                },
            )
        }
    }

    /** "Upload now" on the pending banner — a manual drain, then a reload. */
    fun uploadNow() {
        if (_state.value.uploading) return
        viewModelScope.launch {
            _state.value = _state.value.copy(uploading = true)
            runCatching { container.uploader.drain() }
            _state.value = _state.value.copy(uploading = false)
            refresh()
        }
    }

    fun loadAccount() {
        if (_account.value.loading) return
        viewModelScope.launch {
            _account.value = AccountState(loading = true)
            val user = runCatching { container.cloud.me() }
            val quota = runCatching { container.cloud.usage() }
            _account.value = AccountState(
                loading = false,
                user = user.getOrNull(),
                quota = quota.getOrNull(),
                failed = user.isFailure && quota.isFailure,
            )
        }
    }

    fun signOut() {
        viewModelScope.launch { container.auth.signOut() }
    }

    /**
     * Permanently delete this account (`DELETE /me`) — the Play Store's required
     * in-app deletion route, and the same call iOS Settings makes.
     *
     * On success the server has already destroyed the session, so this clears the
     * token locally rather than signing out (there is nothing left to revoke) and
     * wipes the pending-upload queue: those recordings have no account to land in
     * any more, and the confirmation dialog promised the audio would be gone.
     * Clearing the token is also what returns the app to the sign-in wall —
     * `ParleyRoot` watches `isSignedIn`.
     *
     * The queue is emptied BEFORE the token, so the sign-in screen can never
     * appear over a still-populated queue that a re-sign-in would then upload
     * into a brand-new account.
     */
    fun deleteAccount() {
        if (_account.value.deleting) return
        viewModelScope.launch {
            _account.value = _account.value.copy(deleting = true, deleteError = null)
            val result = runCatching { container.cloud.deleteAccount() }
            result.fold(
                onSuccess = {
                    withContext(Dispatchers.IO) { container.uploadQueue.clear() }
                    container.auth.clearSession()
                },
                onFailure = { error ->
                    _account.value = _account.value.copy(
                        deleting = false,
                        deleteError = classifyDeletion(error),
                    )
                },
            )
        }
    }

    /** Dismiss the deletion error so re-opening the dialog starts clean. */
    fun clearDeleteAccountError() {
        if (_account.value.deleteError != null) {
            _account.value = _account.value.copy(deleteError = null)
        }
    }

    private fun classifyDeletion(error: Throwable): DeleteAccountError =
        if ((error as? CloudException)?.ownsOrganizations == true) {
            DeleteAccountError.OWNS_ORGANIZATIONS
        } else {
            DeleteAccountError.FAILED
        }

    private fun classify(error: Throwable): HomeError = when {
        (error as? CloudException)?.isAuthExpired == true -> HomeError.SIGNED_OUT
        error is CloudException && error.status > 0 -> HomeError.SERVER
        else -> HomeError.NETWORK
    }

    companion object {
        fun factory(container: AppContainer) = viewModelFactory {
            initializer { HomeViewModel(container) }
        }
    }
}
