package com.pathors.parley.meeting

import kotlin.random.Random

/**
 * The relay reconnect schedule: how long to wait before redialling.
 *
 * There is no budget any more. Until Android 1.21 this gave up after eight
 * consecutive failures, and a meeting whose relay was down for a few minutes —
 * an elevator, a basement, a relay deploy — had no live transcript for the rest
 * of its three hours. Redialling a relay that is down costs one handshake a
 * minute; giving up costs the whole meeting's live transcript. So the session
 * keeps dialling for as long as it records, on a capped exponential ladder with
 * jitter, and the cap ([maxDelayMs], 60 s) is what keeps a relay that is simply
 * gone from being hammered.
 *
 * Out of quota is the one thing reconnecting cannot fix, and the session stops
 * on that itself (`SttRelayEvent.QuotaExceeded`) without asking this type.
 *
 * ## When the ladder starts again
 *
 * A handshake that completes is not, on its own, proof the relay is back: a
 * relay that accepts the upgrade and then closes the socket a second later
 * looked healthy to the old rule, which reset the ladder to 1 s on every
 * handshake — and that is the "reconnecting every ~15 s" burst seen in the
 * field. Now a leg has to stay up for [stableAfterMs] before the ladder starts
 * from the bottom again; a leg that dies sooner keeps climbing.
 *
 * ## Jitter
 *
 * Every delay is drawn from the upper half of its rung (`ceiling/2 … ceiling`),
 * so phones that lost the relay together — a relay deploy drops everyone at once
 * — do not all come back in the same second.
 *
 * Nothing here touches the recording: the microphone writes the audio file
 * whatever the relay does, and what fills a live-transcript gap afterwards is
 * this app's own backfill (`TranscriptCoverage` measures what came back against
 * the audio and re-transcribes from the file when it falls short).
 *
 * Synchronized because the events collector and the reconnect job both reach it
 * from whichever thread the session's dispatcher gave them.
 */
class ReconnectPolicy(
    private val baseDelayMs: Long = DEFAULT_BASE_DELAY_MS,
    private val maxDelayMs: Long = DEFAULT_MAX_DELAY_MS,
    /** How long a leg must stay up before its handshake counts as recovery. */
    private val stableAfterMs: Long = DEFAULT_STABLE_AFTER_MS,
    /** Uniform in `[0, 1)`; injectable so tests can pin the jitter. */
    private val random: () -> Double = { Random.nextDouble() },
    /** A monotonic clock in milliseconds. */
    private val now: () -> Long = { System.nanoTime() / NANOS_PER_MILLI },
) {
    init {
        require(baseDelayMs > 0) { "baseDelayMs must be positive (got $baseDelayMs)" }
        require(maxDelayMs >= baseDelayMs) {
            "maxDelayMs ($maxDelayMs) must not be shorter than baseDelayMs ($baseDelayMs)"
        }
        require(stableAfterMs >= 0) { "stableAfterMs must not be negative (got $stableAfterMs)" }
    }

    /** Failures since the relay last proved itself (a leg that stayed up). */
    @get:Synchronized
    var consecutiveFailures: Int = 0
        private set

    /** When the current leg's handshake completed; null while there is no live leg. */
    private var connectedAtMs: Long? = null

    /**
     * The relay dropped (or a dial failed): how long to wait before the next
     * dial. Never null — the session keeps trying for as long as it records.
     *
     * If the leg that just dropped had been up for [stableAfterMs], the ladder
     * starts again from the bottom first.
     */
    @Synchronized
    fun nextDelayMs(): Long {
        val connectedAt = connectedAtMs
        connectedAtMs = null
        if (connectedAt != null && now() - connectedAt >= stableAfterMs) consecutiveFailures = 0
        consecutiveFailures += 1
        val ceiling = ceilingFor(consecutiveFailures)
        val jitter = (ceiling * JITTER_FRACTION * random().coerceIn(0.0, 1.0)).toLong()
        return (ceiling - jitter).coerceAtLeast(1L)
    }

    /**
     * A handshake completed. Starts the stability clock; the ladder itself only
     * resets once the leg has outlived [stableAfterMs] (see [nextDelayMs]).
     * Repeated calls for the same leg keep the first time.
     */
    @Synchronized
    fun recordSuccess() {
        if (connectedAtMs == null) connectedAtMs = now()
    }

    /** The un-jittered delay for the [attempt]th consecutive failure (1-based). */
    fun ceilingFor(attempt: Int): Long {
        // Clamped before the shift so a long outage cannot roll the sign bit.
        val steps = (attempt - 1).coerceIn(0, MAX_BACKOFF_STEPS)
        return minOf(maxDelayMs, baseDelayMs shl steps)
    }

    companion object {
        const val DEFAULT_BASE_DELAY_MS = 1_000L
        const val DEFAULT_MAX_DELAY_MS = 60_000L
        const val DEFAULT_STABLE_AFTER_MS = 30_000L

        /** Delays are drawn from the top half of each rung. */
        const val JITTER_FRACTION = 0.5

        private const val NANOS_PER_MILLI = 1_000_000L

        /** Shift ceiling; well past where [DEFAULT_MAX_DELAY_MS] clamps anyway. */
        private const val MAX_BACKOFF_STEPS = 20
    }
}
