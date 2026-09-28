package com.pathors.parley.playback

import com.pathors.parley.cloud.CloudClient
import com.pathors.parley.cloud.CloudException
import com.pathors.parley.feedback.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val TAG = "AudioDownloads"

/**
 * Where a recording's audio is, from the UI's point of view — iOS
 * `AudioDownloadState`.
 */
sealed interface AudioDownloadState {
    /** In the cloud only. Every recording made on another device starts here. */
    data object Absent : AudioDownloadState

    /** On its way. [fraction] is 0…1, or -1 when the server declared no length. */
    data class Downloading(val fraction: Float) : AudioDownloadState

    /** On this phone, and therefore playable without a network. */
    data object Local : AudioDownloadState

    /**
     * The last attempt failed. A *state* rather than an alert, as on iOS: the
     * person asked for a download, and the honest answer to a failure is a row
     * that says so, with a way to try again.
     */
    data class Failed(val failure: PlaybackFailure) : AudioDownloadState
}

/** How one [AudioDownloads.download] ended. */
sealed interface AudioDownloadOutcome {
    data object Done : AudioDownloadOutcome
    data class Failed(val failure: PlaybackFailure) : AudioDownloadOutcome
}

/**
 * One per process: who is downloading what, and what the local store holds.
 * The Android counterpart of iOS `AudioDownloadModel`.
 *
 * Shared by every door into a download — the library row's menu, the detail
 * screen's player, re-transcription fetching its audio — so a download started
 * from the library shows its progress when the recording is opened, and a
 * second request for the same recording joins the first rather than racing it
 * into the same file.
 *
 * App-scoped on purpose. The detail screen's player used to own its download
 * and cancelled it on the way out, which was right while that was the only
 * place a download could start from and is wrong now that the library can: a
 * download asked for from a list is expected to keep going while you scroll.
 *
 * "Is this on the phone" is answered from [LocalAudioStore] rather than
 * remembered here, so a recording kept the moment it finished uploading shows
 * as local without anyone having to say so. [active] holds only the two states
 * a *file* cannot express — in flight, and failed — and [onPhone] is a snapshot
 * of the directory, re-read by [refresh] and after every change made here.
 */
class AudioDownloads(
    private val cloud: CloudClient,
    private val store: LocalAudioStore,
    private val scope: CoroutineScope,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    /** Demo mode never reaches the network. Read at call time; the flag can flip. */
    private val isDemo: () -> Boolean = { false },
    /** Where a failed download is reported. A parameter so JVM tests need no `android.util.Log`. */
    private val logFailure: (String, Throwable) -> Unit = { message, e -> Log.w(TAG, message, e) },
) {
    private val _active = MutableStateFlow<Map<String, AudioDownloadState>>(emptyMap())

    /** Only [AudioDownloadState.Downloading] and [AudioDownloadState.Failed] live here. */
    val active: StateFlow<Map<String, AudioDownloadState>> = _active.asStateFlow()

    private val _onPhone = MutableStateFlow<Set<String>>(emptySet())

    /**
     * The store's file names ([LocalAudioStore.fileName] of each id), as of the
     * last [refresh]. Names rather than ids because the directory is the source
     * of truth and it only knows names; [state] maps an id onto one.
     */
    val onPhone: StateFlow<Set<String>> = _onPhone.asStateFlow()

    /** The running download of each id, so a second caller can join it. */
    private val inFlight = mutableMapOf<String, Deferred<AudioDownloadOutcome>>()

    /** Everything about [id] a row needs to draw, from the two snapshots above. */
    fun state(id: String): AudioDownloadState =
        stateOf(id, _active.value, _onPhone.value)

    fun isDownloading(id: String): Boolean = _active.value[id] is AudioDownloadState.Downloading

    /**
     * Fetch the audio and hand it to the store.
     *
     * Suspending until "no download of this recording is still running",
     * whoever started it — iOS learned that the hard way: a re-transcribe that
     * returned the moment somebody else's download was merely *under way* found
     * no file and reported a failure about a download that was going fine.
     *
     * The work itself runs on the app scope, so a caller that stops waiting (a
     * screen closing) does not cancel it for everybody else.
     */
    suspend fun download(id: String): AudioDownloadOutcome {
        if (isDemo()) return AudioDownloadOutcome.Done
        return start(id).await()
    }

    /** Start (or join) the download without waiting for it — the library's menu. */
    fun requestDownload(id: String) {
        if (isDemo()) return
        start(id)
    }

    @Synchronized
    private fun start(id: String): Deferred<AudioDownloadOutcome> {
        inFlight[id]?.takeIf { it.isActive }?.let { return it }
        _active.update { it + (id to AudioDownloadState.Downloading(-1f)) }
        val job = scope.async { perform(id) }
        inFlight[id] = job
        return job
    }

    /**
     * The download proper. `CloudClient.downloadAudio` writes a `.part` file and
     * renames it into place, so a download that dies halfway can never leave a
     * truncated Ogg under a name [LocalAudioStore.has] would call local.
     */
    private suspend fun perform(id: String): AudioDownloadOutcome {
        val outcome = try {
            cloud.downloadAudio(id, store.audioFile(id)) { read, total ->
                val fraction = if (total > 0L) (read.toDouble() / total).toFloat() else -1f
                publishProgress(id, fraction.coerceIn(-1f, 1f))
            }
            AudioDownloadOutcome.Done
        } catch (e: CancellationException) {
            _active.update { it - id }
            throw e
        } catch (e: Throwable) {
            logFailure("audio download failed for $id", e)
            AudioDownloadOutcome.Failed(failureOf(e))
        }
        finish(id, outcome)
        return outcome
    }

    @Synchronized
    private fun finish(id: String, outcome: AudioDownloadOutcome) {
        // Cleared before the deferred completes, so by the time anyone's await
        // returns the slot is already free for a retry.
        inFlight.remove(id)
        _active.update { current ->
            when (outcome) {
                AudioDownloadOutcome.Done -> current - id
                is AudioDownloadOutcome.Failed -> current + (id to AudioDownloadState.Failed(outcome.failure))
            }
        }
        if (outcome == AudioDownloadOutcome.Done) {
            _onPhone.update { it + LocalAudioStore.fileName(id) }
        }
    }

    /**
     * Only while the download is still the thing happening: the callback runs
     * on the IO thread doing the copy, and a report already in flight when the
     * download ended must not write a progress ring back over its result.
     */
    private fun publishProgress(id: String, fraction: Float) {
        _active.update { current ->
            if (current[id] is AudioDownloadState.Downloading) {
                current + (id to AudioDownloadState.Downloading(fraction))
            } else {
                current
            }
        }
    }

    /**
     * Give the bytes back. The cloud copy is untouched, which is why this is not
     * a destructive action anywhere it is offered.
     */
    fun removeDownload(id: String) {
        if (isDemo()) return
        _active.update { current ->
            if (current[id] is AudioDownloadState.Downloading) current else current - id
        }
        scope.launch {
            withContext(io) { store.remove(id) }
            refresh()
        }
    }

    /**
     * The account sheet's "Remove all", after its confirmation. Suspends until
     * the directory is gone so the sheet can re-read the size afterwards.
     * Downloads still running keep their ring; their file lands after this.
     */
    suspend fun removeAll() {
        if (isDemo()) return
        withContext(io) { store.removeAll() }
        _active.update { current -> current.filterValues { it is AudioDownloadState.Downloading } }
        refresh()
    }

    /**
     * Re-read the directory. Called when the library loads — a meeting kept on
     * the phone after uploading arrives there without passing through here.
     */
    suspend fun refresh() {
        if (isDemo()) {
            _onPhone.value = emptySet()
            return
        }
        _onPhone.value = withContext(io) { store.storedNames() }
    }

    companion object {
        /**
         * A 404 is the server saying there is no audio for this recording, which
         * is permanent and worth different copy; everything else is treated as a
         * transport problem worth retrying. The same split the player has always
         * drawn.
         */
        fun failureOf(e: Throwable): PlaybackFailure =
            if ((e as? CloudException)?.isNotFound == true) {
                PlaybackFailure.DOWNLOAD_MISSING
            } else {
                PlaybackFailure.DOWNLOAD_NETWORK
            }

        /** Pure, for [state] and for the library's row model. */
        fun stateOf(
            id: String,
            active: Map<String, AudioDownloadState>,
            onPhone: Set<String>,
        ): AudioDownloadState =
            active[id] ?: if (LocalAudioStore.fileName(id) in onPhone) {
                AudioDownloadState.Local
            } else {
                AudioDownloadState.Absent
            }
    }
}
