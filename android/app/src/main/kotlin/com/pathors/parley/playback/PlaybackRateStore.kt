package com.pathors.parley.playback

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit

/**
 * The playback speed somebody chose, kept across recordings and launches — iOS
 * keeps it in `UserDefaults` under `playbackRate`, and a person who listens to
 * every meeting at 1.5× should not have to say so on each one.
 *
 * `SharedPreferences` rather than a DataStore because the controller needs the
 * value synchronously, at construction, before the first frame of the player
 * draws a speed: a DataStore read is a suspend call, and the button would show
 * 1× for a frame and then change.
 */
interface PlaybackRateStore {
    fun load(): Float
    fun save(rate: Float)

    companion object {
        /** The device's store. The file and key names are the iOS key. */
        fun device(context: Context): PlaybackRateStore =
            PreferencesRateStore(
                context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE),
            )

        /**
         * A store that forgets. Demo mode promises no residue, and a speed
         * picked while capturing screenshots is residue.
         */
        fun inMemory(initial: Float = 1f): PlaybackRateStore = MemoryRateStore(initial)

        private const val FILE = "parley_playback"
    }
}

internal class PreferencesRateStore(private val preferences: SharedPreferences) : PlaybackRateStore {
    override fun load(): Float =
        PlaybackRates.restore(
            if (preferences.contains(KEY)) preferences.getFloat(KEY, 1f) else null,
        )

    override fun save(rate: Float) {
        preferences.edit { putFloat(KEY, PlaybackRates.snap(rate)) }
    }

    private companion object {
        const val KEY = "playbackRate"
    }
}

internal class MemoryRateStore(private var rate: Float) : PlaybackRateStore {
    override fun load(): Float = PlaybackRates.restore(rate)
    override fun save(rate: Float) {
        this.rate = PlaybackRates.snap(rate)
    }
}
