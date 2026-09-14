package com.pathors.parley.meeting

import com.pathors.parley.kit.SttRelayClient
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The invariant the recording depends on: the relay cannot hold up the encoder.
 *
 * The chain this guards against was real and was verified on device — a stalled
 * relay stopped the collector, the collector stopped draining `MicCapture`'s
 * 64-chunk channel (≈ 6.4 s), the reader thread blocked on `trySendBlocking`,
 * the `AudioRecord` ring buffer overran, and the kernel dropped audio that is
 * missing from the .ogg file to this day. A transcript can be rebuilt from the
 * recording afterwards; nothing can rebuild the recording.
 */
class CapturePipelineTest {

    private val chunk = ByteArray(3_200) // 100 ms of 16 kHz mono s16le

    /**
     * A relay client that was never opened has nothing draining its outbound
     * queue, which is precisely what a half-open socket looks like from the
     * producer's side. Every chunk must still reach the encoder, promptly.
     */
    @Test(timeout = 60_000)
    fun aRelayThatNeverDrainsDoesNotStallTheEncoder() {
        val relay = SttRelayClient(SttRelayClient.Options(bearerToken = "token"))
        try {
            val encoded = AtomicInteger()
            val pipeline = CapturePipeline(
                audio = { encoded.incrementAndGet() },
                relay = { RelaySink { bytes -> relay.enqueuePcm(bytes) } },
            )

            val chunks = SttRelayClient.MAX_QUEUED_CHUNKS * 4
            val startedAt = System.nanoTime()
            repeat(chunks) { pipeline.accept(chunk) }
            val elapsedMs = (System.nanoTime() - startedAt) / 1_000_000

            assertEquals("every chunk must reach the recording", chunks, encoded.get())
            assertTrue("feeding the encoder took ${elapsedMs}ms", elapsedMs < 5_000)
            assertTrue(
                "the relay should have dropped audio rather than holding it",
                relay.droppedPcmChunks > 0,
            )
        } finally {
            relay.cancel()
        }
    }

    @Test
    fun theRecordingKeepsGoingWithNoRelayAtAll() {
        // Between legs a reconnect leaves the field null for a moment.
        val encoded = AtomicInteger()
        val pipeline = CapturePipeline(audio = { encoded.incrementAndGet() }, relay = { null })

        repeat(50) { pipeline.accept(chunk) }

        assertEquals(50, encoded.get())
    }

    @Test
    fun theRelayIsReadFreshForEveryChunk() {
        // A reconnect swaps the client; a captured one would keep feeding a
        // socket nobody reads.
        val first = AtomicInteger()
        val second = AtomicInteger()
        var current: RelaySink = RelaySink { first.incrementAndGet() }
        val pipeline = CapturePipeline(audio = {}, relay = { current })

        pipeline.accept(chunk)
        current = RelaySink { second.incrementAndGet() }
        pipeline.accept(chunk)

        assertEquals(1, first.get())
        assertEquals(1, second.get())
    }

    @Test
    fun theEncoderSeesAChunkBeforeTheRelayDoes() {
        // Ordering is not cosmetic: the file is the artefact that cannot be
        // recreated, so it is written first.
        val order = mutableListOf<String>()
        val pipeline = CapturePipeline(
            audio = { order += "audio" },
            relay = { RelaySink { order += "relay" } },
        )

        pipeline.accept(chunk)

        assertEquals(listOf("audio", "relay"), order)
    }
}
