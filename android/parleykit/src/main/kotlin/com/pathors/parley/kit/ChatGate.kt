package com.pathors.parley.kit

import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import kotlin.random.Random
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

/**
 * An HTTP failure as far as retrying it is concerned. The app's
 * `CloudException` implements it; this module cannot see that class.
 */
interface HttpStatusFailure {
    val httpStatus: Int

    /** The response's `Retry-After`, in milliseconds from when it arrived, if it sent one. */
    val retryAfterMs: Long?
}

/** `Retry-After` in either of its two forms: delta-seconds or an HTTP-date. */
object RetryAfter {
    fun parseMs(value: String?, nowMs: Long = System.currentTimeMillis()): Long? {
        val text = value?.trim().orEmpty()
        if (text.isEmpty()) return null
        text.toLongOrNull()?.let { return if (it >= 0) it * MS_PER_SECOND else null }
        val at = runCatching { ZonedDateTime.parse(text, DateTimeFormatter.RFC_1123_DATE_TIME) }.getOrNull()
            ?: return null
        return (at.toInstant().toEpochMilli() - nowMs).coerceAtLeast(0)
    }

    private const val MS_PER_SECOND = 1_000L
}

/**
 * When a failed chat call is worth sending again, and after how long.
 *
 * - **429** (`rate_limited`): up to [maxRateLimitRetries] times, after the
 *   server's `Retry-After` when it sent one (capped at [maxRetryAfterMs]),
 *   otherwise after an exponential backoff.
 * - **502 / 503**: up to [maxGatewayRetries] times, exponential backoff.
 * - Anything else: never — a 4xx fails the same way forever, a timeout has
 *   already cost its wait, and a transport failure is the caller's to judge.
 *
 * Every backoff carries jitter so phones that were refused together do not
 * come back together.
 */
class ChatRetryPolicy(
    val maxRateLimitRetries: Int = 3,
    val maxGatewayRetries: Int = 2,
    private val baseDelayMs: Long = 1_000,
    private val maxDelayMs: Long = 20_000,
    private val maxRetryAfterMs: Long = 60_000,
    private val random: () -> Double = Random.Default::nextDouble,
) {
    /** How long to wait before retry number [retriesSoFar] + 1, or null to give up. */
    fun delayBeforeRetry(failure: Throwable, retriesSoFar: Int): Long? {
        val http = failure as? HttpStatusFailure ?: return null
        return when (http.httpStatus) {
            TOO_MANY_REQUESTS -> rateLimitDelay(http, retriesSoFar)
            BAD_GATEWAY, SERVICE_UNAVAILABLE -> backoff(retriesSoFar).takeIf { retriesSoFar < maxGatewayRetries }
            else -> null
        }
    }

    private fun rateLimitDelay(http: HttpStatusFailure, retriesSoFar: Int): Long? {
        if (retriesSoFar >= maxRateLimitRetries) return null
        val asked = http.retryAfterMs ?: return backoff(retriesSoFar)
        return asked.coerceIn(0, maxRetryAfterMs) + (random() * baseDelayMs / 2).toLong()
    }

    /** Exponential, capped, with "equal jitter": half fixed, half random. */
    internal fun backoff(retriesSoFar: Int): Long {
        val exponential = (baseDelayMs shl retriesSoFar.coerceIn(0, MAX_SHIFT)).coerceAtMost(maxDelayMs)
        val half = exponential / 2
        return half + (random() * half).toLong()
    }

    companion object {
        const val TOO_MANY_REQUESTS = 429
        const val BAD_GATEWAY = 502
        const val SERVICE_UNAVAILABLE = 503
        private const val MAX_SHIFT = 16
    }
}

/**
 * At most [maxInFlight] chat calls at a time through one gate, each retried by
 * [policy]. Opening a recording starts every analysis stage that is ready at
 * once, and several recordings can be open in a session, so without this the
 * phone could put a burst of long model calls on the proxy and, when refused,
 * resend them all together.
 *
 * The permit is held across a call's backoff on purpose: a refused call waiting
 * its turn must not let another one through in its place.
 */
class ChatGate(
    maxInFlight: Int = DEFAULT_MAX_IN_FLIGHT,
    private val policy: ChatRetryPolicy = ChatRetryPolicy(),
    private val sleep: suspend (Long) -> Unit = { delay(it) },
) {
    private val permits = Semaphore(maxInFlight)

    suspend fun <T> run(call: suspend () -> T): T = permits.withPermit { withRetries(call) }

    private suspend fun <T> withRetries(call: suspend () -> T): T {
        var retries = 0
        while (true) {
            try {
                return call()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val wait = policy.delayBeforeRetry(e, retries) ?: throw e
                retries++
                sleep(wait)
            }
        }
    }

    companion object {
        const val DEFAULT_MAX_IN_FLIGHT = 2
    }
}

/** [this], with every call passed through [gate]. */
fun ChatCompletions.gated(gate: ChatGate): ChatCompletions = ChatCompletions { requestJson, feature ->
    gate.run { chatCompletion(requestJson, feature) }
}
