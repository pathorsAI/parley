package com.pathors.parley.playback

import android.content.Context
import android.util.Log
import androidx.media3.common.util.UnstableApi
import com.pathors.parley.cloud.CloudClient
import com.pathors.parley.parleyContainer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
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
    /**
     * The last discrete jump asked for from the text — a tapped turn — rather
     * than a scrub. The waveform watches its [PlaybackJump.id] to glide its
     * playhead there and ring the spot, which a scrub, already under the
     * finger, must not do. iOS `PlaybackController.lastJump`.
     */
    val jump: PlaybackJump = PlaybackJump(),
    /**
     * An edge of the transcript is being held: the engine plays at
     * [PlaybackController.HELD_RATE] while [rate] keeps the speed the person
     * chose, because letting go restores it. iOS `isHoldingTwoX`.
     */
    val isHoldingTwoX: Boolean = false,
) {
    /** Whether a seek would do anything — i.e. there is audio open. */
    val isSeekable: Boolean get() = phase == PlaybackPhase.READY && durationMs > 0L
}

/**
 * A jump from [fromMs] to [toMs], numbered so two jumps to the same line are
 * still two events. `id == 0` is "no jump yet".
 */
data class PlaybackJump(val id: Int = 0, val fromMs: Long = 0L, val toMs: Long = 0L)

/**
 * The recording detail screen's player: one recording, from "is the audio even
 * here" to a moving playhead.
 *
 * Owns three things and nothing else: the [PlaybackEngine], the position
 * poll, and the overview waveform. The download that feeds it belongs to the
 * app-wide [AudioDownloads], so one started from the library shows its progress
 * here, and leaving this screen does not cancel it for the library. It is deliberately
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
    /** The remembered speed. In memory in demo mode, which promises no residue. */
    private val rates: PlaybackRateStore =
        if (demo) PlaybackRateStore.inMemory() else PlaybackRateStore.device(context),
    /**
     * The shared downloader. Defaulted from the container so the detail
     * screen's view model builds this exactly as it did before downloads were
     * shared with the library.
     */
    private val downloads: AudioDownloads = context.parleyContainer.audioDownloads,
) {
    private val context = context.applicationContext

    private val _state = MutableStateFlow(PlaybackState(rate = rates.load()))
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
     * Seeks on their way to the engine, conflated. A scrub seeks on every move
     * of the finger — that is what makes the audio follow it — and ExoPlayer
     * flushes its renderers on each one, so the engine is handed the newest
     * target at most once per [SEEK_INTERVAL_MS] and the ones in between are
     * dropped. The first seek after a pause goes straight through: a tapped
     * turn is never delayed.
     */
    private val seeks = Channel<Long>(Channel.CONFLATED)

    /**
     * The target the engine has not been handed yet. While there is one, the
     * position poll reports it instead of the engine's stale position, so the
     * playhead does not flick back for a frame between a scrub and its seek.
     */
    private var pendingSeekMs: Long? = null

    init {
        scope.launch(Dispatchers.Main) {
            for (target in seeks) {
                engine?.seekTo(target)
                if (pendingSeekMs == target) pendingSeekMs = null
                delay(SEEK_INTERVAL_MS)
            }
        }
    }

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
            when {
                present -> prepare()
                // Started from the library a moment ago: show that download
                // rather than offering a second one.
                !demo && downloads.isDownloading(recordingId) -> download()
                else -> _state.value = PlaybackState(phase = PlaybackPhase.ABSENT)
            }
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
     * Move the playhead, and say so. Main thread — every caller is a gesture.
     *
     * The bump to [PlaybackState.seekGeneration] is the point: it is what
     * re-arms the transcript's follow-the-audio. Clamped here rather than in the
     * engine so a drag past either end of the waveform lands on the end.
     *
     * Applied live and cheap to call on every frame of a drag: the position
     * moves at once, and the engine seek is conflated (see [seeks]), so a scrub
     * during playback keeps playing from under the finger.
     */
    fun seekTo(ms: Long) {
        if (engine == null) return
        val duration = _state.value.durationMs
        val target = if (duration > 0L) ms.coerceIn(0L, duration) else ms.coerceAtLeast(0L)
        pendingSeekMs = target
        _state.update {
            it.copy(positionMs = target, seekGeneration = it.seekGeneration + 1)
        }
        seeks.trySend(target)
    }

    /**
     * [seekTo], announced as a jump — a tapped turn or timecode rather than a
     * scrub. See [PlaybackState.jump]. iOS `PlaybackController.jump(to:)`.
     */
    fun jumpTo(ms: Long) {
        if (!_state.value.isSeekable) return
        val from = _state.value.positionMs
        seekTo(ms)
        _state.update {
            it.copy(jump = PlaybackJump(id = it.jump.id + 1, fromMs = from, toMs = it.positionMs))
        }
    }

    /** Any menu speed. Remembered for the next recording and the next launch. */
    fun setRate(rate: Float) {
        val snapped = PlaybackRates.snap(rate)
        rates.save(snapped)
        val engine = engine
        scope.launch(Dispatchers.Main) {
            // A choice made mid-hold is remembered, not heard, until the hold ends.
            if (!_state.value.isHoldingTwoX) engine?.setRate(snapped)
            _state.update { it.copy(rate = snapped) }
        }
    }

    /** A tap on the speed: 1 → 1.25 → 1.5 → 2 → 1. See [PlaybackRates.next]. */
    fun cycleRate() = setRate(PlaybackRates.next(_state.value.rate))

    /**
     * An edge of the transcript is held, or let go. Deliberately leaves
     * [PlaybackState.rate] alone: the chosen speed has to survive the gesture,
     * because releasing restores it. Does not start playback — iOS `holdTwoX`.
     */
    fun holdTwoX(holding: Boolean) {
        if (_state.value.isHoldingTwoX == holding) return
        _state.update { it.copy(isHoldingTwoX = holding) }
        val engine = engine ?: return
        scope.launch(Dispatchers.Main) {
            engine.setRate(if (_state.value.isHoldingTwoX) HELD_RATE else _state.value.rate)
        }
    }

    /** Mandatory. See the class doc. */
    fun release() {
        released = true
        ticker?.cancel()
        downloadJob?.cancel()
        peaksJob?.cancel()
        seeks.close()
        val engine = engine ?: return
        this.engine = null
        engine.release()
    }

    // ── internals ────────────────────────────────────────────────────────────

    /**
     * The body of the download job: wait for the shared download — joining one
     * that is already running — mirroring its progress into this player, then
     * open the file.
     *
     * Cancelling this job (the screen going away) stops the waiting, not the
     * download: that belongs to [AudioDownloads], and the library may be
     * watching it too.
     */
    private suspend fun fetchAndPrepare(id: String) {
        val mirror = scope.launch {
            downloads.active
                .map { it[id] }
                .distinctUntilChanged()
                .collect { state ->
                    if (state is AudioDownloadState.Downloading) publishDownloadProgress(state.fraction)
                }
        }
        val outcome = try {
            downloads.download(id)
        } finally {
            mirror.cancel()
        }
        when (outcome) {
            AudioDownloadOutcome.Done -> prepare()
            is AudioDownloadOutcome.Failed -> fail(outcome.failure)
        }
    }

    /**
     * Report download progress, and only while the download is still the thing
     * happening here, so a late report cannot write a progress bar back over
     * whatever replaced it. -1 is how [PlaybackState.downloadFraction] says
     * "indeterminate".
     */
    private fun publishDownloadProgress(fraction: Float) {
        _state.update { current ->
            if (current.phase == PlaybackPhase.DOWNLOADING) {
                current.copy(downloadFraction = fraction.coerceIn(-1f, 1f))
            } else {
                current
            }
        }
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
                positionMs = pendingSeekMs ?: engine.positionMs,
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
        val RATES: List<Float> get() = PlaybackRates.MENU

        /**
         * What an edge hold plays at. Not a setting and never written to
         * [PlaybackState.rate] — iOS `PlaybackController.heldRate`.
         */
        const val HELD_RATE = 2f

        /** Position poll interval while playing. See [startTicking]. */
        private const val TICK_MS = 50L

        /**
         * The fastest the engine is asked to seek during a scrub: about 12 a
         * second, which keeps the audio under the finger without re-priming
         * the decoder on every one of the 60–120 moves a second a drag makes.
         */
        private const val SEEK_INTERVAL_MS = 80L
    }
}
