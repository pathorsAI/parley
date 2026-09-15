package com.pathors.parley.kit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The liveness numbers, and the one piece of arithmetic between them and
 * OkHttp's single `pingInterval` knob.
 */
class RelayLivenessTest {

    @Test
    fun standardMatchesTheIosParameters() {
        val liveness = RelayLiveness.STANDARD
        assertEquals(5_000L, liveness.pingIntervalMs)
        assertEquals(15_000L, liveness.deadlineMs)
    }

    @Test
    fun pingsAreOnAtAllWhichIsTheWholePoint() {
        // Zero is what the client used to pass, and it is what let a half-open
        // socket stay "connected" until the process died.
        assertTrue(RelayLiveness.STANDARD.okHttpPingIntervalMs > 0)
    }

    @Test
    fun aDeadPeerIsNoticedInsideTheDeadline() {
        // OkHttp pings every interval and fails when a pong misses by one
        // interval, so detection can take two of them.
        val liveness = RelayLiveness.STANDARD
        assertTrue(
            "worst case ${liveness.worstCaseDetectionMs}ms must fit in ${liveness.deadlineMs}ms",
            liveness.worstCaseDetectionMs <= liveness.deadlineMs,
        )
    }

    @Test
    fun theIntervalIsClampedToHalfTheDeadline() {
        // A cadence slower than half the deadline would let the worst case
        // overshoot it, so it is clamped rather than taken literally.
        val eager = RelayLiveness(pingIntervalMs = 12_000, deadlineMs = 15_000)
        assertEquals(7_500L, eager.okHttpPingIntervalMs)
        assertTrue(eager.worstCaseDetectionMs <= eager.deadlineMs)
    }

    @Test
    fun aFasterCadenceThanTheClampIsHonoured() {
        val brisk = RelayLiveness(pingIntervalMs = 1_000, deadlineMs = 15_000)
        assertEquals(1_000L, brisk.okHttpPingIntervalMs)
    }

    @Test
    fun theIntervalNeverRoundsDownToNothing() {
        // `deadline / 2` is integer division; a one-millisecond deadline must
        // still produce a ping interval OkHttp reads as "on".
        val absurd = RelayLiveness(pingIntervalMs = 1, deadlineMs = 1)
        assertTrue(absurd.okHttpPingIntervalMs > 0)
    }

    @Test(expected = IllegalArgumentException::class)
    fun aDeadlineShorterThanTheCadenceIsRejected() {
        RelayLiveness(pingIntervalMs = 10_000, deadlineMs = 5_000)
    }

    @Test(expected = IllegalArgumentException::class)
    fun aZeroCadenceIsRejected() {
        RelayLiveness(pingIntervalMs = 0, deadlineMs = 5_000)
    }
}
