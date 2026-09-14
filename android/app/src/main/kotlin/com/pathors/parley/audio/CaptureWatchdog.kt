package com.pathors.parley.audio

/**
 * The rule for deciding that a recording has gone quiet in a way that no
 * Android callback will ever tell us about.
 *
 * ## Why a watchdog at all
 *
 * Android's only proactive signal that capture has gone wrong is
 * `AudioManager.AudioRecordingCallback.isClientSilenced`, and it is passive: it
 * reports one specific reason (a privileged app took priority) and says nothing
 * about the others. Two others matter here.
 *
 * From Android 10 on, an app that loses the microphone is not given an error —
 * it is **fed silence**. `read()` keeps returning full buffers, the encoder
 * keeps encoding, the file keeps growing, and what is in it is nothing. And an
 * `AudioRecord` whose `read()` simply stops returning produces no signal at all:
 * no exception, no callback, no partial buffer. Left alone, either failure
 * lasts for the rest of the meeting.
 *
 * So the only reliable detector is the absence of the thing that should be
 * arriving. `MicCapture` delivers a 100 ms chunk roughly ten times a second; a
 * chunk that has not arrived for seconds is the evidence.
 *
 * iOS reaches the same conclusion by the same route — see
 * `ios/App/Parley/AudioCapture.swift` lines 619-640, a two-second
 * `DispatchSource` timer whose comment says it plainly: "an eight-second gap the
 * user is told about beats an hour of silence they are not."
 *
 * ## Why this is only the decision
 *
 * The timer itself belongs to the caller — it owns the thread, the chunk
 * timestamps, and whatever it does about a stall. What is here is the predicate,
 * extracted for the same reason `ReconnectPolicy` was: a timing rule that is
 * only reachable through a live microphone is a timing rule that never gets
 * tested, and this one is all boundaries.
 *
 * @property checkIntervalMillis how often the caller is expected to ask. Not
 *   used by the predicate — it is here because [stalledAfterMillis] is only
 *   meaningful as a multiple of it, and keeping the two apart in different files
 *   is how they drift.
 * @property stalledAfterMillis silence longer than this is a stall.
 */
class CaptureWatchdog(
    val checkIntervalMillis: Long = DEFAULT_CHECK_INTERVAL_MILLIS,
    val stalledAfterMillis: Long = DEFAULT_STALLED_AFTER_MILLIS,
) {
    init {
        require(checkIntervalMillis > 0) {
            "checkIntervalMillis must be positive (got $checkIntervalMillis)"
        }
        require(stalledAfterMillis > 0) {
            "stalledAfterMillis must be positive (got $stalledAfterMillis)"
        }
        require(stalledAfterMillis >= checkIntervalMillis) {
            "stalledAfterMillis ($stalledAfterMillis) must not be shorter than " +
                "checkIntervalMillis ($checkIntervalMillis) — a stall shorter than the " +
                "gap between checks is one the watchdog can only ever notice by luck"
        }
    }

    /**
     * Has capture been silent for too long?
     *
     * Strictly greater than [stalledAfterMillis], so the threshold itself is
     * still healthy: at the defaults, 4 000 ms since the last chunk is fine and
     * 4 001 ms is a stall.
     *
     * Two inputs are deliberately *not* stalls:
     *
     * - **`lastChunkAtMillis == 0`** — nothing has arrived yet. Between
     *   `AudioRecord.startRecording()` and the first chunk there is a real
     *   window, and treating "has not started" as "has died" would tear down and
     *   rebuild every recording at the four-second mark before it ever produced
     *   a sample.
     * - **`nowMillis` before `lastChunkAtMillis`** — the clock moved backwards.
     *   With a wall clock that is an NTP correction or the user changing the
     *   time; even a monotonic source can read backwards across a suspend on
     *   some devices. A negative elapsed time must not be allowed to fall
     *   through into a comparison, and it must certainly not be read as a very
     *   large gap.
     */
    fun isStalled(nowMillis: Long, lastChunkAtMillis: Long): Boolean {
        if (lastChunkAtMillis <= 0L) return false
        if (nowMillis <= lastChunkAtMillis) return false
        return nowMillis - lastChunkAtMillis > stalledAfterMillis
    }

    /**
     * The full gate: should the watchdog actually speak up this tick?
     *
     * All three conjuncts are load-bearing, and the two flags are ported
     * straight from the iOS watchdog's guard
     * (`ios/App/Parley/AudioCapture.swift` lines 619-640, `!rebuilding` and the
     * `!lost` folded into `needsRebuild()`).
     *
     * - **[isStalled]** — the evidence. Without it there is nothing to report.
     * - **`!recovering`** — a recovery that is already climbing its ladder has,
     *   by definition, no chunks arriving; "stalled" stays true for the whole of
     *   it. A watchdog allowed to speak during a recovery would therefore fire
     *   every [checkIntervalMillis] and knock the ladder back to its first rung
     *   each time, so the backoff would never actually back off and the recovery
     *   would never reach the attempt that would have worked. It would retry
     *   forever at two-second intervals and look, from the outside, exactly like
     *   a recovery that is trying hard.
     * - **`!givenUp`** — once the ladder is spent the microphone is presumed
     *   gone for good, and probing it again every two seconds for the remaining
     *   ninety minutes of the meeting costs battery and a stream of state
     *   churn in exchange for nothing. What revives a given-up capture is an
     *   event that announces itself — the user returning to the foreground, a
     *   route change, the device coming back — not another poll.
     *
     * @param recovering `CaptureRecovery.isRecovering` — a rebuild is in
     *   flight, or the capture is sitting interrupted waiting to resume.
     * @param givenUp `CaptureRecovery.hasGivenUp` — the ladder is exhausted and
     *   the machine has settled in `Phase.LOST`.
     */
    fun shouldProbe(
        nowMillis: Long,
        lastChunkAtMillis: Long,
        recovering: Boolean,
        givenUp: Boolean,
    ): Boolean = !recovering && !givenUp && isStalled(nowMillis, lastChunkAtMillis)

    companion object {
        /** Matches the iOS watchdog's cadence (`AudioCapture.swift` line 83). */
        const val DEFAULT_CHECK_INTERVAL_MILLIS = 2_000L

        /**
         * Two missed checks, and — at `MicCapture`'s 100 ms cadence — **forty
         * missed chunks**. That is the number the threshold is really chosen
         * against. Forty consecutive chunks is far past anything a thread
         * scheduling hiccup, a GC pause or a moment of CPU contention can
         * explain, so a healthy recording is never torn down and rebuilt on a
         * false alarm. And it is near enough that when capture really has died
         * the hole in the audio is four seconds long instead of the rest of the
         * meeting.
         */
        const val DEFAULT_STALLED_AFTER_MILLIS = 4_000L

        /** The parameters every Parley capture uses. */
        val STANDARD = CaptureWatchdog()
    }
}
