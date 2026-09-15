package com.pathors.parley.kit

/**
 * When to stop believing a relay socket that has gone quiet.
 *
 * The case this exists for is the **half-open** connection: the radio dropped,
 * or a middlebox forgot us, and no FIN ever arrived. Writes are still accepted —
 * they go into a queue that will never drain — reads never complete, and nothing
 * in the stack reports an error. Left alone, such a socket stays "connected" for
 * as long as the process lives.
 *
 * ## Why the application keepalive does not detect it
 *
 * The Soniox keepalive ([SonioxProtocol.KEEPALIVE_INTERVAL_MS], 2 s) exists to
 * stop the *provider* timing an idle session out. It travels end to end and is
 * never answered, so sending it into a dead socket looks exactly like sending it
 * into a live one. A WebSocket **ping** is different: the peer's stack answers
 * it whether or not anyone is speaking, so the absence of pongs is a signal.
 * The two coexist — neither replaces the other.
 *
 * ## Mapping to OkHttp
 *
 * iOS drives this by hand (`ios/ParleyKit/Sources/ParleyKit/RelayLiveness.swift`
 * — ping every 5 s, declare the peer gone after 15 s of silence). OkHttp has one
 * knob, not two: it pings every `pingInterval` and fails the connection when a
 * pong does not come back within that same interval. A peer that dies just after
 * a ping is therefore noticed somewhere between one and **two** intervals later,
 * which is why [okHttpPingIntervalMs] is clamped to half the deadline: it keeps
 * the worst case inside [deadlineMs] while pinging no more often than iOS does.
 *
 * @property pingIntervalMs how often to ask the socket to prove it is there.
 * @property deadlineMs silence longer than this means the peer is gone. Three
 *   missed pings at the default cadence: two would be one rough network away
 *   from cutting a healthy session, and much more than three leaves a hole
 *   longer than a reconnected leg wants to carry.
 */
data class RelayLiveness(
    val pingIntervalMs: Long = DEFAULT_PING_INTERVAL_MS,
    val deadlineMs: Long = DEFAULT_DEADLINE_MS,
) {
    init {
        require(pingIntervalMs > 0) { "pingIntervalMs must be positive (got $pingIntervalMs)" }
        require(deadlineMs >= pingIntervalMs) {
            "deadlineMs ($deadlineMs) must not be shorter than pingIntervalMs ($pingIntervalMs)"
        }
    }

    /**
     * What to hand `OkHttpClient.Builder.pingInterval`. See the class docs for
     * why this is not simply [pingIntervalMs]: OkHttp's single interval is both
     * the cadence and the pong timeout, so the detection window is up to twice
     * it, and half the deadline is the largest interval that still fits.
     */
    val okHttpPingIntervalMs: Long
        get() = minOf(pingIntervalMs, deadlineMs / 2).coerceAtLeast(1L)

    /** Longest a dead peer can go unnoticed once [okHttpPingIntervalMs] is set. */
    val worstCaseDetectionMs: Long get() = okHttpPingIntervalMs * 2

    companion object {
        const val DEFAULT_PING_INTERVAL_MS = 5_000L
        const val DEFAULT_DEADLINE_MS = 15_000L

        /** The parameters every Parley client uses. */
        val STANDARD = RelayLiveness()
    }
}
