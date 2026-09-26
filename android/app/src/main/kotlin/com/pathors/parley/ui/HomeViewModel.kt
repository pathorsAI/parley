package com.pathors.parley.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.pathors.parley.AppContainer
import com.pathors.parley.cloud.CloudClient
import com.pathors.parley.cloud.CloudException
import com.pathors.parley.cloud.CloudFolder
import com.pathors.parley.cloud.CloudOrg
import com.pathors.parley.cloud.CloudUser
import com.pathors.parley.cloud.HostedQuota
import com.pathors.parley.cloud.RecordingSummary
import com.pathors.parley.kit.TranscriptSearch
import com.pathors.parley.library.FolderFilter
import com.pathors.parley.library.LibraryFolders
import com.pathors.parley.library.SaveDestination
import com.pathors.parley.screenshot.DemoMode
import com.pathors.parley.upload.PendingUpload
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * What went wrong loading the library. The screen owns the copy for each case.
 *
 * [FORBIDDEN] only happens in an organization's library: signed in, but no
 * longer allowed to read it — removed from the team since the scope was picked.
 */
enum class HomeError { NETWORK, SERVER, SIGNED_OUT, FORBIDDEN }

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
enum class DeleteRecordingError {
    FORBIDDEN,

    /**
     * A 403 from an organization's library, which means something narrower:
     * the server lets the uploader and the org's owners and admins delete a
     * shared recording, and this account is none of those.
     */
    FORBIDDEN_IN_ORG,
    FAILED,
}

/**
 * Why a library action other than delete did not happen. The screen owns the
 * copy; the organization's name travels with the cases that say it, because
 * "you can't share to that team" without naming the team is a riddle.
 */
sealed interface LibraryActionError {
    /** A folder move that did not land. The row is still where it was. */
    data object MoveFailed : LibraryActionError

    /** A 403 moving an org recording between the org's folders. */
    data class MoveForbidden(val orgName: String) : LibraryActionError

    /** A 403 sharing into an organization. */
    data class ShareForbidden(val orgName: String) : LibraryActionError

    /** Sharing did not happen; nothing changed. */
    data object ShareFailed : LibraryActionError

    /**
     * "Move to organization" got half-way: the copy is in the org, and the
     * personal original could not be deleted. Nothing is lost — there are two
     * copies — and saying "move failed" would send someone to do it again and
     * make a third.
     */
    data class OriginalKept(val orgName: String) : LibraryActionError
}

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
        /** Which library is showing: null is personal, anything else an org id. */
        val scopeOrgId: String? = null,
        /** The organizations this account belongs to, each with its role. */
        val orgs: List<CloudOrg> = emptyList(),
        /** The folders of the scope that is showing, in the server's order. */
        val folders: List<CloudFolder> = emptyList(),
        val folderFilter: FolderFilter = FolderFilter.All,
        /** Recording ids with a move or a share in flight — see [deleting]. */
        val busy: Set<String> = emptySet(),
        val actionError: LibraryActionError? = null,
    ) {
        val isPersonal: Boolean get() = scopeOrgId == null

        /** The organization whose library is showing, when one is. */
        val scopeOrg: CloudOrg? get() = orgs.firstOrNull { it.id == scopeOrgId }
    }

    /**
     * Every place a recording can be saved to, for the account sheet's "Default
     * save location" picker: the personal folders, and each organization's.
     */
    data class SaveTargets(
        val personalFolders: List<CloudFolder> = emptyList(),
        val orgFolders: Map<String, List<CloudFolder>> = emptyMap(),
    )

    data class AccountState(
        val loading: Boolean = false,
        val user: CloudUser? = null,
        val quota: HostedQuota? = null,
        val failed: Boolean = false,
        /** True while `DELETE /me` is in flight — the destructive action is disabled. */
        val deleting: Boolean = false,
        val deleteError: DeleteAccountError? = null,
        val saveTargets: SaveTargets = SaveTargets(),
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private val _account = MutableStateFlow(AccountState())
    val account: StateFlow<AccountState> = _account.asStateFlow()

    /**
     * Demo mode's save location. In memory, like everything else demo mode
     * touches: a screenshot run that wrote the real setting would leave a
     * reviewer's next real recording going somewhere they never chose.
     */
    private val demoDestination = MutableStateFlow(DemoMode.saveDestination())

    /** The "Default save location" setting, as the account sheet shows it. */
    val saveDestination: StateFlow<SaveDestination> = combine(
        DemoMode.enabled,
        container.saveLocation.destination,
        demoDestination,
    ) { demo, stored, inDemo -> if (demo) inDemo else stored }
        .stateIn(viewModelScope, SharingStarted.Eagerly, SaveDestination.PERSONAL_ROOT)

    /** The load in flight, so a scope switch can abandon the one it replaces. */
    private var loadJob: Job? = null

    /**
     * Demo mode's library, per scope, seeded from the fixtures on first read
     * and then edited in place by moves and shares — so a screenshot run can
     * show a recording landing in a folder without a cloud to put it in.
     */
    private val demoLibrary = mutableMapOf<String?, List<RecordingSummary>>()
    private val demoFolders = mutableMapOf<String?, List<CloudFolder>>()

    /**
     * Load the scope that is selected: the organizations first (so a scope the
     * account has been removed from falls back to personal), then that scope's
     * recordings and folders side by side.
     *
     * A folder list that fails to load does not fail the library — the
     * recordings are the point, and they render fine without chips; the last
     * good list for the same scope is kept instead.
     */
    fun refresh() {
        loadJob?.cancel()
        if (DemoMode.isActive) {
            // Fixtures, not the cloud — and deliberately not the pending queue
            // either: demo mode never reads or writes a real user's disk state.
            val orgs = DemoMode.orgs()
            val scope = LibraryFolders.resolveScope(_state.value.scopeOrgId, orgs)
            val folders = demoFoldersFor(scope)
            _state.update {
                it.copy(
                    loading = false,
                    recordings = demoRecordingsFor(scope),
                    pending = emptyList(),
                    error = null,
                    scopeOrgId = scope,
                    orgs = orgs,
                    folders = folders,
                    folderFilter = LibraryFolders.reconcile(it.folderFilter, folders),
                )
            }
            return
        }
        loadJob = viewModelScope.launch {
            _state.update { it.copy(loading = true) }
            val pending = withContext(Dispatchers.IO) { container.uploadQueue.list() }
            val orgs = runCatchingCancellable { container.cloud.myOrgs() }.getOrNull()
            val scope = LibraryFolders.resolveScope(_state.value.scopeOrgId, orgs)
            val previous = _state.value
            val keptFolders = if (previous.scopeOrgId == scope) previous.folders else emptyList()
            val result = runCatchingCancellable {
                coroutineScope {
                    val recordings = async { recordingsFor(scope) }
                    val folders = async { runCatchingCancellable { foldersFor(scope) }.getOrNull() }
                    recordings.await() to folders.await()
                }
            }
            _state.update { current ->
                val base = current.copy(
                    loading = false,
                    pending = pending,
                    orgs = orgs ?: current.orgs,
                    scopeOrgId = scope,
                )
                result.fold(
                    onSuccess = { (recordings, folders) ->
                        val live = folders ?: keptFolders
                        base.copy(
                            recordings = recordings,
                            folders = live,
                            folderFilter = LibraryFolders.reconcile(current.folderFilter, live),
                            error = null,
                        )
                    },
                    onFailure = { error ->
                        base.copy(
                            // A scope that failed to load must not keep showing
                            // the rows of the scope it replaced.
                            recordings = if (previous.scopeOrgId == scope) {
                                current.recordings
                            } else {
                                emptyList()
                            },
                            folders = keptFolders,
                            error = classify(error, orgScope = scope != null),
                        )
                    },
                )
            }
        }
    }

    private suspend fun recordingsFor(scope: String?): List<RecordingSummary> =
        if (scope == null) container.cloud.listRecordings() else container.cloud.orgRecordings(scope)

    private suspend fun foldersFor(scope: String?): List<CloudFolder> =
        if (scope == null) {
            LibraryFolders.personalFolders(container.cloud.listFolders())
        } else {
            container.cloud.orgFolders(scope)
        }

    private fun demoRecordingsFor(scope: String?): List<RecordingSummary> =
        demoLibrary.getOrPut(scope) {
            if (scope == null) DemoMode.recordings() else DemoMode.orgRecordings(scope)
        }

    private fun demoFoldersFor(scope: String?): List<CloudFolder> =
        demoFolders.getOrPut(scope) {
            if (scope == null) DemoMode.folders() else DemoMode.orgFolders(scope)
        }

    /**
     * Switch between the personal library and an organization's. The rows of
     * the old scope go at once rather than lingering under the new name while
     * the new ones load, and the folder page goes back to All — folders belong
     * to a scope, so the selected one means nothing in the next.
     */
    fun selectScope(orgId: String?) {
        if (orgId == _state.value.scopeOrgId) return
        _state.update {
            it.copy(
                scopeOrgId = orgId,
                recordings = emptyList(),
                folders = emptyList(),
                folderFilter = FolderFilter.All,
                error = null,
                loading = true,
            )
        }
        refresh()
    }

    fun selectFolder(filter: FolderFilter) {
        _state.update { it.copy(folderFilter = filter) }
    }

    // ── moving and sharing ───────────────────────────────────────────────────

    /**
     * File [recording] under [folderId] (null = the scope's root).
     *
     * Personal: a re-push of the entry with the new folder
     * ([com.pathors.parley.cloud.CloudClient.refileRecording]). Organization: the
     * dedicated `PATCH …/folder`. Either way the row is updated in place on
     * success rather than by a reload, the same reasoning as [deleteRecording].
     */
    fun moveToFolder(recording: RecordingSummary, folderId: String?) {
        val state = _state.value
        if (recording.id in state.busy) return
        if (LibraryFolders.liveFolderId(recording.folderId, state.folders) == folderId) return
        val scope = state.scopeOrgId
        if (DemoMode.isActive) {
            demoLibrary[scope] = demoRecordingsFor(scope).map {
                if (it.id == recording.id) it.copy(folderId = folderId) else it
            }
            refresh()
            return
        }
        viewModelScope.launch { move(recording, folderId, scope) }
    }

    private suspend fun move(recording: RecordingSummary, folderId: String?, scope: String?) {
        markBusy(recording.id, true)
        val result = runCatchingCancellable {
            if (scope == null) {
                container.cloud.refileRecording(recording.id, folderId, recording)
            } else {
                container.cloud.moveOrgRecordingToFolder(scope, recording.id, folderId)
            }
        }
        _state.update { current ->
            val done = current.copy(busy = current.busy - recording.id)
            when {
                // The scope changed while the request was out: the row is not
                // on screen any more, and the next load will show it right.
                current.scopeOrgId != scope -> done
                result.isSuccess -> done.copy(
                    recordings = current.recordings.map {
                        if (it.id == recording.id) it.copy(folderId = folderId) else it
                    },
                )
                else -> done.copy(
                    actionError = if (scope != null && result.isForbidden()) {
                        LibraryActionError.MoveForbidden(current.scopeOrg?.name.orEmpty())
                    } else {
                        LibraryActionError.MoveFailed
                    },
                )
            }
        }
    }

    /**
     * "New folder…" in the picker: create the folder in the personal library,
     * then move [recording] into it.
     *
     * Throws when the folder could not be created, so the picker can keep the
     * name on screen with the error under it — the one failure the person can
     * fix right there. A move that fails after a successful create lands in
     * [UiState.actionError] like any other move, and the folder stays: it was
     * made, and it is exactly the folder they will want for the retry.
     */
    suspend fun createFolderAndMove(recording: RecordingSummary, name: String) {
        check(_state.value.isPersonal) { "folders are only created in the personal library" }
        val folder = if (DemoMode.isActive) {
            CloudFolder(id = CloudClient.newCloudId(), name = name)
                .also { demoFolders[null] = demoFoldersFor(null) + it }
        } else {
            container.cloud.createFolder(name)
        }
        _state.update { current ->
            if (current.isPersonal) current.copy(folders = current.folders + folder) else current
        }
        moveToFolder(recording, folder.id)
    }

    /**
     * Share a personal recording into [org] as a server-side copy, and — for
     * "Move to organization" — delete the personal original afterwards.
     *
     * Copy first, delete only once the copy exists: a failure half-way must
     * leave the original where it was (desktop `moveRecordingToOrg`, iOS
     * `shareToOrg`). The copy lands at the org's root; filing it there is the
     * org library's business.
     */
    fun shareToOrg(recording: RecordingSummary, org: CloudOrg, thenDelete: Boolean) {
        val state = _state.value
        if (!state.isPersonal || recording.id in state.busy) return
        if (DemoMode.isActive) {
            if (thenDelete) {
                demoLibrary[null] = demoRecordingsFor(null).filterNot { it.id == recording.id }
                demoLibrary[org.id] = listOf(recording.copy(folderId = null)) +
                    demoRecordingsFor(org.id)
                refresh()
            }
            return
        }
        viewModelScope.launch {
            markBusy(recording.id, true)
            val shared = runCatchingCancellable {
                container.cloud.shareRecording(recording.id, org.id)
            }
            if (shared.isFailure) {
                _state.update {
                    it.copy(
                        busy = it.busy - recording.id,
                        actionError = if (shared.isForbidden()) {
                            LibraryActionError.ShareForbidden(org.name)
                        } else {
                            LibraryActionError.ShareFailed
                        },
                    )
                }
                return@launch
            }
            if (!thenDelete) {
                markBusy(recording.id, false)
                return@launch
            }
            val deleted = runCatchingCancellable { container.cloud.deleteRecording(recording.id) }
            val gone = deleted.isSuccess ||
                (deleted.exceptionOrNull() as? CloudException)?.isNotFound == true
            if (gone) forgetLocally(recording.id)
            _state.update { current ->
                current.copy(
                    busy = current.busy - recording.id,
                    recordings = if (gone && current.isPersonal) {
                        current.recordings.filterNot { it.id == recording.id }
                    } else {
                        current.recordings
                    },
                    actionError = if (gone) null else LibraryActionError.OriginalKept(org.name),
                )
            }
        }
    }

    /** Dismiss the move/share error. */
    fun clearActionError() {
        if (_state.value.actionError != null) _state.update { it.copy(actionError = null) }
    }

    private fun markBusy(id: String, busy: Boolean) {
        _state.update { it.copy(busy = if (busy) it.busy + id else it.busy - id) }
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
        val scope = _state.value.scopeOrgId
        viewModelScope.launch {
            _state.update { it.copy(deleting = it.deleting + id, deleteError = null) }
            val result = runCatchingCancellable {
                if (scope == null) {
                    container.cloud.deleteRecording(id)
                } else {
                    container.cloud.deleteOrgRecording(scope, id)
                }
            }
            val failure = result.exceptionOrNull()
            val gone = failure == null || (failure as? CloudException)?.isNotFound == true
            // Only a personal recording has anything on this phone: an org
            // row is the server's copy, under an id of its own.
            if (gone && scope == null) forgetLocally(id)
            _state.update { current ->
                if (gone) {
                    current.copy(
                        recordings = if (current.scopeOrgId == scope) {
                            current.recordings.filterNot { it.id == id }
                        } else {
                            current.recordings
                        },
                        deleting = current.deleting - id,
                    )
                } else {
                    current.copy(
                        deleting = current.deleting - id,
                        deleteError = classifyRecordingDeletion(failure, orgScope = scope != null),
                    )
                }
            }
        }
    }

    /**
     * Everything this phone still holds for a recording that no longer exists:
     * the audio it kept for playback, a queued re-transcription of it, and the
     * retry ledger that would otherwise keep charging a deleted recording's
     * budget.
     */
    private suspend fun forgetLocally(id: String) = withContext(Dispatchers.IO) {
        container.localAudio.remove(id)
        container.backfiller.forget(id)
    }

    /** Dismiss the deletion error so the next attempt starts clean. */
    fun clearDeleteRecordingError() {
        if (_state.value.deleteError != null) {
            _state.value = _state.value.copy(deleteError = null)
        }
    }

    private fun classifyRecordingDeletion(error: Throwable?, orgScope: Boolean): DeleteRecordingError =
        when {
            (error as? CloudException)?.isForbidden != true -> DeleteRecordingError.FAILED
            orgScope -> DeleteRecordingError.FORBIDDEN_IN_ORG
            else -> DeleteRecordingError.FORBIDDEN
        }

    fun loadAccount() {
        if (DemoMode.isActive) {
            val orgs = DemoMode.orgs()
            _account.value = AccountState(
                user = DemoMode.user(),
                quota = DemoMode.quota(),
                saveTargets = SaveTargets(
                    personalFolders = DemoMode.folders(),
                    orgFolders = orgs.associate { it.id to DemoMode.orgFolders(it.id) },
                ),
            )
            if (_state.value.orgs.isEmpty()) _state.update { it.copy(orgs = orgs) }
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
                saveTargets = _account.value.saveTargets,
            )
            loadSaveTargets()
        }
    }

    /**
     * The folders the "Default save location" picker offers, every scope's.
     * Best-effort throughout: a picker missing one org's folders still offers
     * the org itself, which is the choice that matters most.
     */
    private suspend fun loadSaveTargets() {
        val orgs = runCatchingCancellable { container.cloud.myOrgs() }.getOrNull()
        if (orgs != null) _state.update { it.copy(orgs = orgs) }
        val known = orgs ?: _state.value.orgs
        val targets = coroutineScope {
            val personal = async {
                runCatchingCancellable {
                    LibraryFolders.personalFolders(container.cloud.listFolders())
                }.getOrDefault(emptyList())
            }
            val perOrg = known.map { org ->
                async {
                    org.id to runCatchingCancellable { container.cloud.orgFolders(org.id) }
                        .getOrDefault(emptyList())
                }
            }
            SaveTargets(personalFolders = personal.await(), orgFolders = perOrg.awaitAll().toMap())
        }
        _account.update { it.copy(saveTargets = targets) }
    }

    /** "Default save location" in the account sheet. */
    fun setSaveDestination(destination: SaveDestination) {
        if (DemoMode.isActive) {
            demoDestination.value = destination
            return
        }
        viewModelScope.launch { container.saveLocation.set(destination) }
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
                    // Every queue that holds audio, not just the upload one:
                    // the backfill queue keeps the same kind of file, and the
                    // confirmation dialog promises all of it is discarded.
                    withContext(Dispatchers.IO) { container.discardLocalRecordings() }
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

    private fun classify(error: Throwable, orgScope: Boolean): HomeError = when {
        (error as? CloudException)?.isAuthExpired == true -> HomeError.SIGNED_OUT
        orgScope && (error as? CloudException)?.isForbidden == true -> HomeError.FORBIDDEN
        error is CloudException && error.status > 0 -> HomeError.SERVER
        else -> HomeError.NETWORK
    }

    companion object {

        /**
         * What the list shows: the selected folder page of the scope, then the
         * search, which is one query across the whole scope — a search on "All"
         * and the same search two chips over are the same search, narrowed
         * (iOS `LibraryView.filtered` makes the same choice).
         */
        internal fun visibleRecordings(
            recordings: List<RecordingSummary>,
            folders: List<CloudFolder>,
            filter: FolderFilter,
            query: String,
        ): List<RecordingSummary> =
            filterRecordings(LibraryFolders.filter(recordings, folders, filter), query)

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

/**
 * [runCatching] that lets cancellation through. A scope switch cancels the load
 * it replaces, and a plain `runCatching` would turn that cancellation into an
 * error banner on the new scope.
 */
private inline fun <T> runCatchingCancellable(block: () -> T): Result<T> =
    try {
        Result.success(block())
    } catch (e: CancellationException) {
        throw e
    } catch (e: Throwable) {
        Result.failure(e)
    }

private fun Result<*>.isForbidden(): Boolean =
    (exceptionOrNull() as? CloudException)?.isForbidden == true
