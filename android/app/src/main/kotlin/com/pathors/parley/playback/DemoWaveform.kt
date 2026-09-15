package com.pathors.parley.playback

import kotlin.math.abs
import kotlin.math.sin

/**
 * A waveform for demo mode — the shape of a conversation, invented.
 *
 * `DemoMode` cannot hand the player a real file (no disk, no network, no
 * residue), but a screenshot of a player with an empty strip behind it sells
 * the feature short: the whole point of the overview is that you can *see* the
 * conversation in it. So the bars are synthesised, deterministically from the
 * recording id, and they are shaped like two people talking rather than like a
 * sine wave: alternating louder and quieter stretches with short gaps between
 * turns, which is what the dotted centreline in the drawing is there to show.
 *
 * Deterministic on purpose. A re-capture months later has to produce identical
 * frames, which a random generator would not.
 */
internal object DemoWaveform {

    fun overview(recordingId: String, durationMs: Long): AudioPeaks.Overview {
        val seed = recordingId.hashCode()
        val peaks = FloatArray(AudioPeaks.BUCKET_COUNT) { index ->
            val position = index.toDouble() / AudioPeaks.BUCKET_COUNT

            // Turn-taking: a slow square-ish alternation between two speakers,
            // one a little louder than the other.
            val turn = sin(position * TURNS_PER_RECORDING * TAU + seed % 7)
            val speaker = if (turn >= 0) 0.62 else 0.44

            // The pause between turns, and the pauses inside one.
            val gap = sin(position * PAUSES_PER_RECORDING * TAU + seed % 11)
            val silence = if (abs(turn) < 0.12 || gap < -0.88) 0.04 else 1.0

            // Syllables. Fast, and never all the way down, so the bars read as
            // speech rather than as a comb.
            val syllable = 0.55 + 0.45 * abs(sin(position * SYLLABLES_PER_RECORDING * TAU + seed))

            (speaker * silence * syllable).toFloat().coerceIn(0f, 1f)
        }
        return AudioPeaks.Overview(peaks, durationMs / 1000.0)
    }

    private const val TAU = 2.0 * Math.PI
    private const val TURNS_PER_RECORDING = 9.0
    private const val PAUSES_PER_RECORDING = 31.0
    private const val SYLLABLES_PER_RECORDING = 173.0
}
