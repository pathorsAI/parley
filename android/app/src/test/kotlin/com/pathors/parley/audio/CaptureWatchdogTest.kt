package com.pathors.parley.audio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The watchdog is the only thing that notices a microphone that was taken away
 * without saying so — Android 10 and later feed a silenced app silence rather
 * than an error — so its two failure modes are opposite and both bad: too eager
 * and it rebuilds healthy recordings, too timid or too talkative and it either
 * misses the outage or makes recovery impossible. Both edges are pinned here.
 */
class CaptureWatchdogTest {

    private val watchdog = CaptureWatchdog()

    // ------------------------------------------------------------- the boundary

    /**
     * The boundary is exclusive: at exactly [CaptureWatchdog.stalledAfterMillis]
     * (4 000 ms at the defaults) capture is still healthy, and only 4 001 ms is
     * a stall. Pinned because this is the number that decides whether an ordinary
     * scheduling hiccup tears down a working recording.
     */
    @Test
    fun fourSecondsIsHealthyAndFourSecondsAndOneMillisecondIsAStall() {
        assertFalse(watchdog.isStalled(nowMillis = 14_000, lastChunkAtMillis = 10_000))
        assertTrue(watchdog.isStalled(nowMillis = 14_001, lastChunkAtMillis = 10_000))
    }

    /**
     * The ordinary case: chunks arriving every 100 ms as `MicCapture` produces
     * them. Nothing the watchdog sees during a healthy recording may ever look
     * like a stall.
     */
    @Test
    fun aRecordingDeliveringChunksIsNeverStalled() {
        var last = 1_000L
        repeat(200) {
            last += 100
            assertFalse(
                "chunk $it",
                watchdog.isStalled(nowMillis = last + 50, lastChunkAtMillis = last),
            )
        }
    }

    // ------------------------------------------------------- non-stalls by rule

    /**
     * Nothing has arrived yet. There is a real window between
     * `AudioRecord.startRecording()` and the first chunk, and treating "has not
     * started" as "has died" would tear down and rebuild every recording four
     * seconds in, before it had produced a single sample.
     */
    @Test
    fun nothingHavingArrivedYetIsNotAStall() {
        assertFalse(watchdog.isStalled(nowMillis = 1_000_000, lastChunkAtMillis = 0L))
        assertFalse(watchdog.shouldProbe(1_000_000, 0L, recovering = false, givenUp = false))
    }

    /**
     * The clock moved backwards — an NTP correction, the user changing the time,
     * or a monotonic source reading oddly across a suspend. A negative elapsed
     * time must not fall through into the comparison, and must certainly not be
     * read as an enormous gap.
     */
    @Test
    fun aClockThatWentBackwardsIsNotAStall() {
        assertFalse(watchdog.isStalled(nowMillis = 5_000, lastChunkAtMillis = 10_000))
        assertFalse(watchdog.isStalled(nowMillis = 10_000, lastChunkAtMillis = 10_000))
        assertFalse(watchdog.shouldProbe(5_000, 10_000, recovering = false, givenUp = false))
    }

    // ----------------------------------------------------------------- the gate

    /** A genuine stall with nothing suppressing it is what the watchdog is for. */
    @Test
    fun aGenuineStallWithNeitherFlagSetDoesProbe() {
        assertTrue(watchdog.shouldProbe(20_000, 10_000, recovering = false, givenUp = false))
    }

    /**
     * A recovery in flight has no chunks arriving by definition, so "stalled"
     * stays true for the whole of it. A watchdog allowed to speak during one
     * would fire every two seconds and knock the backoff ladder back to its
     * first rung each time — so the recovery would retry forever at two-second
     * intervals, never reach the attempt that would have worked, and look from
     * the outside exactly like a recovery that is trying hard.
     */
    @Test
    fun aRecoveryInFlightSuppressesAnOtherwiseGenuineStall() {
        assertTrue(
            "the stall itself is real",
            watchdog.isStalled(nowMillis = 20_000, lastChunkAtMillis = 10_000),
        )
        assertFalse(watchdog.shouldProbe(20_000, 10_000, recovering = true, givenUp = false))
    }

    /**
     * Once the ladder is spent, probing a microphone that is presumed gone every
     * two seconds for the remaining ninety minutes of the meeting costs battery
     * and a stream of state churn and buys nothing. What revives a given-up
     * capture is an event that announces itself, not another poll.
     */
    @Test
    fun havingGivenUpSuppressesAnOtherwiseGenuineStall() {
        assertFalse(watchdog.shouldProbe(20_000, 10_000, recovering = false, givenUp = true))
    }

    /** Each flag suppresses on its own, and the two together do too. */
    @Test
    fun bothFlagsTogetherAlsoSuppress() {
        assertFalse(watchdog.shouldProbe(20_000, 10_000, recovering = true, givenUp = true))
    }

    /** The flags suppress; they do not manufacture a stall that is not there. */
    @Test
    fun clearingTheFlagsDoesNotMakeAHealthyCaptureProbe() {
        assertFalse(watchdog.shouldProbe(10_500, 10_000, recovering = false, givenUp = false))
    }

    // --------------------------------------------------------------- the tuning

    /**
     * The defaults are chosen against `MicCapture`'s 100 ms chunk cadence: four
     * seconds is two missed checks and **forty missed chunks**. Forty in a row is
     * far past anything a GC pause or CPU contention explains, and near enough
     * that a real outage leaves a four-second hole rather than the rest of the
     * meeting.
     */
    @Test
    fun theDefaultsAreTwoChecksAndFortyChunks() {
        assertEquals(2_000L, watchdog.checkIntervalMillis)
        assertEquals(4_000L, watchdog.stalledAfterMillis)
        assertEquals(2L, watchdog.stalledAfterMillis / watchdog.checkIntervalMillis)
        assertEquals(40L, watchdog.stalledAfterMillis / 100L)
    }

    // ------------------------------------------------------------ configuration

    @Test
    fun aStallShorterThanTheCheckIntervalIsRejected() {
        // The watchdog would only ever catch such a stall by luck: the window in
        // which it is true can close between two consecutive checks.
        assertThrows(IllegalArgumentException::class.java) {
            CaptureWatchdog(checkIntervalMillis = 5_000, stalledAfterMillis = 1_000)
        }
    }

    @Test
    fun nonPositiveTimingsAreRejected() {
        assertThrows(IllegalArgumentException::class.java) {
            CaptureWatchdog(checkIntervalMillis = 0)
        }
        assertThrows(IllegalArgumentException::class.java) {
            CaptureWatchdog(checkIntervalMillis = -2_000)
        }
        assertThrows(IllegalArgumentException::class.java) {
            CaptureWatchdog(checkIntervalMillis = 1_000, stalledAfterMillis = 0)
        }
    }

    @Test
    fun anEqualIntervalAndDeadlineIsAllowed() {
        // Checking as often as the deadline is aggressive but coherent.
        val tight = CaptureWatchdog(checkIntervalMillis = 1_000, stalledAfterMillis = 1_000)
        assertFalse(tight.isStalled(nowMillis = 2_000, lastChunkAtMillis = 1_000))
        assertTrue(tight.isStalled(nowMillis = 2_001, lastChunkAtMillis = 1_000))
    }
}
