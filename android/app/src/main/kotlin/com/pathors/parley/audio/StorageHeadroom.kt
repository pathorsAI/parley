package com.pathors.parley.audio

/**
 * How much recording the free space on this device is actually worth, and the
 * two decisions that follow from it: whether a meeting may start, and when a
 * meeting in progress must stop *and save itself* rather than record on into a
 * full disk.
 *
 * ## The failure
 *
 * Neither platform looks at free space today. A phone with thirty megabytes
 * left will happily start a two-hour meeting, and the disk fills somewhere in
 * the middle of it: `MediaCodec` throws, or the page write throws, or the
 * file simply stops growing — at an unpredictable point, in a component that
 * has no idea why it failed. The user finds out at the end, which is the worst
 * possible moment, because by then the meeting is over and cannot be held
 * again.
 *
 * The fix has two halves and this type is the arithmetic behind both. Refuse up
 * front when there is obviously not enough room ([canStart]), and while
 * recording, stop early enough that the *save* still fits ([assess] returning
 * [Headroom.CRITICAL]).
 *
 * ## Stopping is not discarding
 *
 * Running out of space never deletes anything. A capture cut short by a full
 * disk ends as `CaptureEnding.INTERRUPTED`, which saves and uploads exactly
 * like a normal stop and only differs in what the UI says — see
 * `CaptureEnding.kt`, where exactly one ending in the whole app deletes audio
 * and it is the one a person explicitly asked for. Forty minutes of meeting are
 * worth more than the megabytes they occupy, always.
 *
 * ## The arithmetic behind the thresholds
 *
 * Everything here is one number in disguise. `OggOpusEncoder` writes at
 * [OggOpusEncoder.DEFAULT_BITRATE] = 24 000 bits per second, which is
 * **3 000 bytes per second**, or roughly **5.8 minutes per MiB**. That is what
 * makes the three thresholds arguable rather than arbitrary — each one below is
 * justified in minutes of recording, not in megabytes, because minutes are what
 * the decision is actually about.
 *
 * ## No Android here on purpose
 *
 * The caller wraps `StatFs` and hands the byte count in. Free space is the only
 * input, the rest is division, and division is worth being able to test without
 * a device — which is the same reason `ReconnectPolicy` and `CaptureEnding` are
 * plain Kotlin.
 *
 * @property bitrateBps the encoder's constant output rate. Injectable so a test
 *   can use a round number, but in the app it is always the encoder's own
 *   constant: a headroom calculation computed against a bitrate the encoder is
 *   not using would be confidently wrong, which is worse than not checking.
 */
class StorageHeadroom(
    val bitrateBps: Int = OggOpusEncoder.DEFAULT_BITRATE,
    /**
     * Refuse to begin below this. ≈3 hours of headroom at 24 kbps, which is
     * chosen from both ends: long enough that a genuinely long meeting finishes
     * with room to spare, and *high* enough above any plausible meeting that the
     * check never fires spuriously on a healthy phone. A start check that
     * sometimes blocks a user who had plenty of space would be worse than no
     * check at all — it would be the thing people learn to work around.
     */
    val minimumToStartBytes: Long = DEFAULT_MINIMUM_TO_START_BYTES,
    /**
     * Stop the recording and save it below this. ≈23 minutes of audio left.
     *
     * **This threshold is sized by what finishing the recording costs, not by
     * what continuing costs.** The save path itself needs disk: closing the Ogg
     * container flushes the remaining pages, the manifest is written next to the
     * file, and the upload queue then moves (and, on some paths, copies) the
     * result. A stop threshold set to "nearly zero" would be the bug, not the
     * fix — the recording would be cut short *and* fail to save, which is the
     * exact outcome the whole type exists to prevent. Twenty-odd minutes of
     * slack is generous for that work and cheap to give up.
     */
    val stopBelowBytes: Long = DEFAULT_STOP_BELOW_BYTES,
    /**
     * Warn the user below this. ≈1.5 hours of audio left — far enough ahead of
     * [stopBelowBytes] that "you are running out of space" arrives while there
     * is still time to do something about it (end the meeting deliberately,
     * delete something), rather than as an announcement that it has already
     * happened.
     */
    val warnBelowBytes: Long = DEFAULT_WARN_BELOW_BYTES,
) {
    init {
        require(bitrateBps > 0) { "bitrateBps must be positive (got $bitrateBps)" }
        require(stopBelowBytes > 0) { "stopBelowBytes must be positive (got $stopBelowBytes)" }
        require(warnBelowBytes > stopBelowBytes) {
            "warnBelowBytes ($warnBelowBytes) must be above stopBelowBytes ($stopBelowBytes) — " +
                "a warning that arrives at or after the forced stop is not a warning"
        }
        require(minimumToStartBytes >= warnBelowBytes) {
            "minimumToStartBytes ($minimumToStartBytes) must not be below warnBelowBytes " +
                "($warnBelowBytes) — otherwise a meeting is allowed to start already LOW"
        }
    }

    /** Bytes the encoder writes per second of audio. 24 000 / 8 = 3 000. */
    val bytesPerSecond: Int get() = bitrateBps / 8

    /**
     * How much recording [freeBytes] buys, in milliseconds.
     *
     * Clamped at zero: `StatFs` on a full volume, or a caller subtracting a
     * reserve it has already earmarked, can produce a negative number, and a
     * negative duration flowing into a UI countdown or a `>` comparison is how
     * "no space left" would silently read as "plenty of time".
     */
    fun recordableMillis(freeBytes: Long): Long {
        if (freeBytes <= 0L) return 0L
        // Multiply first: at 3 000 B/s an integer-seconds intermediate would
        // throw away up to a second of precision. A real filesystem can never
        // report enough bytes to overflow that (a thousand exabytes), but a
        // *caller* can: `MeetingSession` reports `Long.MAX_VALUE` when `StatFs`
        // refuses to answer, on the principle that an unknown amount of free
        // space is not a reason to refuse a meeting. Wrapping that to a negative
        // duration would read as "no room at all" — the exact opposite.
        if (freeBytes > Long.MAX_VALUE / 1_000L) return freeBytes / bytesPerSecond * 1_000L
        return freeBytes * 1_000L / bytesPerSecond
    }

    /**
     * Which band [freeBytes] falls into.
     *
     * Boundaries are **exclusive below**: a value exactly equal to a threshold
     * is on the *safe* side of it. Exactly [stopBelowBytes] is [Headroom.LOW],
     * not [Headroom.CRITICAL]; exactly [warnBelowBytes] is [Headroom.AMPLE], not
     * [Headroom.LOW]. Picked this way so the thresholds read as what they are
     * named — "stop *below* four MiB" — and so a device sitting exactly on a
     * round number does not flap between two bands as the last block is
     * allocated and freed.
     */
    fun assess(freeBytes: Long): Headroom = when {
        freeBytes < stopBelowBytes -> Headroom.CRITICAL
        freeBytes < warnBelowBytes -> Headroom.LOW
        else -> Headroom.AMPLE
    }

    /**
     * May a new meeting begin? True at exactly [minimumToStartBytes] — the
     * threshold is the lowest acceptable amount, not the first unacceptable one.
     */
    fun canStart(freeBytes: Long): Boolean = freeBytes >= minimumToStartBytes

    /**
     * The three bands, nested rather than top-level because the name only means
     * anything next to the thing that computes it: a bare `Headroom` sitting in
     * `com.pathors.parley.audio` would read, at an unrelated call site, as
     * headroom of some audio-level kind. `StorageHeadroom.Headroom.CRITICAL`
     * cannot be misread.
     */
    enum class Headroom {
        /** Nothing to say. Record. */
        AMPLE,

        /** Tell the user, keep recording. There is still time to act. */
        LOW,

        /**
         * Stop now and save. Not "warn harder" — by this point the remaining
         * space is budgeted for finishing the file, and spending it on more
         * audio is spending the only thing that makes the audio retrievable.
         */
        CRITICAL,
    }

    companion object {
        /** 32 MiB ≈ 3 hours at 24 kbps. */
        const val DEFAULT_MINIMUM_TO_START_BYTES = 32L * 1024 * 1024

        /** 16 MiB ≈ 1.5 hours at 24 kbps. */
        const val DEFAULT_WARN_BELOW_BYTES = 16L * 1024 * 1024

        /** 4 MiB ≈ 23 minutes at 24 kbps — the budget for finishing and saving. */
        const val DEFAULT_STOP_BELOW_BYTES = 4L * 1024 * 1024

        /** The parameters every Parley recording uses. */
        val STANDARD = StorageHeadroom()
    }
}
