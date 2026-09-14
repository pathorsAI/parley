package com.pathors.parley.playback

import android.content.Context
import android.net.Uri
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import java.io.File

/**
 * What [PlaybackController] needs from a thing that plays audio.
 *
 * It exists for exactly one reason beyond testability: demo mode. The store
 * screenshots have no audio file and must never touch the disk or the network,
 * but the player still has to be on screen, at a plausible position, with the
 * transcript following it. A synthetic engine gives that without teaching the
 * controller a second set of rules.
 *
 * Every method is main-thread only — [ExoPlaybackEngine] wraps `ExoPlayer`,
 * which enforces it.
 */
internal interface PlaybackEngine {

    /** Current position in milliseconds. */
    val positionMs: Long

    /** Length in milliseconds, or 0 while it is still unknown. */
    val durationMs: Long

    val isPlaying: Boolean

    fun play()

    fun pause()

    fun seekTo(ms: Long)

    fun setRate(rate: Float)

    fun release()
}

/**
 * Callbacks [PlaybackController] wires to whichever engine it built.
 *
 * @property onReady the file opened; [durationMs] is now meaningful
 * @property onPlayingChanged play/pause actually took effect
 * @property onEnded the audio reached its end
 * @property onFailed the file will not play, and why (a code, not display copy)
 */
internal class PlaybackEngineListener(
    val onReady: () -> Unit = {},
    val onPlayingChanged: (Boolean) -> Unit = {},
    val onEnded: () -> Unit = {},
    val onFailed: (String) -> Unit = {},
)

/**
 * Media3 / ExoPlayer, playing one local Ogg/Opus file.
 *
 * ## Why Media3 and not a hand-rolled decode graph
 *
 * iOS could not use its system player here: `AVAudioPlayer` accepts a
 * `currentTime` on a 16 kHz Ogg/Opus stream, reports it back, and does not
 * actually move the read head — so `ios/ParleyKit/OggPlaybackEngine.swift` is
 * 600 lines of `ExtAudioFileSeek` plus an `AVAudioPlayerNode` rebuilt around
 * every seek. **None of that is needed here.** ExoPlayer's `OggExtractor` seeks
 * Opus streams natively (binary search over granule positions), so the whole
 * class is a thin wrapper and seeking is one call.
 *
 * Playback speed likewise: `PlaybackParameters` resamples with pitch
 * correction, so 0.75×–2× is a property rather than a signal chain.
 */
// `androidx.annotation.OptIn`, not Kotlin's: media3 marks its opt-in with the
// AndroidX annotation, which is checked by lint rather than by the compiler.
@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
internal class ExoPlaybackEngine(
    context: Context,
    file: File,
    private val listener: PlaybackEngineListener,
) : PlaybackEngine {

    private var ready = false

    private val player: ExoPlayer = ExoPlayer.Builder(context.applicationContext)
        .build()
        .apply {
            // Music usage, speech content: this is somebody replaying a meeting,
            // so it ducks and routes like a podcast rather than like a
            // notification. `handleAudioFocus` is what pauses us when a call
            // comes in — without it the meeting keeps talking under the caller.
            setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
                    .build(),
                /* handleAudioFocus = */ true,
            )
            // Explicitly off: the detail screen is not a media session, and a
            // player that kept going after the screen was left would be a
            // recording playing out loud with nothing on screen to stop it.
            pauseAtEndOfMediaItems = true
            addListener(object : Player.Listener {
                override fun onPlaybackStateChanged(state: Int) {
                    when (state) {
                        Player.STATE_READY -> if (!ready) {
                            ready = true
                            listener.onReady()
                        }

                        Player.STATE_ENDED -> listener.onEnded()
                        else -> Unit
                    }
                }

                override fun onIsPlayingChanged(playing: Boolean) {
                    listener.onPlayingChanged(playing)
                }

                override fun onPlayerError(error: PlaybackException) {
                    listener.onFailed(error.errorCodeName)
                }
            })
            setMediaItem(MediaItem.fromUri(Uri.fromFile(file)))
            prepare()
        }

    override val positionMs: Long get() = player.currentPosition.coerceAtLeast(0L)

    override val durationMs: Long
        get() = player.duration.takeIf { it != C.TIME_UNSET && it > 0 } ?: 0L

    override val isPlaying: Boolean get() = player.isPlaying

    override fun play() {
        // Pressing play on a finished recording starts it again rather than
        // doing nothing, which is what every podcast player does and what the
        // button visibly promises.
        if (player.playbackState == Player.STATE_ENDED) player.seekTo(0L)
        player.play()
    }

    override fun pause() = player.pause()

    override fun seekTo(ms: Long) = player.seekTo(ms.coerceAtLeast(0L))

    override fun setRate(rate: Float) {
        player.playbackParameters = PlaybackParameters(rate)
    }

    override fun release() = player.release()
}

/**
 * A clock pretending to be a player, for demo mode.
 *
 * `DemoMode` promises no disk, no network and no residue, and a store
 * screenshot of a player has to be a screenshot of the *player* — the real one,
 * with a waveform behind it and the transcript following the playhead. So the
 * engine is swapped rather than the UI: position is derived from wall time
 * scaled by the rate, and every other rule in [PlaybackController] applies
 * unchanged.
 *
 * Never constructed in a release build: `DemoMode.isActive` is false there,
 * because the deep link that sets it is gated on `BuildConfig.DEBUG`.
 */
internal class DemoPlaybackEngine(
    override val durationMs: Long,
    private val listener: PlaybackEngineListener,
    private val now: () -> Long = System::currentTimeMillis,
) : PlaybackEngine {

    private var basePositionMs = 0L
    private var startedAt = 0L
    private var playing = false
    private var rate = 1f

    init {
        listener.onReady()
    }

    override val positionMs: Long
        get() {
            if (!playing) return basePositionMs
            val elapsed = ((now() - startedAt) * rate).toLong()
            return (basePositionMs + elapsed).coerceAtMost(durationMs)
        }

    override val isPlaying: Boolean get() = playing && positionMs < durationMs

    override fun play() {
        if (basePositionMs >= durationMs) basePositionMs = 0L
        startedAt = now()
        playing = true
        listener.onPlayingChanged(true)
    }

    override fun pause() {
        if (playing) basePositionMs = positionMs
        playing = false
        listener.onPlayingChanged(false)
    }

    override fun seekTo(ms: Long) {
        basePositionMs = ms.coerceIn(0L, durationMs)
        startedAt = now()
    }

    override fun setRate(rate: Float) {
        if (playing) {
            basePositionMs = positionMs
            startedAt = now()
        }
        this.rate = rate
    }

    override fun release() {
        playing = false
    }
}
