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
