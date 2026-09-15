package com.pathors.parley.audio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The space check is all boundaries and one division, and every one of them
 * decides something the user cannot undo: whether a meeting is allowed to
 * start, and whether it is stopped in time to save itself. So the boundaries
 * are pinned here exactly, including which side of a threshold an equal value
 * lands on.
 */
class StorageHeadroomTest {

    private val headroom = StorageHeadroom()

    private val mib = 1024L * 1024L

    // ------------------------------------------------------------------- bands

    /**
     * Exactly at the stop threshold the recording keeps going. The thresholds
     * are named "stop *below* four MiB", and reading them any other way would
     * also mean a device parked exactly on a round number flaps between LOW and
     * CRITICAL as the last block is allocated and freed.
     */
    @Test
    fun exactlyAtTheStopThresholdIsStillOnlyLow() {
        assertEquals(
            StorageHeadroom.Headroom.LOW,
            headroom.assess(StorageHeadroom.DEFAULT_STOP_BELOW_BYTES),
        )
        assertEquals(
            StorageHeadroom.Headroom.CRITICAL,
            headroom.assess(StorageHeadroom.DEFAULT_STOP_BELOW_BYTES - 1),
        )
    }

    /** Same rule one band up: exactly at the warn threshold there is no warning. */
    @Test
    fun exactlyAtTheWarnThresholdIsStillAmple() {
        assertEquals(
            StorageHeadroom.Headroom.AMPLE,
            headroom.assess(StorageHeadroom.DEFAULT_WARN_BELOW_BYTES),
        )
        assertEquals(
            StorageHeadroom.Headroom.LOW,
            headroom.assess(StorageHeadroom.DEFAULT_WARN_BELOW_BYTES - 1),
        )
    }

    @Test
    fun aHealthyPhoneIsAmple() {
        // 4 GB free: the overwhelmingly common case, and it must say nothing.
        assertEquals(StorageHeadroom.Headroom.AMPLE, headroom.assess(4L * 1024 * mib))
    }

    @Test
    fun anEmptyDiskIsCritical() {
        assertEquals(StorageHeadroom.Headroom.CRITICAL, headroom.assess(0L))
        assertEquals(StorageHeadroom.Headroom.CRITICAL, headroom.assess(-1L))
    }

    // --------------------------------------------------------------- arithmetic

    /**
     * 24 000 bps is 3 000 bytes per second, so three million bytes is a
     * thousand seconds. Hand-computed on purpose: if the bits/bytes division
     * ever goes the wrong way this is the test that says so, and an eightfold
     * error in either direction would make every threshold above nonsense.
     */
    @Test
    fun threeMegabytesBuysAThousandSeconds() {
        assertEquals(3_000, headroom.bytesPerSecond)
        assertEquals(1_000_000L, headroom.recordableMillis(3_000_000L))
    }

    /** The "1 MiB is about 5.8 minutes" claim the thresholds are argued from. */
    @Test
    fun oneMebibyteIsRoughlySixMinutes() {
        val minutes = headroom.recordableMillis(mib) / 60_000.0
        assertTrue("1 MiB should be ~5.8 min, got $minutes", minutes > 5.7 && minutes < 5.9)
    }

    /**
     * A full disk must not read as a very long recording. `StatFs` on a full
     * volume, or a caller subtracting a reserve it has already earmarked, can
     * hand over zero or a negative — and a negative duration flowing into a
     * countdown or a `>` comparison is how "no space left" silently becomes
     * "plenty of time".
     */
    @Test
    fun noSpaceBuysNoTimeAndNeverNegativeTime() {
        assertEquals(0L, headroom.recordableMillis(0L))
        assertEquals(0L, headroom.recordableMillis(-1L))
        assertEquals(0L, headroom.recordableMillis(Long.MIN_VALUE))
    }

    // ------------------------------------------------------------------- start

    @Test
    fun justBelowTheStartThresholdRefusesAndExactlyAtItAllows() {
        assertFalse(headroom.canStart(StorageHeadroom.DEFAULT_MINIMUM_TO_START_BYTES - 1))
        assertTrue(headroom.canStart(StorageHeadroom.DEFAULT_MINIMUM_TO_START_BYTES))
    }

    /**
     * The start check must not fire on a phone that is fine. The whole value of
     * refusing up front is lost if users learn that the refusal is noise.
     */
    @Test
    fun aPhoneWithRoomForALongMeetingMayStart() {
        assertTrue(headroom.canStart(500L * mib))
        // And the threshold really is worth about three hours.
        val hours = headroom.recordableMillis(
            StorageHeadroom.DEFAULT_MINIMUM_TO_START_BYTES,
        ) / 3_600_000.0
        assertTrue("start threshold should buy ~3 h, got $hours", hours > 3.0 && hours < 3.3)
    }

    // --------------------------------------------------------------- invariants

    /**
     * The invariant the stop threshold exists for: there must still be enough
     * room *to finish*. Closing the Ogg container, writing the manifest and
     * moving the file into the upload queue all need disk, so a stop threshold
     * set to nearly-zero would cut the meeting short **and** fail to save it —
     * the exact outcome the class was written to prevent. Several minutes of
     * slack is the cheap insurance; a number that fails this assertion is a bug
     * even though every other test would still pass.
     */
    @Test
    fun theStopThresholdLeavesEnoughRoomToBeWorthStoppingFor() {
        val remaining = headroom.recordableMillis(StorageHeadroom.DEFAULT_STOP_BELOW_BYTES)
        assertTrue(
            "stopping is pointless if the save cannot fit; only ${remaining / 60_000} min left",
            remaining >= 5 * 60_000L,
        )
    }

    @Test
    fun theBandsAreOrderedTheWayTheThresholdsClaim() {
        assertTrue(
            StorageHeadroom.DEFAULT_STOP_BELOW_BYTES <
                StorageHeadroom.DEFAULT_WARN_BELOW_BYTES,
        )
        assertTrue(
            StorageHeadroom.DEFAULT_WARN_BELOW_BYTES <=
                StorageHeadroom.DEFAULT_MINIMUM_TO_START_BYTES,
        )
    }

    /** The shared instance is the default one; nothing has been tuned by hand. */
    @Test
    fun theStandardInstanceUsesTheEncodersBitrate() {
        assertEquals(OggOpusEncoder.DEFAULT_BITRATE, StorageHeadroom.STANDARD.bitrateBps)
    }

    // ------------------------------------------------------------ configuration

    @Test
    fun aWarningAtOrBelowTheForcedStopIsRejected() {
        // A warning that arrives only once the recording has already been
        // stopped is not a warning, so the configuration is refused outright
        // rather than quietly producing a band that can never be observed.
        assertThrows(IllegalArgumentException::class.java) {
            StorageHeadroom(warnBelowBytes = 4L * mib, stopBelowBytes = 4L * mib)
        }
        assertThrows(IllegalArgumentException::class.java) {
            StorageHeadroom(warnBelowBytes = 2L * mib, stopBelowBytes = 4L * mib)
        }
    }

    @Test
    fun aStartThresholdBelowTheWarningIsRejected() {
        // Otherwise a meeting is allowed to begin in a state that is already LOW.
        assertThrows(IllegalArgumentException::class.java) {
            StorageHeadroom(minimumToStartBytes = 8L * mib, warnBelowBytes = 16L * mib)
        }
    }

    @Test
    fun anImpossibleBitrateIsRejected() {
        // Division by zero, or a negative "recordable" time, rather than a
        // wrong answer that looks plausible.
        assertThrows(IllegalArgumentException::class.java) { StorageHeadroom(bitrateBps = 0) }
        assertThrows(IllegalArgumentException::class.java) { StorageHeadroom(bitrateBps = -24_000) }
    }

    @Test
    fun aNonPositiveStopThresholdIsRejected() {
        assertThrows(IllegalArgumentException::class.java) {
            StorageHeadroom(stopBelowBytes = 0L)
        }
    }

    /** Non-default thresholds are honoured, so a test can use round numbers. */
    @Test
    fun customThresholdsAreUsed() {
        val tiny = StorageHeadroom(
            bitrateBps = 8_000, // 1 000 B/s — a second per kilobyte.
            minimumToStartBytes = 30_000,
            warnBelowBytes = 20_000,
            stopBelowBytes = 10_000,
        )
        assertEquals(1_000, tiny.bytesPerSecond)
        assertEquals(60_000L, tiny.recordableMillis(60_000L))
        assertEquals(StorageHeadroom.Headroom.CRITICAL, tiny.assess(9_999))
        assertEquals(StorageHeadroom.Headroom.LOW, tiny.assess(10_000))
        assertEquals(StorageHeadroom.Headroom.AMPLE, tiny.assess(20_000))
        assertFalse(tiny.canStart(29_999))
        assertTrue(tiny.canStart(30_000))
    }

    /**
     * The one input no filesystem would ever produce, and the only caller that
     * does.
     *
     * `MeetingSession.freeBytesForRecording` answers `Long.MAX_VALUE` when
     * `StatFs` will not say, on the principle that an unknown amount of free
     * space is not a reason to refuse someone their meeting. Every method has to
     * survive that, and in particular none may wrap it into a negative — which
     * would read as "no room at all", the exact opposite of what it means.
     */
    @Test
    fun anUnknownAmountOfFreeSpaceIsTreatedAsPlentyRatherThanAsNone() {
        val headroom = StorageHeadroom.STANDARD

        assertTrue(headroom.canStart(Long.MAX_VALUE))
        assertEquals(StorageHeadroom.Headroom.AMPLE, headroom.assess(Long.MAX_VALUE))
        assertTrue(
            "a wrapped multiply would report a negative duration here",
            headroom.recordableMillis(Long.MAX_VALUE) > 0L,
        )
    }
}
