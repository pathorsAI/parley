package com.pathors.parley.kit

/**
 * Anything that can accept a chunk of 16 kHz mono s16le PCM from the capture
 * loop without making it wait. [SttRelayClient] is the only production
 * implementation; tests use a recorder.
 *
 * A plain interface rather than a `fun interface` on purpose: SAM conversion
 * would let a lambda passed to [RelayAudioBridge.attach] silently become a
 * sink instead of the leg factory it was written as.
 */
interface PcmSink {
    fun enqueuePcm(bytes: ByteArray)
}

/**
 * Routes microphone chunks to whichever relay leg is current — and **holds
 * them while there is none**. The Kotlin port of iOS
 * `ParleyKit/Sources/ParleyKit/RelayAudioBridge.swift`.
 *
 * A relay session cannot be resumed: the socket carries one Soniox session,
 * and a dropped socket means a fresh leg with its own clock starting at zero
 * (which is what [SttRelayClient.Options.idPrefix] and
 * [SttRelayClient.Options.timeOffsetMs] are for). The gap between the two legs
 * is the interesting part. Without this type it is simply thrown away: the
 * recording keeps a perfect audio file, but the words spoken during a
 * five-second blip never reach the relay and never appear in the live
 * transcript.
 *
 * So the bridge is the capture loop's only counterparty, and it is always
 * there:
 *
 * ```
 * mic ──▶ bridge ──┬── attached  ──▶ current leg
 *                  └── holding   ──▶ ring of held chunks, flushed into the
 *                                    next leg the moment it is created
 * ```
 *
 * ## The clock
 *
 * The bridge counts every sample it is ever handed, so it always knows the
 * position of the audio passing through it ([capturedMilliseconds]). That is
 * the position in the *recording*, not on the wall clock — a microphone rebuild
 * that produced no audio for two seconds moves neither the file nor this
 * counter, so transcript timestamps keep lining up with playback.
 *
 * When a new leg is attached, the offset that leg must use is not "now" — it is
 * the position of the **oldest sample the new leg will actually receive**,
 * which is the front of the hold buffer. Using "now" would place a whole gap's
 * worth of speech in the future, after the audio that follows it.
 *
 * ## The bound
 *
 * Holding is capped ([holdLimitMs]) and overflow drops the *oldest* chunk,
 * which also advances the front of the buffer — so the offset handed to the
 * next leg stays honest about what that leg is being fed. The audio file is
 * written by the encoder before the chunk ever reaches this type and is never
 * at risk here; the worst case is that the live transcript is missing the
 * beginning of a very long outage, which the transcript backfill repairs from
 * the file afterwards.
 *
 * ## Threads
 *
 * One producer: [send] expects the single capture coroutine that feeds it.
 * [attach], [hold], [discard] and [reset] may come from any other thread. The
 * lock is held only for list edits and pointer swaps — never across a flush,
 * so a leg being handed 45 s of held audio cannot make the microphone wait.
 *
 * One deliberate difference from the Swift original: while [attach] flushes
 * the held chunks into the new leg, live chunks keep going into the hold
 * buffer and the flush drains it until it is empty, and only then does the leg
 * start receiving directly. The Swift version swaps the leg in *before*
 * flushing, which leaves a window in which a live chunk can overtake the tail
 * of the gap.
 */
class RelayAudioBridge(
    /** How much audio to keep for the next leg while there is none. */
    val holdLimitMs: Long = DEFAULT_HOLD_LIMIT_MS,
    private val sampleRate: Int = SonioxProtocol.SAMPLE_RATE,
) {
    init {
        require(holdLimitMs >= 0) { "holdLimitMs must not be negative (got $holdLimitMs)" }
        require(sampleRate > 0) { "sampleRate must be positive (got $sampleRate)" }
    }

    private val holdLimitSamples: Long = holdLimitMs * sampleRate / 1000
    private val lock = Any()

    /** The leg audio is flowing to, or null while holding or flushing. */
    private var sink: PcmSink? = null

    /** The leg [attach] is currently flushing into; live audio is held until it is done. */
    private var flushingTo: PcmSink? = null

    /** True between [hold] and the next [attach]/[discard]. */
    private var holding = false
    private val held = ArrayDeque<ByteArray>()
    private var heldSamples = 0L

    /** Samples handed to the bridge since [reset], i.e. the position of the next one. */
    private var totalSamples = 0L

    /** Position of the oldest sample still in [held]. */
    private var heldStartSample = 0L

    // ── capture thread ───────────────────────────────────────────────────────

    /**
     * Hand one chunk to the current leg, or to the hold buffer. Never waits on
     * the socket: the leg's [PcmSink.enqueuePcm] is itself non-blocking, and
     * it is called outside the lock.
     */
    fun send(chunk: ByteArray) {
        val target: PcmSink
        synchronized(lock) {
            totalSamples += samplesIn(chunk)
            val current = sink
            if (current == null) {
                when {
                    // Mid-flush: queue behind the gap, unbounded, because the
                    // offset of the leg being flushed is already fixed and
                    // dropping from the front now would make it a lie. A flush
                    // is a few hundred non-blocking enqueues, so this never
                    // grows by more than a chunk or two.
                    flushingTo != null -> append(chunk)
                    holding -> {
                        append(chunk)
                        trimToLimit()
                    }
                }
                return
            }
            target = current
        }
        target.enqueuePcm(chunk)
    }

    // ── leg lifecycle ────────────────────────────────────────────────────────

    /** Point the bridge at a leg with nothing held (the first connection). */
    fun attach(leg: PcmSink) {
        attach { leg }
    }

    /**
     * Create the next leg and hand it everything held during the gap.
     *
     * [make] receives the timestamp offset that leg must be configured with —
     * the position of the oldest held sample, or the live position when
     * nothing is held. Creating the client inside the call is what makes
     * offset and hand-over one step: no chunk can arrive between computing the
     * offset and the leg existing. Returning null leaves the bridge holding,
     * with nothing lost.
     *
     * @return the leg [make] created, or null.
     */
    fun <L : PcmSink> attach(make: (timeOffsetMs: Long) -> L?): L? {
        var pending: List<ByteArray>
        val next: L
        synchronized(lock) {
            val offsetSamples = if (held.isEmpty()) totalSamples else heldStartSample
            next = make(offsetSamples * 1000 / sampleRate) ?: return null
            pending = takeHeld()
            holding = false
            sink = null
            flushingTo = next
        }
        // Outside the lock: the capture loop must never wait on a flush of up
        // to 45 s of chunks. Anything it sends meanwhile is appended to `held`
        // and picked up by the next pass.
        while (true) {
            for (chunk in pending) next.enqueuePcm(chunk)
            synchronized(lock) {
                // A hold/discard/reset/attach arrived mid-flush: this leg is
                // already history, and whatever is held now belongs to the next.
                if (flushingTo !== next) return next
                if (held.isEmpty()) {
                    flushingTo = null
                    sink = next
                    return next
                }
                pending = takeHeld()
            }
        }
    }

    /**
     * The current leg is gone. Audio from here on is held until the next
     * [attach] — or dropped by [discard] when reconnecting is given up on.
     */
    fun hold() {
        synchronized(lock) {
            sink = null
            flushingTo = null
            holding = true
            heldStartSample = totalSamples - heldSamples
            trimToLimit()
        }
    }

    /**
     * Stop holding and drop what is held: no leg is coming. The bridge stays
     * usable (and keeps counting) so the clock survives for a later attach.
     */
    fun discard() {
        synchronized(lock) {
            sink = null
            flushingTo = null
            holding = false
            clearHeld()
        }
    }

    /** Forget everything, including the clock — a new recording. */
    fun reset() {
        synchronized(lock) {
            sink = null
            flushingTo = null
            holding = false
            clearHeld()
            totalSamples = 0
            heldStartSample = 0
        }
    }

    // ── observation ──────────────────────────────────────────────────────────

    /** Position of the next sample to arrive, in milliseconds since [reset]. */
    val capturedMilliseconds: Long
        get() = synchronized(lock) { totalSamples * 1000 / sampleRate }

    /** How much audio is currently held for the next leg. */
    val heldMilliseconds: Long
        get() = synchronized(lock) { heldSamples * 1000 / sampleRate }

    /** True while there is no leg and audio is being kept for the next one. */
    val isHolding: Boolean
        get() = synchronized(lock) { holding }

    // ── internals (call with the lock held) ──────────────────────────────────

    private fun append(chunk: ByteArray) {
        held.addLast(chunk)
        heldSamples += samplesIn(chunk)
    }

    /**
     * Overflow drops the oldest chunk — and moves the front of the buffer, so
     * the offset the next leg gets still describes the audio it will be fed.
     */
    private fun trimToLimit() {
        while (heldSamples > holdLimitSamples) {
            val first = held.removeFirstOrNull() ?: break
            val n = samplesIn(first)
            heldSamples -= n
            heldStartSample += n
        }
    }

    private fun takeHeld(): List<ByteArray> {
        val taken = held.toList()
        clearHeld()
        return taken
    }

    private fun clearHeld() {
        held.clear()
        heldSamples = 0
        heldStartSample = totalSamples
    }

    private fun samplesIn(chunk: ByteArray): Long = (chunk.size / BYTES_PER_SAMPLE).toLong()

    companion object {
        /**
         * Default hold window. 45 s comfortably covers the reconnect backoff
         * ladder (1, 2, 4, 8, 15, 15 … s) plus a slow handshake on a cold
         * radio, costs at most 16 000 × 2 × 45 ≈ 1.4 MB while full, and still
         * fits inside one [SttRelayClient]'s outbound queue
         * ([SttRelayClient.MAX_QUEUED_CHUNKS] × 100 ms ≈ 51 s), so a flush
         * never makes the new leg drop the front of what it was just handed.
         */
        const val DEFAULT_HOLD_LIMIT_MS = 45_000L

        private const val BYTES_PER_SAMPLE = 2
    }
}
