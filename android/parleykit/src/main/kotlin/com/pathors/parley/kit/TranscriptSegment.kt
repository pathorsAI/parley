package com.pathors.parley.kit

import kotlinx.serialization.Serializable

/**
 * One transcript segment, mirroring the desktop wire shape
 * (`TranscriptEvent` in `src-tauri/src/transcription/common.rs` and
 * `TranscriptSegment` in `src/lib/types.ts`).
 *
 * Identity rules (the UI upserts by [id]):
 * - A committed run keeps re-emitting under the same `"{source}-{index}"` id
 *   while it grows; the index advances only on endpoint/speaker change.
 * - The tentative tail always uses the stable `"{source}-tail"` id; an empty
 *   [text] clears it.
 *
 * Shared type: the cloud client also serializes these (recording meta carries a
 * `segments` array), so it lives here rather than inside the relay client.
 *
 * Timestamps are `Long` milliseconds. The Swift/Rust originals use `UInt64`;
 * `Long` is the idiomatic Kotlin equivalent and covers every realistic value
 * (millisecond counters within one recording).
 */
@Serializable
data class TranscriptSegment(
    val id: String,
    /**
     * Capture source. On mobile this is always `"mix"` — a phone has one mic and
     * speaker identity comes from provider diarization, exactly like the
     * desktop's single-session diarizing topology.
     */
    val source: String,
    /** Diarized speaker index within the source; 0 = unknown/single. */
    val speaker: Int,
    val text: String,
    val isFinal: Boolean,
    val startMs: Long,
    val endMs: Long,
)
