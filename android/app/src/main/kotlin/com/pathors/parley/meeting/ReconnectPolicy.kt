package com.pathors.parley.meeting

/**
 * The relay reconnect budget: how long to wait before redialling, and when to
 * stop redialling altogether.
 *
 * The budget counts **consecutive** failures, not failures for the life of the
 * recording, and that is the whole point of the type. A meeting held on a train
 * can lose the relay a dozen times and get it back a dozen times; if every one
 * of those drops spent a permanent unit of budget, the transcript would go dark
 * partway through a two-hour call that was never actually in trouble. What the
 * cap is for is the other case — a relay that is genuinely gone — and that case
 * is recognised by failures that *keep* failing. So a completed handshake refills
 * the budget ([recordSuccess]), exactly as iOS does on `connect` succeeding.
 *
 * Nothing here touches the recording: a relay that never comes back costs the
 * live transcript only, and the cloud transcribes the uploaded audio anyway.
 *
 * Synchronized because the events collector and the reconnect job both reach it
 * from whichever thread the session's dispatcher gave them.
 */
class ReconnectPolicy(
    /**
     * Consecutive failures tolerated before giving up — enough for a genuinely
     * flaky hour, few enough that a relay that is simply gone stops being
     * dialled.
     */
    private val maxAttempts: Int = DEFAULT_MAX_ATTEMPTS,
    private val baseDelayMs: Long = DEFAULT_BASE_DELAY_MS,
    private val maxDelayMs: Long = DEFAULT_MAX_DELAY_MS,
) {
    init {
        require(maxAttempts >= 0) { "maxAttempts must not be negative (got $maxAttempts)" }
        require(baseDelayMs > 0) { "baseDelayMs must be positive (got $baseDelayMs)" }
        require(maxDelayMs >= baseDelayMs) {
            "maxDelayMs ($maxDelayMs) must not be shorter than baseDelayMs ($baseDelayMs)"
        }
    }

    /** Failures since the last successful handshake. */
    @get:Synchronized
    var consecutiveFailures: Int = 0
        private set

    /**
     * Take one attempt from the budget.
     *
     * @return how long to wait before dialling again — 1 s, 2 s, 4 s, 8 s …
     *   capped at [maxDelayMs]; long enough not to hammer a relay that is down,
     *   short enough that walking back into Wi-Fi picks up quickly. Null when the
     *   budget is spent and the session should stop trying.
     */
    @Synchronized
    fun nextDelayMs(): Long? {
        if (consecutiveFailures >= maxAttempts) return null
        consecutiveFailures += 1
        // Clamped before the shift: a large maxAttempts would otherwise roll the
        // sign bit round and hand back a negative delay.
        val steps = (consecutiveFailures - 1).coerceIn(0, MAX_BACKOFF_STEPS)
        return minOf(maxDelayMs, baseDelayMs shl steps)
    }

    /**
     * A handshake completed. The ladder starts from the bottom again and the
     * budget is whole, because whatever went wrong before demonstrably passed.
     */
    @Synchronized
    fun recordSuccess() {
        consecutiveFailures = 0
    }

    companion object {
        const val DEFAULT_MAX_ATTEMPTS = 8
        const val DEFAULT_BASE_DELAY_MS = 1_000L
        const val DEFAULT_MAX_DELAY_MS = 15_000L

        /** Shift ceiling; well past where [DEFAULT_MAX_DELAY_MS] clamps anyway. */
        private const val MAX_BACKOFF_STEPS = 20
    }
}
