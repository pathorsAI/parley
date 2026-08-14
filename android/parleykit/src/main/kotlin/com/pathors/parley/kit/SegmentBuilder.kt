package com.pathors.parley.kit

/**
 * Accumulates finalized STT tokens into speaker-runs and emits committed
 * segments plus a tentative tail.
 *
 * Faithful port of `SegmentBuilder` in the desktop's
 * `src-tauri/src/transcription/common.rs` (via the iOS `SegmentBuilder.swift`) —
 * the semantics there are the contract the whole transcript UI depends on:
 * 1. [pushFinal] for each settled token,
 * 2. [emitCommitted] to surface the open run as solid text,
 * 3. [emitTail] for the tentative tail,
 * 4. [endpoint] when the provider signals end-of-utterance.
 *
 * A speaker change closes the open run (emitting it solid) and starts a new
 * one; speaker 0 never splits because non-diarizing input always reports 0.
 *
 * One deliberate improvement over the Rust original: segments go to an injected
 * sink instead of a global event emitter, so the builder is pure and
 * unit-testable.
 *
 * Not thread-safe — drive it from one thread (the relay client drives it from
 * the single WebSocket reader thread).
 */
class SegmentBuilder(
    private val source: String,
    private val sink: (TranscriptSegment) -> Unit,
) {
    private var segIndex: Long = 0

    /** Speaker of the open run, or null when no run is open. */
    private var curSpeaker: Int? = null
    private var curFinal: String = ""
    private var curStart: Long = 0
    private var curEnd: Long = 0

    /** The current open run's speaker (0 if none open) — useful for tail labels. */
    val currentSpeaker: Int
        get() = curSpeaker ?: 0

    /** The end timestamp of the current open run — useful as a tail start. */
    val currentEnd: Long
        get() = curEnd

    /**
     * Add a finalized token to the run. A speaker change closes the open run
     * (emitting it solid) and starts a new one. Whitespace is preserved as the
     * adapter supplies it.
     */
    fun pushFinal(text: String, speaker: Int, startMs: Long, endMs: Long) {
        val cur = curSpeaker
        if (cur == null) {
            curSpeaker = speaker
            curStart = startMs
        } else if (speaker != cur) {
            if (curFinal.isNotBlank()) {
                commit()
            }
            curSpeaker = speaker
            curFinal = ""
            curStart = startMs
        }
        curFinal += text
        curEnd = endMs
    }

    /** Emit the open run under a fresh segment id and advance the index. */
    private fun commit() {
        sink(
            TranscriptSegment(
                id = "$source-$segIndex",
                source = source,
                speaker = currentSpeaker,
                text = curFinal,
                isFinal = true,
                startMs = curStart,
                endMs = curEnd,
            )
        )
        segIndex += 1
    }

    /**
     * Surface the current open run as solid (settled) text without advancing —
     * it keeps growing under the same id until an endpoint or speaker change.
     */
    fun emitCommitted() {
        if (curFinal.isBlank()) return
        sink(
            TranscriptSegment(
                id = "$source-$segIndex",
                source = source,
                speaker = currentSpeaker,
                text = curFinal,
                isFinal = true,
                startMs = curStart,
                endMs = curEnd,
            )
        )
    }

    /**
     * Emit the tentative tail under a stable `{source}-tail` id (empty text
     * clears the previous tail in the UI).
     */
    fun emitTail(text: String, speaker: Int, startMs: Long) {
        sink(
            TranscriptSegment(
                id = "$source-tail",
                source = source,
                speaker = speaker,
                text = text,
                isFinal = false,
                startMs = startMs,
                endMs = startMs,
            )
        )
    }

    /** End-of-utterance: commit the open run (if any) and reset for the next one. */
    fun endpoint() {
        if (curFinal.isNotBlank()) {
            commit()
        }
        curSpeaker = null
        curFinal = ""
    }
}
