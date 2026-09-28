package com.pathors.parley.feedback

/**
 * The conditions under which the app decides, on its own, that something went
 * wrong with a recording — the "when" column of spec §4, as pure functions.
 *
 * Each one is evaluated where the fact is already known (the detail screen has
 * the transcript, the meeting has its recovery count, the upload queue has its
 * failures), so this file holds only the thresholds and the arithmetic. Keeping
 * them together is what keeps the two phones and the admin view agreeing about
 * what "broken" means: iOS and the cloud use the same numbers.
 */
object ProblemSignals {

    /** Shortest recording whose empty transcript counts as a failure: 20 s. */
    const val EMPTY_MIN_DURATION_MS = 20_000L

    /** Shortest recording checked for a truncated transcript: 3 min. */
    const val TRUNCATED_MIN_DURATION_MS = 3L * 60 * 1000

    /** A transcript ending before this share of the recording is truncated. */
    const val TRUNCATED_COVERAGE = 0.5

    /** Microphone recoveries in one recording that are worth asking about. */
    const val MIC_RECOVERIES_THRESHOLD = 5

    /** Consecutive failed sync attempts for one recording that are worth asking about. */
    const val SYNC_FAILURES_THRESHOLD = 3

    /** How long a recording may wait to sync before it is worth asking about: 24 h. */
    const val SYNC_PENDING_MS = 24L * 60 * 60 * 1000

    /**
     * 20 seconds or more of audio and not one transcript segment. Twenty
     * seconds is past every "tapped record by accident" recording and short of
     * anything a person would call a meeting — the D1 data that started this
     * showed failed Android recordings as many 2–6 s empties *and* longer ones.
     */
    fun isEmptyTranscript(durationMs: Long, segmentCount: Int): Boolean =
        durationMs >= EMPTY_MIN_DURATION_MS && segmentCount == 0

    /**
     * Three minutes or more of audio whose last transcript segment ends before
     * half-way — the "111 minutes recorded, about 12 transcribed" shape.
     *
     * Requires at least one segment: a transcript with none is
     * [isEmptyTranscript]'s case, and one recording must not raise both prompts
     * about the same fact.
     */
    fun isTruncatedTranscript(durationMs: Long, segmentCount: Int, lastSegmentEndMs: Long): Boolean =
        durationMs >= TRUNCATED_MIN_DURATION_MS &&
            segmentCount > 0 &&
            lastSegmentEndMs < durationMs * TRUNCATED_COVERAGE

    /** Five or more microphone recoveries in a single recording. */
    fun isMicRecoveryWorthAsking(recoveries: Int): Boolean = recoveries >= MIC_RECOVERIES_THRESHOLD

    /**
     * Three failed sync attempts in a row, or a day spent waiting — whichever
     * comes first. The second catches the recording that never even gets to
     * fail, because the phone is never online and signed in at the same time.
     */
    fun isSyncStuck(consecutiveFailures: Int, queuedAtMs: Long, nowMs: Long): Boolean =
        consecutiveFailures >= SYNC_FAILURES_THRESHOLD || nowMs - queuedAtMs >= SYNC_PENDING_MS

    /**
     * The minutes an empty recording's copy names ("recorded for 3 minutes").
     * Rounded, but never 0: a 40-second recording said to be "0 minutes" long
     * would read as the app contradicting itself about the very recording it is
     * asking about.
     */
    fun wholeMinutes(durationMs: Long): Int =
        ((durationMs + 30_000L) / 60_000L).toInt().coerceAtLeast(1)
}
