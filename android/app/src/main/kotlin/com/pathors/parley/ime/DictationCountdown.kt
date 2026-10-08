package com.pathors.parley.ime

import kotlin.math.roundToLong

/**
 * The keyboard's warning that the dictation cap is about to stop the
 * microphone — iOS `DictationCountdown` (`ParleyKit/DictationEnding.swift`).
 *
 * The cap ([DictationSession.MAX_DURATION_MS], ten minutes, the same as iOS
 * `MicActivityPolicy.dictationLimit` and the desktop's
 * `HOSTED_VOICE_TYPING_MAX_SECONDS`) exists so a key left running in a pocket
 * cannot meter audio all afternoon. What must not happen is that it is silent:
 * someone dictating a long message has to know the clock is running before the
 * words after it are gone. So the last [WARNING_LEAD_MS] are counted down in the
 * keyboard strip, and an ordinary dictation — well under a minute — never sees
 * the countdown at all.
 *
 * Pure, so the rule is tested rather than trusted to a ticker.
 */
object DictationCountdown {

    /** How long before the cap the countdown shows. iOS `warningLead`. */
    const val WARNING_LEAD_MS = 30_000L

    /**
     * Whole seconds left to show, or null when there is nothing to show: more
     * than [WARNING_LEAD_MS] to go, or already at the cap (the stop is a moment
     * away, and "0 s" is not worth drawing).
     *
     * Rounded **up**, so the number counts 30 … 1 and a reading taken 200 ms
     * before the cap says 1 rather than 0.
     */
    fun secondsLeft(elapsedMs: Long, limitMs: Long = DictationSession.MAX_DURATION_MS): Int? {
        val left = limitMs - elapsedMs
        if (left <= 0L || left > WARNING_LEAD_MS) return null
        return ((left + 999L) / 1000L).toInt()
    }

    /** The cap in whole minutes, for the copy that names it ("…(10 min)"). */
    fun limitMinutes(limitMs: Long = DictationSession.MAX_DURATION_MS): Int =
        (limitMs / 60_000.0).roundToLong().toInt().coerceAtLeast(1)
}
