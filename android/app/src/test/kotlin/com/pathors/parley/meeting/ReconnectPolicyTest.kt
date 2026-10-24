package com.pathors.parley.meeting

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

private const val ONE_SECOND = 1_000L
private const val MINUTE = 60_000L
private const val STABLE = 30_000L

/** The reconnect ladder: capped, jittered, never exhausted, and reset only by a leg that held. */
class ReconnectPolicyTest {

    private var clock = 0L

    /** Jitter pinned to zero, so every delay is its rung's ceiling. */
    private fun policy(random: () -> Double = { 0.0 }) =
        ReconnectPolicy(random = random, now = { clock })

    private fun ladder(policy: ReconnectPolicy, steps: Int): List<Long> =
        (0 until steps).map { policy.nextDelayMs() }

    @Test
    fun backoffDoublesAndThenHoldsAtTheOneMinuteCeiling() {
        assertEquals(
            listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 32_000L, MINUTE, MINUTE, MINUTE),
            ladder(policy(), 9),
        )
    }

    /**
     * The bug: eight failures and the meeting's live transcript was over, for
     * the rest of a three-hour recording. A relay that is down for a while
     * must still be redialled once a minute for as long as the meeting runs.
     */
    @Test
    fun itNeverGivesUp() {
        val policy = policy()
        val delays = ladder(policy, 500)
        assertTrue(delays.all { it in ONE_SECOND..MINUTE })
        assertEquals(MINUTE, delays.last())
        assertEquals(500, policy.consecutiveFailures)
    }

    @Test
    fun jitterStaysInTheTopHalfOfTheRung() {
        val low = policy(random = { 1.0 })
        val delays = ladder(low, 8)
        val ceilings = (1..8).map { low.ceilingFor(it) }
        delays.zip(ceilings).forEach { (delay, ceiling) ->
            assertTrue("$delay within [${ceiling / 2}, $ceiling]", delay in (ceiling / 2)..ceiling)
        }
        assertEquals(MINUTE / 2, delays.last())
    }

    @Test
    fun aRandomOutOfRangeCannotProduceANegativeDelay() {
        val delays = ladder(policy(random = { 5.0 }), 3)
        assertTrue(delays.all { it > 0 })
    }

    /**
     * The "reconnecting every ~15 s" bursts: a relay that accepts the
     * handshake and drops the leg straight away used to reset the ladder on
     * every handshake, so it was redialled at 1 s for ever. A leg has to hold.
     */
    @Test
    fun aHandshakeThatDiesQuicklyDoesNotResetTheLadder() {
        val policy = policy()
        ladder(policy, 3) // 1 s, 2 s, 4 s
        policy.recordSuccess()
        clock += STABLE - 1
        assertEquals(8_000L, policy.nextDelayMs())
        assertEquals(4, policy.consecutiveFailures)
    }

    @Test
    fun aLegThatHeldStartsTheLadderAgain() {
        val policy = policy()
        ladder(policy, 5)
        policy.recordSuccess()
        clock += STABLE
        assertEquals(ONE_SECOND, policy.nextDelayMs())
        assertEquals(1, policy.consecutiveFailures)
    }

    @Test
    fun repeatedSuccessReportsForOneLegKeepTheFirstHandshakeTime() {
        val policy = policy()
        policy.nextDelayMs()
        policy.recordSuccess()
        clock += STABLE / 2
        policy.recordSuccess()
        clock += STABLE / 2
        assertEquals("the leg was up for the full window", ONE_SECOND, policy.nextDelayMs())
    }

    @Test
    fun aFreshPolicyHasNoFailuresBehindIt() {
        assertEquals(0, ReconnectPolicy().consecutiveFailures)
    }
}
