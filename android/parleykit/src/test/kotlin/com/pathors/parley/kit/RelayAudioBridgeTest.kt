package com.pathors.parley.kit

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The contract a reconnect depends on: audio spoken while no socket exists is
 * held, bounded, delivered in order to the next leg, and timestamped so it
 * lands where it was actually said.
 *
 * Ported one-for-one from iOS `ParleyKitTests/RelayAudioBridgeTests.swift`;
 * the last test is an Android addition that pins the flush ordering the Kotlin
 * port tightens (see the class doc on [RelayAudioBridge]).
 */
class RelayAudioBridgeTest {

    private class Recorder : PcmSink {
        private val chunks = mutableListOf<ByteArray>()

        @Synchronized
        override fun enqueuePcm(bytes: ByteArray) {
            chunks.add(bytes)
        }

        val received: List<ByteArray>
            @Synchronized get() = chunks.toList()

        /** The marker each received chunk carries, in arrival order. */
        val markers: List<Int> get() = received.map { it.marker() }

        val sampleCount: Int get() = received.sumOf { it.size / 2 }
    }

    @Test
    fun attachedAudioGoesStraightToTheLeg() {
        val bridge = RelayAudioBridge()
        val leg = Recorder()
        bridge.attach(leg)

        bridge.send(chunk(1))
        bridge.send(chunk(2))

        assertEquals(listOf(1, 2), leg.markers)
        assertFalse(bridge.isHolding)
        assertEquals(0L, bridge.heldMilliseconds)
    }

    @Test
    fun gapAudioIsHeldAndFlushedIntoTheNextLegInOrder() {
        val bridge = RelayAudioBridge()
        val first = Recorder()
        bridge.attach(first)
        bridge.send(chunk(1))

        bridge.hold()
        bridge.send(chunk(2))
        bridge.send(chunk(3))
        assertTrue(bridge.isHolding)
        assertEquals("two 100 ms chunks are waiting", 200L, bridge.heldMilliseconds)

        val second = Recorder()
        bridge.attach { second }
        bridge.send(chunk(4))

        assertEquals("the dead leg gets nothing more", listOf(1), first.markers)
        assertEquals(
            "the gap arrives before the audio that followed it",
            listOf(2, 3, 4),
            second.markers,
        )
        assertEquals(0L, bridge.heldMilliseconds)
    }

    @Test
    fun theNextLegIsOffsetToWhereTheHeldAudioWasSpoken() {
        val bridge = RelayAudioBridge()
        bridge.attach(Recorder())
        // Ten seconds of meeting before the socket dies.
        repeat(10) { bridge.send(chunk(1, samples = SECOND_OF_SAMPLES)) }

        bridge.hold()
        // Three seconds spoken into the gap.
        repeat(3) { bridge.send(chunk(2, samples = SECOND_OF_SAMPLES)) }

        var offset: Long? = null
        bridge.attach { ms ->
            offset = ms
            Recorder()
        }

        assertEquals(
            "the leg's clock starts at the first sample it is fed, not at the reconnect",
            10_000L,
            offset,
        )
        assertEquals(13_000L, bridge.capturedMilliseconds)
    }

    @Test
    fun offsetWithNothingHeldIsTheLivePosition() {
        val bridge = RelayAudioBridge()
        bridge.attach(Recorder())
        repeat(5) { bridge.send(chunk(1, samples = SECOND_OF_SAMPLES)) }
        bridge.hold()

        var offset: Long? = null
        bridge.attach { ms ->
            offset = ms
            Recorder()
        }
        assertEquals(5_000L, offset)
    }

    @Test
    fun holdingIsBoundedAndDropsTheOldestAudio() {
        val bridge = RelayAudioBridge(holdLimitMs = 3_000)
        bridge.attach(Recorder())
        bridge.hold()

        // Six seconds into a three-second buffer.
        for (marker in 1..6) bridge.send(chunk(marker, samples = SECOND_OF_SAMPLES))
        assertEquals("the hold never grows past its bound", 3_000L, bridge.heldMilliseconds)

        val leg = Recorder()
        var offset: Long? = null
        bridge.attach { ms ->
            offset = ms
            leg
        }

        assertEquals(
            "the oldest seconds were dropped, not the newest",
            listOf(4, 5, 6),
            leg.markers,
        )
        assertEquals(
            "the offset follows the front of the buffer, so the surviving audio still lands where it was said",
            3_000L,
            offset,
        )
    }

    @Test
    fun discardDropsHeldAudioAndKeepsTheClock() {
        val bridge = RelayAudioBridge()
        bridge.attach(Recorder())
        bridge.send(chunk(1, samples = SECOND_OF_SAMPLES))
        bridge.hold()
        bridge.send(chunk(2, samples = SECOND_OF_SAMPLES))

        bridge.discard()
        assertFalse(bridge.isHolding)
        assertEquals(0L, bridge.heldMilliseconds)

        // Audio after giving up is dropped on the floor rather than piling up.
        bridge.send(chunk(3, samples = SECOND_OF_SAMPLES))
        assertEquals(0L, bridge.heldMilliseconds)
        assertEquals(3_000L, bridge.capturedMilliseconds)

        val leg = Recorder()
        var offset: Long? = null
        bridge.attach { ms ->
            offset = ms
            leg
        }
        assertEquals("a later leg still knows how far into the recording it is", 3_000L, offset)
        assertEquals(0, leg.sampleCount)
    }

    @Test
    fun attachReturningNullLeavesTheBridgeHolding() {
        val bridge = RelayAudioBridge()
        bridge.hold()
        bridge.send(chunk(1))

        val leg: Recorder? = bridge.attach { null }
        assertNull(leg)
        assertTrue(bridge.isHolding)
        assertEquals("nothing was flushed, so nothing was lost", 100L, bridge.heldMilliseconds)
    }

    @Test
    fun resetForgetsTheClock() {
        val bridge = RelayAudioBridge()
        bridge.attach(Recorder())
        bridge.send(chunk(1, samples = SECOND_OF_SAMPLES))
        bridge.reset()

        assertEquals(0L, bridge.capturedMilliseconds)
        assertFalse(bridge.isHolding)
    }

    /**
     * A leg that dies while the microphone is mid-chunk must not lose or
     * reorder audio: everything sent lands somewhere, exactly once, in order.
     */
    @Test
    fun concurrentSendsAcrossAReconnectLoseNothing() {
        val bridge = RelayAudioBridge()
        val first = Recorder()
        val second = Recorder()
        bridge.attach(first)

        val chunks = 200
        val done = CountDownLatch(1)
        thread(name = "audio-thread") {
            for (i in 0 until chunks) bridge.send(chunk(i, samples = 1))
            done.countDown()
        }
        // Swap the leg out and in from under the sender.
        bridge.hold()
        bridge.attach { second }
        assertTrue(done.await(5, TimeUnit.SECONDS))

        val delivered = first.markers + second.markers
        assertEquals("every chunk reached a leg exactly once", chunks, delivered.size)
        assertEquals("and none of them overtook another", delivered.sorted(), delivered)
    }

    /**
     * Android addition. Live audio that arrives *while* the held chunks are
     * being flushed must queue behind them, not overtake them — the leg's
     * offset was fixed to the front of the gap, so a live chunk landing first
     * would be stamped as if it had been said before the gap.
     */
    @Test
    fun liveAudioArrivingMidFlushQueuesBehindTheGap() {
        val bridge = RelayAudioBridge()
        bridge.hold()
        bridge.send(chunk(1))
        bridge.send(chunk(2))

        // A leg whose first enqueue is the capture loop's cue to send a live
        // chunk: that chunk arrives while the bridge is half-way through the
        // flush.
        val received = mutableListOf<Int>()
        val leg = object : PcmSink {
            var sentLive = false
            override fun enqueuePcm(bytes: ByteArray) {
                received.add(bytes.marker())
                if (!sentLive) {
                    sentLive = true
                    bridge.send(chunk(3))
                }
            }
        }
        bridge.attach { leg }
        bridge.send(chunk(4))

        assertEquals(listOf(1, 2, 3, 4), received)
        assertFalse(bridge.isHolding)
        assertEquals(0L, bridge.heldMilliseconds)
    }

    @Test
    fun holdDuringAFlushKeepsTheUnflushedAudioForTheLegAfter() {
        val bridge = RelayAudioBridge()
        bridge.hold()
        bridge.send(chunk(1))

        val third = Recorder()
        // The new leg dies the moment it is handed audio; the capture loop
        // keeps talking through it.
        val doomed = object : PcmSink {
            override fun enqueuePcm(bytes: ByteArray) {
                bridge.send(chunk(2))
                bridge.hold()
                bridge.send(chunk(3))
            }
        }
        bridge.attach { doomed }
        assertTrue(bridge.isHolding)
        bridge.attach { third }

        assertEquals("what the dead leg never got goes to the next one", listOf(2, 3), third.markers)
    }

    private companion object {
        /** One second of audio at the pipeline's fixed 16 kHz. */
        const val SECOND_OF_SAMPLES = SonioxProtocol.SAMPLE_RATE

        /**
         * A chunk of s16le PCM whose first sample carries [marker], so
         * ordering is checkable. Defaults to 100 ms, the size `MicCapture`
         * emits.
         */
        fun chunk(marker: Int, samples: Int = 1_600): ByteArray {
            val bytes = ByteArray(samples * 2)
            bytes[0] = (marker and 0xFF).toByte()
            bytes[1] = ((marker shr 8) and 0xFF).toByte()
            return bytes
        }

        fun ByteArray.marker(): Int = (this[0].toInt() and 0xFF) or ((this[1].toInt() and 0xFF) shl 8)
    }
}
