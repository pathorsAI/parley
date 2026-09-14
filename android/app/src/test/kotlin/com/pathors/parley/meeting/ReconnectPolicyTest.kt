package com.pathors.parley.meeting

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/** The backoff ladder, and the reset that makes the budget mean what it says. */
class ReconnectPolicyTest {

    private fun ladder(policy: ReconnectPolicy, steps: Int): List<Long?> =
        (0 until steps).map { policy.nextDelayMs() }

    @Test
    fun backoffDoublesAndThenHoldsAtTheCeiling() {
        val policy = ReconnectPolicy()
        assertEquals(
            listOf(1_000L, 2_000L, 4_000L, 8_000L, 15_000L, 15_000L, 15_000L, 15_000L),
            ladder(policy, 8),
        )
    }

    @Test
    fun theBudgetIsSpentAfterTheCap() {
        val policy = ReconnectPolicy(maxAttempts = 3)
        repeat(3) { assertNotNull(policy.nextDelayMs()) }
        assertNull("a relay that is simply gone must stop being dialled", policy.nextDelayMs())
        assertNull(policy.nextDelayMs())
    }

    /**
     * The bug this type was extracted for: nothing ever reset the counter, so a
     * two-hour meeting that reconnected successfully eight times over its length
     * gave up on transcription for good — even though every one of those eight
     * drops had been recovered from.
     */
    @Test
    fun aSuccessfulHandshakeRefillsTheBudget() {
        val policy = ReconnectPolicy(maxAttempts = 8)
        repeat(20) {
            // Drop, redial, reconnect — over and over, as a train journey does.
            assertNotNull("attempt $it must still be allowed", policy.nextDelayMs())
            policy.recordSuccess()
        }
    }

    @Test
    fun aSuccessfulHandshakeAlsoRestartsTheLadderFromTheBottom() {
        val policy = ReconnectPolicy()
        repeat(4) { policy.nextDelayMs() } // 1 s, 2 s, 4 s, 8 s
        policy.recordSuccess()
        assertEquals(0, policy.consecutiveFailures)
        assertEquals(1_000L, policy.nextDelayMs())
    }

    @Test
    fun onlyConsecutiveFailuresCount() {
        val policy = ReconnectPolicy(maxAttempts = 2)
        policy.nextDelayMs()
        policy.recordSuccess()
        policy.nextDelayMs()
        policy.recordSuccess()
        // Two failures have happened, but never two in a row.
        assertNotNull(policy.nextDelayMs())
        assertNotNull(policy.nextDelayMs())
        assertNull(policy.nextDelayMs())
    }

    @Test
    fun aGenerousBudgetStillProducesSaneDelays() {
        // The shift must not be allowed to run away and wrap into a negative.
        val policy = ReconnectPolicy(maxAttempts = 64, maxDelayMs = 30_000)
        repeat(64) {
            val delay = policy.nextDelayMs()
            assertNotNull(delay)
            assertEquals(true, delay!! in 1_000L..30_000L)
        }
    }

    @Test
    fun aFreshPolicyHasNoFailuresBehindIt() {
        assertEquals(0, ReconnectPolicy().consecutiveFailures)
    }
}
