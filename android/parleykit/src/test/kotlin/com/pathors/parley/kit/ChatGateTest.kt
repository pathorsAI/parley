package com.pathors.parley.kit

import java.io.IOException
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatGateTest {

    private class HttpFailure(override val httpStatus: Int, override val retryAfterMs: Long? = null) :
        IOException("http $httpStatus"), HttpStatusFailure

    /** Jitter pinned to its midpoint, so delays are exact. */
    private val policy = ChatRetryPolicy(baseDelayMs = 1_000, maxDelayMs = 8_000, random = { 0.5 })

    // ── the policy ───────────────────────────────────────────────────────────

    @Test
    fun `a 429 waits what Retry-After asked for`() {
        assertEquals(5_250L, policy.delayBeforeRetry(HttpFailure(429, retryAfterMs = 5_000), 0))
    }

    @Test
    fun `an absurd Retry-After is capped`() {
        assertEquals(60_250L, policy.delayBeforeRetry(HttpFailure(429, retryAfterMs = 3_600_000), 0))
    }

    @Test
    fun `a 429 without Retry-After backs off exponentially, capped`() {
        val delays = (0..2).map { policy.delayBeforeRetry(HttpFailure(429), it) }
        assertEquals(listOf(750L, 1_500L, 3_000L), delays)
        assertEquals(6_000L, policy.backoff(10))
    }

    @Test
    fun `jitter stays between half and all of the backoff`() {
        val low = ChatRetryPolicy(baseDelayMs = 1_000, random = { 0.0 })
        val high = ChatRetryPolicy(baseDelayMs = 1_000, random = { 0.999 })
        assertEquals(2_000L, low.backoff(2))
        assertTrue(high.backoff(2) in 3_990L..4_000L)
    }

    @Test
    fun `429 retries are bounded`() {
        assertNull(policy.delayBeforeRetry(HttpFailure(429), policy.maxRateLimitRetries))
    }

    @Test
    fun `a 502 is retried at most twice`() {
        assertEquals(750L, policy.delayBeforeRetry(HttpFailure(502), 0))
        assertEquals(1_500L, policy.delayBeforeRetry(HttpFailure(502), 1))
        assertNull(policy.delayBeforeRetry(HttpFailure(502), 2))
    }

    @Test
    fun `client errors and transport failures are not retried`() {
        assertNull(policy.delayBeforeRetry(HttpFailure(400), 0))
        assertNull(policy.delayBeforeRetry(HttpFailure(402), 0))
        assertNull(policy.delayBeforeRetry(HttpFailure(504), 0))
        assertNull(policy.delayBeforeRetry(IOException("reset"), 0))
    }

    @Test
    fun `Retry-After parses seconds and HTTP dates`() {
        assertEquals(30_000L, RetryAfter.parseMs("30"))
        assertEquals(
            10_000L,
            RetryAfter.parseMs("Wed, 21 Oct 2015 07:28:10 GMT", nowMs = 1_445_412_480_000L),
        )
        assertNull(RetryAfter.parseMs(null))
        assertNull(RetryAfter.parseMs("soon"))
        assertNull(RetryAfter.parseMs("-4"))
    }

    // ── the gate ─────────────────────────────────────────────────────────────

    @Test
    fun `a rate-limited call is retried after the wait and then succeeds`() = runTest {
        val waits = mutableListOf<Long>()
        val gate = ChatGate(policy = policy, sleep = { waits += it })
        var calls = 0

        val answer = gate.run {
            calls++
            if (calls < 3) throw HttpFailure(429, retryAfterMs = 2_000)
            "ok"
        }

        assertEquals("ok", answer)
        assertEquals(3, calls)
        assertEquals(listOf(2_250L, 2_250L), waits)
    }

    @Test
    fun `a persistent 502 gives up after its retries`() = runTest {
        val gate = ChatGate(policy = policy, sleep = {})
        var calls = 0

        val thrown = runCatching { gate.run { calls++; throw HttpFailure(502) } }.exceptionOrNull()

        assertTrue(thrown is HttpFailure)
        assertEquals(1 + policy.maxGatewayRetries, calls)
    }

    @Test
    fun `no more than two calls are in flight at once`() = runTest {
        val gate = ChatGate(maxInFlight = 2, policy = policy, sleep = {})
        val inFlight = AtomicInteger()
        var peak = 0
        val release = CompletableDeferred<Unit>()

        val calls = (1..6).map {
            async {
                gate.run {
                    peak = maxOf(peak, inFlight.incrementAndGet())
                    release.await()
                    inFlight.decrementAndGet()
                }
            }
        }
        runCurrent()
        assertEquals(2, inFlight.get())
        release.complete(Unit)
        calls.awaitAll()

        assertEquals(2, peak)
    }
}
