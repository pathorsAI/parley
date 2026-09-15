package com.pathors.parley.meeting

/**
 * Where a microphone chunk is recorded. Doing real work here is expected: this
 * is the encoder, and the capture loop exists to feed it.
 */
fun interface AudioSink {
    fun append(chunk: ByteArray)
}

/**
 * Where a microphone chunk goes for live transcription.
 *
 * Deliberately **not** a suspending function. The type is the guarantee: there
 * is no way to write an implementation that makes the capture loop wait, so
 * there is no way to reintroduce the failure this interface was extracted to
 * prevent. A relay that cannot keep up must drop audio, not hold it.
 */
fun interface RelaySink {
    fun enqueue(chunk: ByteArray)
}

/**
 * The fan-out at the heart of a live recording: every microphone chunk goes to
 * the file and to the live transcript.
 *
 * ```
 * MicCapture ──ByteArray(3200)──┬──▶ AudioSink  ──▶ {id}.ogg
 *                               └──▶ RelaySink  ──▶ segments
 * ```
 *
 * The order is not cosmetic and neither is the asymmetry. The file comes first
 * and is allowed to throw — a failure to encode is a failure of the recording,
 * and the session needs to hear about it. The relay comes second, cannot be
 * waited on, and its problems never reach the caller.
 *
 * That asymmetry is the fix for a very specific chain: when the two shared one
 * call site and the relay's send could suspend, a stalled socket stopped the
 * collector, which filled `MicCapture`'s channel, which blocked the reader
 * thread on `trySendBlocking`, which overran the `AudioRecord` ring buffer —
 * and the kernel then dropped audio that the .ogg file is missing to this day.
 * A hole in a transcript can be filled in later from the recording. A hole in
 * the recording cannot be filled in from anything.
 *
 * @param relay read fresh for every chunk: a reconnect swaps the client, and a
 *   captured one would keep feeding a socket nobody reads.
 */
class CapturePipeline(
    private val audio: AudioSink,
    private val relay: () -> RelaySink?,
) {
    fun accept(chunk: ByteArray) {
        audio.append(chunk)
        relay()?.enqueue(chunk)
    }
}
