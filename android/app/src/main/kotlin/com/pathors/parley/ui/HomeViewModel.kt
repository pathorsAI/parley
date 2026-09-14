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
import com.pathors.parley.kit.TranscriptSearch
import com.pathors.parley.screenshot.DemoMode
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
 * Why one recording did not get deleted. The screen owns the copy for each case.
 *
 * [FORBIDDEN] is its own case for the same reason [DeleteAccountError] splits
 * out organization ownership: a 403 means this account is not allowed to delete
 * that row — it belongs to an organization, or it was shared in — and "try
 * again" would send the user round a loop that can never close.
 */
enum class DeleteRecordingError { FORBIDDEN, FAILED }

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
        /**
         * Recording ids with a `DELETE` in flight. A set rather than a single
         * id: the rows are independent, and one slow delete must not lock the
         * rest of the library.
         */
        val deleting: Set<String> = emptySet(),
        val deleteError: DeleteRecordingError? = null,
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
        if (DemoMode.isActive) {
            // Fixtures, not the cloud — and deliberately not the pending queue
            // either: demo mode never reads or writes a real user's disk state.
            _state.value = UiState(loading = false, recordings = DemoMode.recordings())
            return
        }
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

    /**
     * Delete one recording from the cloud (`DELETE /recordings/{id}`).
     *
     * The call has existed since the sync work landed and had no caller at all,
     * which left the library append-only: a mis-tapped recording, a test, a
     * meeting recorded in the wrong room — all permanent. That is also a
     * user-data-control inconsistency Play cares about, since deleting the whole
     * *account* was already possible and deleting one row was not.
     *
     * The row is dropped locally on success instead of triggering a refresh: the
     * list is already correct, and a reload would blank the screen and re-fetch
     * everything to learn one thing we know. A 404 counts as success — the row is
     * gone, which is what was asked for, and showing an error for it would leave
     * a ghost in the list that no amount of retrying can remove.
     */
    fun deleteRecording(id: String) {
        // Demo mode renders fixtures; there is nothing in the cloud to delete and
        // a screenshot run must never write against a real account.
        if (DemoMode.isActive) return
        if (id in _state.value.deleting) return
        viewModelScope.launch {
            _state.value = _state.value.copy(
                deleting = _state.value.deleting + id,
                deleteError = null,
            )
            val result = runCatching { container.cloud.deleteRecording(id) }
            val failure = result.exceptionOrNull()
            val gone = failure == null || (failure as? CloudException)?.isNotFound == true
            _state.value = if (gone) {
                _state.value.copy(
                    recordings = _state.value.recordings.filterNot { it.id == id },
                    deleting = _state.value.deleting - id,
                )
            } else {
                _state.value.copy(
                    deleting = _state.value.deleting - id,
                    deleteError = classifyRecordingDeletion(failure),
                )
            }
        }
    }

    /** Dismiss the deletion error so the next attempt starts clean. */
    fun clearDeleteRecordingError() {
        if (_state.value.deleteError != null) {
            _state.value = _state.value.copy(deleteError = null)
        }
    }

    private fun classifyRecordingDeletion(error: Throwable?): DeleteRecordingError =
        if ((error as? CloudException)?.isForbidden == true) {
            DeleteRecordingError.FORBIDDEN
        } else {
            DeleteRecordingError.FAILED
        }

    fun loadAccount() {
        if (DemoMode.isActive) {
            _account.value = AccountState(user = DemoMode.user(), quota = DemoMode.quota())
            return
        }
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
        // In demo mode "sign out" is how you leave demo mode: there is no session
        // to revoke, and the real sign-out must never run against a live account.
        if (DemoMode.isActive) {
            DemoMode.disable()
            return
        }
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

        /**
         * The library narrowed to a query: titles and snippets, nothing else.
         *
         * Pure, in-memory and re-run on every keystroke, because the whole
         * library is already here — `GET /recordings` returns the account's
         * rows in one response, so asking the server to filter them would be a
         * round trip to learn something this process already knows. It also
         * means the field keeps working with no network, which is the state the
         * error banner above the list exists for.
         *
         * Title *and* snippet, the same pair iOS searches (`LibraryView.swift`
         * `filtered`): a meeting is as often remembered by something that was
         * said in it as by what it ended up being called, and the snippet is the
         * only part of what was said that the list has.
         *
         * Matching is [TranscriptSearch.matches] rather than a lowercased
         * `contains`, so "cafe" finds "Café" and the library agrees with the
         * search inside a transcript about what a query means.
         */
        internal fun filterRecordings(
            recordings: List<RecordingSummary>,
            query: String,
        ): List<RecordingSummary> {
            if (query.isBlank()) return recordings
            return recordings.filter { recording ->
                TranscriptSearch.matches(recording.title, query) ||
                    TranscriptSearch.matches(recording.snippet.orEmpty(), query)
            }
        }

        fun factory(container: AppContainer) = viewModelFactory {
            initializer { HomeViewModel(container) }
        }
    }
}
