package com.pathors.parley.filing

import com.pathors.parley.cloud.CloudClient
import com.pathors.parley.cloud.CloudFolder
import com.pathors.parley.kit.FilingFolder
import com.pathors.parley.kit.FilingFolderSuggestion
import com.pathors.parley.kit.FilingSuggester
import com.pathors.parley.kit.FilingSuggestion
import com.pathors.parley.kit.TranscriptSegment
import com.pathors.parley.library.LibraryFolders
import com.pathors.parley.library.SaveDestination
import com.pathors.parley.meeting.MeetingState
import com.pathors.parley.upload.MeetingUploader
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** Where the filing offer for the recording that just finished stands. */
enum class FilingPhase {
    /** Nothing has been considered yet. */
    IDLE,

    /** The pass is in flight; the meeting screen waits for it. */
    THINKING,

    /** The pass came back with something worth showing. */
    OFFERING,

    /** Nothing to offer: skipped, no answer, or answered. */
    SETTLED,
}

/**
 * Where the user asked the recording to live. A folder picked in the Adjust
 * sheet can be the personal root, which a [FilingFolderSuggestion] cannot say
 * (its null id means "a folder to create").
 */
sealed interface FolderTarget {
    data class Existing(val id: String) : FolderTarget

    /** Created on Save, and not a moment earlier. */
    data class New(val name: String) : FolderTarget

    /** The personal root — "Unfiled" in the picker. */
    data object Root : FolderTarget

    companion object {
        fun of(suggestion: FilingFolderSuggestion): FolderTarget =
            suggestion.folderId?.let(::Existing) ?: New(suggestion.name)
    }
}

/** Why the pass was not run for a finished recording. */
enum class FilingSkip {
    /** Dropped as a misfire, or still waiting for a network: nothing to write to yet. */
    NOT_UPLOADED,

    /**
     * Auto-shared to an organization. The copy the user will open is the org
     * one, which the phone can neither rename nor re-file.
     */
    ORG_DEFAULT,

    /** No final transcript: nothing for the pass to read. */
    NO_TRANSCRIPT,

    /**
     * The screenshot demo — Android's stand-in for iOS's bundled sample
     * recording. There is no account behind it and no network may be touched.
     */
    DEMO,
}

/**
 * Everything the meeting screen draws for the filing offer. The derived
 * properties are the iOS `FilingSuggestionModel`'s, rule for rule.
 */
data class FilingUiState(
    val phase: FilingPhase = FilingPhase.IDLE,
    val suggestion: FilingSuggestion? = null,
    /** What the recording is called in the cloud right now. */
    val currentTitle: String = "",
    /** The (live) folder the recording is in right now; null is the root. */
    val currentFolderId: String? = null,
    /**
     * The personal folders as the pass listed them, kept for the Adjust sheet
     * so it offers the list the suggestion was made against, without a second
     * round trip that could fail on its own.
     */
    val existingFolders: List<CloudFolder> = emptyList(),
    /** The user answered the name half — with the proposed name or their own. */
    val titleAnswered: Boolean = false,
    /** The user answered the home half, wherever it settled. */
    val folderAnswered: Boolean = false,
    /** A push is in flight. One at a time: every accept read-modify-writes the same meta. */
    val isWriting: Boolean = false,
    /** A push the user asked for did not land. Never raised for the pass itself. */
    val writeFailed: Boolean = false,
) {
    /**
     * The proposed name, or null when there is nothing left to propose: an
     * answered offer, an empty suggestion, or a recording already called that.
     */
    val proposedTitle: String?
        get() {
            if (titleAnswered) return null
            val proposed = suggestion?.title?.trim().orEmpty()
            return proposed.takeIf { it.isNotEmpty() && it != currentTitle.trim() }
        }

    /**
     * The folders still worth offering, or none once the user has said where
     * the recording lives. The chip pointing at the folder it is already in is
     * dropped; a proposed NEW folder (null id) is never compared away, because
     * null is also "the root" and an unfiled recording is exactly the case a
     * new folder gets proposed for.
     */
    val proposedFolders: List<FilingFolderSuggestion>
        get() {
            if (folderAnswered) return emptyList()
            val folders = suggestion?.folders.orEmpty()
            return folders.filter { it.folderId == null || it.folderId != currentFolderId }.take(MAX_FOLDERS)
        }

    /** The folder the one-tap accept files into: the model's best answer. */
    val proposedFolder: FilingFolderSuggestion? get() = proposedFolders.firstOrNull()

    val hasSomethingToOffer: Boolean get() = proposedTitle != null || proposedFolders.isNotEmpty()

    /**
     * Whether the meeting screen should stay up for this: while the pass is
     * thinking, and while there is an offer the user has not answered. Every
     * other state lets the screen go back to the library as it always did.
     */
    val holdsScreen: Boolean
        get() = phase == FilingPhase.THINKING || (phase == FilingPhase.OFFERING && hasSomethingToOffer)

    private companion object {
        const val MAX_FOLDERS = 3
    }
}

/**
 * The post-transcription filing suggestion for the recording that just
 * finished: what it should be CALLED, and where it should LIVE — the Android
 * half of iOS `FilingSuggestionModel`.
 *
 * It waits for the UPLOAD to settle, not for the microphone to stop: a rename
 * or a re-file is a write against a recording the server already holds.
 *
 * Every part of it is best-effort. A failed folder listing, a failed pass, a
 * failed push: each leaves the recording exactly as the upload left it, and
 * only a write the user explicitly asked for ever says so.
 *
 * ## An answered offer is retired, not compared away
 *
 * Each half records what the user did ([FilingUiState.titleAnswered],
 * [FilingUiState.folderAnswered]) instead of inferring it from what the
 * recording ended up being. Comparison cannot express "answered": a name the
 * user typed in the Adjust sheet is neither the model's nor the recording's old
 * one, and a proposed new folder has no id to compare. Both flags are set by
 * [apply] — the only accept path — and only once its push has returned: a
 * write that threw leaves the offer open, because it is still worth taking.
 *
 * Plain suspend functions over a [StateFlow], so the rules can be tested
 * against a mock server without a ViewModel; `FilingSuggestionViewModel` owns
 * the coroutines.
 */
class FilingSuggestionModel(
    private val cloud: CloudClient,
    /** The label a segment's speaker is shown under, so the model reads what the user reads. */
    private val speakerLabel: (TranscriptSegment) -> String,
) {
    private val _state = MutableStateFlow(FilingUiState())
    val state: StateFlow<FilingUiState> = _state.asStateFlow()

    /** The recording the visible offer belongs to; null once forgotten (and in the demo). */
    private var recordingId: String? = null

    /**
     * The recording the pass has already been spent on. Not cleared by
     * [forget]: a dismissed offer must stay dismissed however often the screen
     * recomposes.
     */
    private var consideredId: String? = null

    /**
     * Claim the pass for a finished recording. Returns false when it has
     * already been claimed for this recording, or [skip] says there is nothing
     * to do — in which case the phase settles at once and the screen behaves as
     * it always did.
     */
    fun claim(recordingId: String, skip: FilingSkip?): Boolean {
        if (consideredId == recordingId) return false
        consideredId = recordingId
        if (skip != null) {
            _state.value = FilingUiState(phase = FilingPhase.SETTLED)
            return false
        }
        _state.value = FilingUiState(phase = FilingPhase.THINKING)
        return true
    }

    /**
     * Run the pass for a recording [claim] accepted. [spoken] is the meeting's
     * final transcript. Never throws: any failure is "no suggestion".
     */
    suspend fun run(recordingId: String, spoken: List<TranscriptSegment>) {
        val offered = try {
            suggest(recordingId, spoken)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            // Best-effort by design: the recording is already safely in the
            // cloud under its clock name, and a suggestion nobody asked for is
            // not worth an error on the meeting screen.
            null
        }
        if (offered == null) {
            _state.update { it.copy(phase = FilingPhase.SETTLED) }
            return
        }
        this.recordingId = recordingId
        _state.value = offered
    }

    private suspend fun suggest(recordingId: String, spoken: List<TranscriptSegment>): FilingUiState? {
        // The meta rather than what the screen remembers: it is what the
        // server holds — the title and folder the upload actually wrote — and
        // it says whether another device has already spent a pass on this.
        val meta = cloud.recordingMeta(recordingId)
        if (meta.filingSuggested) return null
        // Personal folders only: an org folder is not somewhere this recording
        // can be moved to from here.
        val folders = LibraryFolders.personalFolders(cloud.listFolders())
        val proposal = FilingSuggester.suggest(
            segments = spoken,
            speakerLabel = speakerLabel,
            currentTitle = meta.title,
            folders = folders.map { FilingFolder(id = it.id, name = it.name, orgId = it.orgId) },
            chat = cloud,
        ) ?: return null
        return FilingUiState(
            phase = FilingPhase.OFFERING,
            suggestion = proposal,
            currentTitle = meta.title,
            currentFolderId = LibraryFolders.liveFolderId(meta.folderId, folders),
            existingFolders = folders,
        )
    }

    // ── accepting ────────────────────────────────────────────────────────────

    /** Take the suggestion as offered: the proposed name and the best proposed folder. */
    suspend fun acceptSuggested(): Boolean {
        val current = _state.value
        return apply(current.proposedTitle, current.proposedFolder?.let(FolderTarget::of))
    }

    /**
     * Rename the recording and file it, either or both, in ONE read-modify-write
     * ([CloudClient.editRecording]) — a rename followed by a move would push a
     * copy read before the first landed. Null means "leave that one as it is";
     * a title the recording already has, or the folder it is already in, is
     * dropped the same way.
     *
     * A folder that does not exist yet is created HERE and nowhere earlier:
     * merely offering a candidate must not bring it into being.
     *
     * Every write carries `filingSuggested`, so the desktop does not ask again.
     *
     * @return whether a push landed. A Save that found nothing to change pushed
     *   nothing, and has to leave through [skip] to land the flag.
     */
    suspend fun apply(title: String?, folder: FolderTarget?): Boolean {
        val id = recordingId ?: return false
        val current = _state.value
        if (current.isWriting) return false
        val newTitle = title?.trim()?.takeIf { it.isNotEmpty() && it != current.currentTitle }
        val target = folder?.takeUnless { it.isWhere(current.currentFolderId) }
        if (newTitle == null && target == null) return false

        _state.update { it.copy(isWriting = true, writeFailed = false) }
        val landed = try {
            write(id, newTitle, target)
            true
        } catch (e: CancellationException) {
            _state.update { it.copy(isWriting = false) }
            throw e
        } catch (e: Throwable) {
            false
        }
        _state.update { it.copy(isWriting = false, writeFailed = !landed) }
        return landed
    }

    private suspend fun write(id: String, newTitle: String?, target: FolderTarget?) {
        val folderId = target?.let { resolve(it) }
        cloud.editRecording(id) { meta ->
            var edited = meta
            if (newTitle != null) edited = edited.withTitle(newTitle)
            if (target != null) edited = edited.withFolderId(folderId)
            edited.withFilingSuggested()
        }
        // Both halves are settled only once the push is back.
        _state.update { state ->
            state.copy(
                currentTitle = newTitle ?: state.currentTitle,
                titleAnswered = state.titleAnswered || newTitle != null,
                currentFolderId = if (target != null) folderId else state.currentFolderId,
                folderAnswered = state.folderAnswered || target != null,
            )
        }
    }

    /** The folder id a target files into, creating a new folder when asked to. */
    private suspend fun resolve(target: FolderTarget): String? = when (target) {
        is FolderTarget.Existing -> target.id
        FolderTarget.Root -> null
        is FolderTarget.New -> {
            val created = cloud.createFolder(target.name)
            _state.update { it.copy(existingFolders = it.existingFolders + created) }
            created.id
        }
    }

    // ── declining ────────────────────────────────────────────────────────────

    /**
     * The user said no, or finished with the offer. The offer goes at once —
     * a dismiss that waits on the network reads as a broken button — and the
     * id it belonged to comes back, for [markAnswered] to write the flag behind
     * it.
     */
    fun forget(): String? {
        val id = recordingId
        recordingId = null
        _state.value = FilingUiState(phase = FilingPhase.SETTLED)
        return id
    }

    /**
     * Write `filingSuggested` and nothing else — what Skip, and a Save that
     * found nothing to change, still owe the desktop. Failure is ignored: the
     * worst case is the desktop asking once more about a recording that was
     * already dealt with here.
     */
    suspend fun markAnswered(id: String) {
        try {
            cloud.editRecording(id) { it.withFilingSuggested() }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            // See above: best-effort.
        }
    }

    /**
     * The screenshot demo: an offer worth capturing, over a recording that has
     * landed under its clock name. No recording id, so a tap on the demo's own
     * buttons writes nothing — there is no account behind the fixtures.
     */
    fun seedDemo(
        recordingId: String,
        suggestion: FilingSuggestion,
        currentTitle: String,
        folders: List<CloudFolder>,
    ) {
        // Claimed, so the screen's own `consider` for the same recording is a
        // no-op rather than settling the offer away as a demo skip.
        consideredId = recordingId
        this.recordingId = null
        _state.value = FilingUiState(
            phase = FilingPhase.OFFERING,
            suggestion = suggestion,
            currentTitle = currentTitle,
            existingFolders = folders,
        )
    }

    companion object {
        /**
         * Why a finished recording gets no filing pass, or null when it should.
         * The same rules as iOS: only a recording that is actually in the cloud,
         * saved to the personal library, with something said in it.
         */
        fun skipReason(
            finished: MeetingState.Finished,
            destination: SaveDestination,
            spoken: List<TranscriptSegment>,
            demo: Boolean,
        ): FilingSkip? = when {
            demo -> FilingSkip.DEMO
            finished.recordingId == null || finished.dropped || finished.pendingUpload -> FilingSkip.NOT_UPLOADED
            destination.isOrg -> FilingSkip.ORG_DEFAULT
            spoken.isEmpty() -> FilingSkip.NO_TRANSCRIPT
            else -> null
        }

        /** Only what was actually said: final segments with words in them. */
        fun spoken(segments: List<TranscriptSegment>): List<TranscriptSegment> =
            segments.filter { it.isFinal && it.text.isNotBlank() && !it.id.endsWith(MeetingUploader.TAIL_SUFFIX) }
    }
}

/** Whether filing into this target would leave the recording where it already is. */
private fun FolderTarget.isWhere(currentFolderId: String?): Boolean = when (this) {
    is FolderTarget.Existing -> id == currentFolderId
    FolderTarget.Root -> currentFolderId == null
    is FolderTarget.New -> false
}
