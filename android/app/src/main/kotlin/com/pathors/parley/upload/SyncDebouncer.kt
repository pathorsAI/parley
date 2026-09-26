package com.pathors.parley.upload

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/**
 * Decides when "the network came back" or "the app came back" should start a
 * sync pass — the upload queue, then the backfill queue.
 *
 * The passes themselves are already serialized by their own mutexes, so two of
 * them can never overlap. What this guards against is the other failure: a
 * network that flaps (a train, a lift, a weak Wi-Fi edge) announcing itself a
 * dozen times a minute and queueing a dozen passes behind that mutex, each of
 * which makes its own round of attempts against a connection that is about to
 * drop again. So:
 *
 * - **Settle.** A network has to stay up for [settleMs] before it triggers a
 *   pass; losing it inside that window cancels the pass it would have started.
 * - **Online is a set, not a flag.** Wi-Fi and cellular are separate networks
 *   with separate callbacks. Only the transition from *no* validated network to
 *   *some* validated network is a reconnection; a second network arriving while
 *   the first is up is not, and losing one of two is not going offline.
 * - **Spacing.** Passes start at least [minIntervalMs] apart, whatever asked for
 *   them. A request inside that window is deferred to its end, not dropped, so
 *   the last reconnection in a burst still gets its pass.
 * - **Coalescing.** While a pass is scheduled, further requests join it.
 *
 * The clock starts at construction as if a pass had just run: the app drains on
 * launch by itself, and the network callback's first "available" arrives a
 * moment later — that is not a reconnection worth a second pass.
 *
 * Platform-free on purpose (the network is any key, the clock and the scope are
 * injected) so the timing can be tested with virtual time. [AutoSync] is the
 * Android glue that feeds it.
 */
class SyncDebouncer(
    private val scope: CoroutineScope,
    private val now: () -> Long,
    private val settleMs: Long = DEFAULT_SETTLE_MS,
    private val minIntervalMs: Long = DEFAULT_MIN_INTERVAL_MS,
    /** Start a pass. [reason] is for the log: what asked for it first. */
    private val sync: suspend (reason: String) -> Unit,
) {
    private val lock = Any()
    private val online = HashSet<Any>()
    private var scheduled: Job? = null
    private var lastStartedAt: Long = now()

    /** A network with validated internet appeared. */
    fun networkAvailable(network: Any) = synchronized(lock) {
        val wasOffline = online.isEmpty()
        online += network
        if (wasOffline) schedule(REASON_NETWORK, settleMs)
    }

    /** A network went away, or stopped being validated. */
    fun networkLost(network: Any) = synchronized(lock) {
        online -= network
        if (online.isEmpty()) {
            // Offline now: a pass that has not started yet would only fail.
            scheduled?.cancel()
            scheduled = null
        }
    }

    /**
     * The app came to the foreground. No settle — the user is here now — but
     * the same spacing and coalescing as a reconnection.
     */
    fun foregrounded() = synchronized(lock) {
        schedule(REASON_FOREGROUND, 0L)
    }

    private fun schedule(reason: String, settle: Long) {
        if (scheduled?.isActive == true) return
        val wait = maxOf(settle, lastStartedAt + minIntervalMs - now())
        scheduled = scope.launch {
            delay(wait)
            synchronized(lock) {
                // Cancelled by [networkLost] between the delay and the lock.
                ensureActive()
                lastStartedAt = now()
                scheduled = null
            }
            sync(reason)
        }
    }

    companion object {
        /** How long a network must stay up before it counts as back. */
        const val DEFAULT_SETTLE_MS = 3_000L

        /** The least time between two passes started by these triggers. */
        const val DEFAULT_MIN_INTERVAL_MS = 30_000L

        const val REASON_NETWORK = "network"
        const val REASON_FOREGROUND = "foreground"
    }
}
