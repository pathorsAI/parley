package com.pathors.parley.meeting

/**
 * The meeting timer. Shows recorded time, wall time minus pauses, which is what
 * the saved audio contains.
 */
sealed interface RecordingClock {
    fun elapsedAt(nowMs: Long): Long
    fun paused(nowMs: Long): RecordingClock
    fun resumed(nowMs: Long): RecordingClock

    data class Running(val sinceMs: Long, val bankedMs: Long = 0) : RecordingClock {
        override fun elapsedAt(nowMs: Long): Long = bankedMs + maxOf(0L, nowMs - sinceMs)
        override fun paused(nowMs: Long): RecordingClock = Paused(elapsedAt(nowMs))
        override fun resumed(nowMs: Long): RecordingClock = this
    }

    data class Paused(val bankedMs: Long) : RecordingClock {
        override fun elapsedAt(nowMs: Long): Long = bankedMs
        override fun paused(nowMs: Long): RecordingClock = this
        override fun resumed(nowMs: Long): RecordingClock = Running(nowMs, bankedMs)
    }
}
