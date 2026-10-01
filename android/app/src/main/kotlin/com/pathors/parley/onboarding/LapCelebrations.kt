package com.pathors.parley.onboarding

import android.content.Context
import androidx.core.content.edit
import com.pathors.parley.screenshot.DemoMode

/**
 * Whether the guided lap's finish on a recording has had its burst — the ✓
 * cascade, the success haptic and the confetti — so going back and forth
 * never fires it again. iOS `LapMotion.hasCelebrated` / `markCelebrated`,
 * under the same key, `lapMotion.celebrated.<id>`.
 *
 * `SharedPreferences` rather than a DataStore because the done card asks the
 * moment it appears: a suspend read would draw the lines hidden for a frame
 * and then decide. In demo mode it is in memory only, because a screenshot
 * run promises no residue.
 *
 * "Show the getting-started list again" forgets every one of them
 * ([forgetAll]): the lap starts over from the sample, and its finish with it.
 */
class LapCelebrations(
    private val read: (String) -> Boolean,
    private val write: (String, Boolean) -> Unit,
    private val clear: () -> Unit,
) {
    private val demo = mutableSetOf<String>()

    /**
     * True the first time it is asked about [recordingId], and marks it: the
     * caller plays the burst. False ever after.
     */
    @Synchronized
    fun claim(recordingId: String): Boolean {
        if (DemoMode.isActive) return demo.add(recordingId)
        val key = key(recordingId)
        if (read(key)) return false
        write(key, true)
        return true
    }

    @Synchronized
    fun forgetAll() {
        demo.clear()
        if (!DemoMode.isActive) clear()
    }

    companion object {
        /** The iOS `UserDefaults` key. */
        fun key(recordingId: String): String = "lapMotion.celebrated.$recordingId"

        fun device(context: Context): LapCelebrations {
            val preferences = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)
            return LapCelebrations(
                read = { preferences.getBoolean(it, false) },
                write = { key, value -> preferences.edit { putBoolean(key, value) } },
                clear = { preferences.edit { clear() } },
            )
        }

        private const val FILE = "parley_lap_motion"
    }
}
