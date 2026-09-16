package com.pathors.parley.playback

import android.content.Context
import android.util.Log
import androidx.media3.common.util.UnstableApi
import com.pathors.parley.cloud.CloudClient
import com.pathors.parley.cloud.CloudException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val TAG = "PlaybackController"

/** Where the player is in getting a recording on to the speaker. */
enum class PlaybackPhase {
    /** The audio is not on this phone. The UI offers to fetch it. */
    ABSENT,

    /** `GET /recordings/{id}/audio` is in flight. */
    DOWNLOADING,

    /** The file is here and the engine is opening it. */
    PREPARING,

    /** Playable. This is the only phase that draws a player. */
    READY,

    /** The file is here and will not play, or the download did not finish. */
    FAILED,
}

/** Why playback is not happening. A code — the screen owns the copy for each. */
enum class PlaybackFailure {
    /** The download could not reach the server, or it 5xx'd. */
    DOWNLOAD_NETWORK,

    /** The server has no audio for this recording (404). */
    DOWNLOAD_MISSING,

    /** The file is on the phone and the decoder refused it. */
    UNPLAYABLE,
}

/**
 * Everything the player UI draws, in one immutable snapshot.
 *
 * Position is polled rather than pushed because that is what the engines
 * actually offer, and a 20 Hz poll while playing is cheaper than it looks —
 * nothing recomposes unless a field changed, and the only field that changes
 * between ticks is [positionMs].
 */
data class PlaybackState(
    val phase: PlaybackPhase = PlaybackPhase.ABSENT,
    val failure: PlaybackFailure? = null,
    /** Download progress in 0…1, or -1 when the server declared no length. */
    val downloadFraction: Float = -1f,
    val isPlaying: Boolean = false,
    val positionMs: Long = 0L,
    val durationMs: Long = 0L,
    val rate: Float = 1f,
    /** The overview waveform, once it has been measured. */
    val overview: AudioPeaks.Overview? = null,
    /**
     * Bumped on every [PlaybackController.seekTo]. The transcript watches it to
     * re-arm follow-the-audio: somebody who taps a paragraph to hear it wants
     * the transcript to keep up again, and "the position jumped" is not a thing
     * a position value can say on its own.
     */
    val seekGeneration: Int = 0,
) {
    /** Whether a seek would do anything — i.e. there is audio open. */
    val isSeekable: Boolean get() = phase == PlaybackPhase.READY && durationMs > 0L
}

/**
 * The recording detail screen's player: one recording, from "is the audio even
 * here" to a moving playhead.
 *
 * Owns four things and nothing else: the [PlaybackEngine], the download that
 * feeds it, the position poll, and the overview waveform. It is deliberately
 * not a ViewModel — `RecordingDetailViewModel` holds one and forwards to it, so
 * the playback rules stay readable in one file and testable without Compose.
 *
 * ## Main thread
 *
 * `ExoPlayer` must be built, driven and released on the thread that built it,
 * so every method here hops to [Dispatchers.Main] before touching the engine.
 * The download and the peaks computation are the only work that leaves it.
 *
 * ## Lifetime
 *
 * [release] is mandatory and is called from `onCleared`. A leaked `ExoPlayer`
 * holds an audio focus request and a decoder — on a phone that means a meeting
 * still audibly playing with nothing on screen to stop it.
 */
@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
class PlaybackController(
    context: Context,
    private val cloud: CloudClient,
    private val store: LocalAudioStore,
    private val scope: CoroutineScope,
    /** Swaps the engine for a clock and the audio for a fixture. See [DemoPlaybackEngine]. */
    private val demo: Boolean = false,
) {
    private val context = context.applicationContext

    private val _state = MutableStateFlow(PlaybackState())
    val state: StateFlow<PlaybackState> = _state.asStateFlow()

    private var engine: PlaybackEngine? = null
    private var recordingId: String? = null

    /** The meta's duration, used until the engine reports its own. */
    private var fallbackDurationMs: Long = 0L

    private var ticker: Job? = null
    private var downloadJob: Job? = null
    private var peaksJob: Job? = null
    private var released = false

    /**
     * Point the controller at a recording.
     *
     * Does not download: arriving on a detail screen must not spend somebody's
     * data on a 40 MB file they may only have opened to read. Audio already on
     * the phone opens immediately, which is the common case for a meeting
     * recorded here.
     */
    fun open(recordingId: String, durationMsHint: Long) {
        if (released || this.recordingId == recordingId) return
        this.recordingId = recordingId
        fallbackDurationMs = durationMsHint.coerceAtLeast(0L)

        if (demo) {
            _state.value = PlaybackState(
                phase = PlaybackPhase.READY,
                durationMs = fallbackDurationMs,
                overview = DemoWaveform.overview(recordingId, fallbackDurationMs),
            )
            engine = DemoPlaybackEngine(fallbackDurationMs, engineListener())
            return
        }

        scope.launch {
            val present = withContext(Dispatchers.IO) { store.has(recordingId) }
            if (present) prepare() else _state.value = PlaybackState(phase = PlaybackPhase.ABSENT)
        }
    }

    /**
     * Fetch the audio from the cloud. What the "download to play back" button
     * calls, and a no-op while one is already running.
     */
    fun download() {
        val id = recordingId ?: return
        if (demo || released || downloadJob?.isActive == true) return

        _state.update {
            it.copy(
                phase = PlaybackPhase.DOWNLOADING,
                failure = null,
                downloadFraction = -1f,
            )
        }
        downloadJob = scope.launch { fetchAndPrepare(id) }
    }

    fun togglePlayPause() {
        val engine = engine ?: return
        scope.launch(Dispatchers.Main) {
            if (engine.isPlaying) engine.pause() else engine.play()
            sample()
        }
    }

    /**
     * Move the playhead, and say so.
     *
     * The bump to [PlaybackState.seekGeneration] is the point: it is what
     * re-arms the transcript's follow-the-audio. Clamped here rather than in the
     * engine so a drag past either end of the waveform lands on the end.
     */
    fun seekTo(ms: Long) {
        val engine = engine ?: return
        scope.launch(Dispatchers.Main) {
            val duration = _state.value.durationMs
            val target = if (duration > 0L) ms.coerceIn(0L, duration) else ms.coerceAtLeast(0L)
            engine.seekTo(target)
            _state.update {
                it.copy(positionMs = target, seekGeneration = it.seekGeneration + 1)
            }
        }
    }

    fun setRate(rate: Float) {
        val clamped = rate.coerceIn(RATES.first(), RATES.last())
        val engine = engine
        scope.launch(Dispatchers.Main) {
            engine?.setRate(clamped)
            _state.update { it.copy(rate = clamped) }
        }
    }

    /** Tap-to-cycle through [RATES], wrapping at 2×. */
    fun cycleRate() {
        val current = _state.value.rate
        val index = RATES.indexOfFirst { it > current - RATE_EPSILON && it < current + RATE_EPSILON }
        setRate(RATES[if (index < 0) 1 else (index + 1) % RATES.size])
    }

    /** Mandatory. See the class doc. */
    fun release() {
        released = true
        ticker?.cancel()
        downloadJob?.cancel()
        peaksJob?.cancel()
        val engine = engine ?: return
        this.engine = null
        engine.release()
    }

    // ── internals ────────────────────────────────────────────────────────────

    /**
     * The body of the download job: stream the file down, then open it.
     *
     * Cancellation is rethrown rather than reported, because a cancelled job is
     * the screen going away or a second [download] superseding this one —
     * neither is a failure to show anybody.
     */
    private suspend fun fetchAndPrepare(id: String) {
        try {
            cloud.downloadAudio(id, store.audioFile(id), ::publishDownloadProgress)
            prepare()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            Log.w(TAG, "audio download failed for $id", e)
            fail(downloadFailure(e))
        }
    }

    /**
     * Report download progress, and only while the download is still the thing
     * happening: the callback runs on the IO thread doing the copy, so a report
     * already in flight when the job is cancelled must not write a progress bar
     * back over whatever replaced it.
     *
     * A total of 0 or less is the server declaring no length; -1 is how
     * [PlaybackState.downloadFraction] says "indeterminate".
     */
    private fun publishDownloadProgress(read: Long, total: Long) {
        val fraction = if (total > 0L) (read.toDouble() / total).toFloat() else -1f
        _state.update { current ->
            if (current.phase == PlaybackPhase.DOWNLOADING) {
                current.copy(downloadFraction = fraction.coerceIn(-1f, 1f))
            } else {
                current
            }
        }
    }

    /**
     * A 404 is the server saying it has no audio for this recording, which is
     * permanent and worth different copy; everything else is treated as a
     * transport problem worth retrying.
     */
    private fun downloadFailure(e: Throwable): PlaybackFailure =
        if ((e as? CloudException)?.isNotFound == true) {
            PlaybackFailure.DOWNLOAD_MISSING
        } else {
            PlaybackFailure.DOWNLOAD_NETWORK
        }

    private suspend fun prepare() {
        val id = recordingId ?: return
        _state.update {
            it.copy(
                phase = PlaybackPhase.PREPARING,
                failure = null,
                durationMs = fallbackDurationMs,
            )
        }
        withContext(Dispatchers.Main) {
            engine?.release()
            engine = try {
                ExoPlaybackEngine(context, store.audioFile(id), engineListener())
            } catch (e: Throwable) {
                Log.w(TAG, "could not open audio for $id", e)
                null
            }
            if (engine == null) fail(PlaybackFailure.UNPLAYABLE)
        }
        loadPeaks(id)
    }

    private fun engineListener() = PlaybackEngineListener(
        onReady = {
            _state.update {
                it.copy(
                    phase = PlaybackPhase.READY,
                    failure = null,
                    durationMs = engine?.durationMs?.takeIf { ms -> ms > 0L }
                        ?: it.durationMs.takeIf { ms -> ms > 0L }
                        ?: fallbackDurationMs,
                )
            }
            // The rate survives a re-open: somebody who set 1.5× and then
            // downloaded a second recording did not ask to go back to 1×.
            engine?.setRate(_state.value.rate)
        },
        onPlayingChanged = { playing ->
            _state.update { it.copy(isPlaying = playing) }
            if (playing) startTicking() else stopTicking()
        },
        onEnded = {
            stopTicking()
            _state.update {
                it.copy(isPlaying = false, positionMs = it.durationMs)
            }
        },
        onFailed = { reason ->
            Log.w(TAG, "player error: $reason")
            fail(PlaybackFailure.UNPLAYABLE)
        },
    )

    private fun fail(failure: PlaybackFailure) {
        stopTicking()
        _state.update {
            it.copy(phase = PlaybackPhase.FAILED, failure = failure, isPlaying = false)
        }
    }

    /**
     * Poll the engine while it is playing.
     *
     * 20 Hz because the waveform's playhead has to move smoothly across it and
     * the transcript has to turn over on the right line; slower reads as a
     * stutter at 2×. It stops the moment playback does, so a paused screen
     * costs nothing.
     */
    private fun startTicking() {
        if (ticker?.isActive == true) return
        ticker = scope.launch(Dispatchers.Main) {
            while (isActive) {
                sample()
                delay(TICK_MS)
            }
        }
    }

    private fun stopTicking() {
        ticker?.cancel()
        ticker = null
    }

    private fun sample() {
        val engine = engine ?: return
        val duration = engine.durationMs.takeIf { it > 0L }
        _state.update {
            it.copy(
                positionMs = engine.positionMs,
                isPlaying = engine.isPlaying,
                durationMs = duration ?: it.durationMs,
            )
        }
    }

    private fun loadPeaks(id: String) {
        peaksJob?.cancel()
        peaksJob = scope.launch {
            val overview = AudioPeaksLoader.load(context, store, id)
            // Guard on the id: a controller that was pointed at a second
            // recording while this was decoding must not be handed the first
            // one's waveform.
            if (recordingId == id) _state.update { it.copy(overview = overview) }
        }
    }

    companion object {
        /** The speed menu, identical to iOS `PlaybackController.menu`. */
        val RATES = listOf(0.75f, 1f, 1.25f, 1.5f, 1.75f, 2f)

        /** Position poll interval while playing. See [startTicking]. */
        private const val TICK_MS = 50L

        private const val RATE_EPSILON = 0.01f
    }
}
