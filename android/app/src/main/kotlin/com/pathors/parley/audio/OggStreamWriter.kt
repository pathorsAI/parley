package com.pathors.parley.audio

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.random.Random

/**
 * Opus packets in, finished Ogg pages out — the container written by hand.
 *
 * ## Why this exists rather than `MediaMuxer(MUXER_OUTPUT_OGG)`
 *
 * A `MediaMuxer` file is only a file once `stop()` has run. Everything written
 * before that is bytes on disk that no player will touch, because the muxer
 * finalises the container at the end. When Android kills the recorder mid
 * meeting — low memory, a battery pull, the user swiping the task away — the
 * `.ogg` left behind is a write-off, and an hour of audio that physically
 * reached the disk is unrecoverable. That is what blocks adopting orphaned
 * recordings after a crash: there is nothing to adopt.
 *
 * Ogg does not have to work that way. It is a *streaming* container: each page
 * carries its own header, its own lacing table and its own CRC, so a file that
 * simply stops mid-stream is a recording that ends early, not a corrupt one.
 * Writing the pages ourselves is what turns "the process died" from "lost the
 * meeting" into "lost the last second of it".
 *
 * This is a straight port of the iOS encoder's container half
 * (`ios/ParleyKit/Sources/ParleyKit/OggOpusEncoder.swift:164-243` —
 * `writeHeaderPages`, `emitPages`, `oggPage`, `oggCRC`), which itself ports the
 * desktop original (`src-tauri/src/replay_audio.rs:259` `encode_opus_ogg`, via
 * the `ogg` crate's `PacketWriter`). All three write the same `OpusHead`, the
 * same granule arithmetic and the same page geometry, so a recording is the
 * same artefact whichever device made it.
 *
 * ## Pure JVM on purpose
 *
 * There is not a single `android.*` import here, and there must never be one.
 * This module has no Robolectric, so a class that touches the framework cannot
 * be unit tested at all — and container framing is exactly the kind of code
 * where an off-by-one in a lacing table produces a file that "mostly plays"
 * until someone seeks. See `OggStreamWriterTest`.
 *
 * ## Usage
 *
 * ```kotlin
 * val writer = OggStreamWriter(sink = { page -> out.write(page); out.flush() })
 * opusPackets.forEach(writer::append)   // pages stream out as they fill
 * writer.finish()                       // flush the tail, set the EOS flag
 * ```
 *
 * Pages are handed to [sink] one at a time and never retained, so a three-hour
 * meeting costs one page of memory, not three hours of it.
 *
 * ## Threading
 *
 * **Not** thread-safe, deliberately: the only caller, [OggOpusEncoder], already
 * serialises everything under its own lock, and a second lock here would be a
 * second thing to reason about for no gain.
 *
 * @param sink receives every finished page, header pages included. It is called
 *   synchronously from [append] / [finish], so whatever it throws surfaces
 *   there; that is how a full disk reaches the caller.
 * @param serial the Ogg stream serial. Random by default (it only has to be
 *   unique within a file); injectable so tests get byte-identical output.
 * @param preSkip encoder look-ahead in 48 kHz samples, written into `OpusHead`
 *   and added to every granule position. 312 (6.5 ms) matches desktop and iOS,
 *   but the real encoder's own figure should be passed when it reports one.
 * @param inputSampleRate the "original input rate" field of `OpusHead`. Purely
 *   informational — Opus itself always runs at 48 kHz.
 * @param packetsPerPage how many packets accumulate before a page is flushed.
 *   50 packets of 20 ms ≈ 1 s, the same figure iOS uses: small enough that a
 *   kill costs at most a second, large enough that page headers stay noise.
 * @param vendor the `OpusTags` vendor string. Identifies which recorder made
 *   the file when one turns up in support.
 */
class OggStreamWriter(
    private val sink: (ByteArray) -> Unit,
    private val serial: Int = Random.nextInt(),
    private val preSkip: Int = OPUS_PRE_SKIP,
    private val inputSampleRate: Int = Pcm.SAMPLE_RATE,
    private val packetsPerPage: Int = PACKETS_PER_PAGE,
    private val vendor: String = DEFAULT_VENDOR,
) {
    /** Packets waiting for a page. Never more than [packetsPerPage] survive a call. */
    private val pending = ArrayDeque<ByteArray>()

    private var pageSequence = 0
    private var packetCount = 0L

    /**
     * What each pending packet is worth in granule units, read from its own TOC
     * byte rather than assumed.
     *
     * Kept alongside [pending] rather than derived at page time because a packet
     * is authoritative about its own framing and nothing else is: see
     * [granuleOf].
     */
    private val pendingGranules = ArrayDeque<Long>()

    /** Granule of every packet already written to a page, excluding pre-skip. */
    private var writtenGranule = 0L
    private var pageCount = 0L
    private var headersWritten = false
    private var finished = false

    /** Opus packets accepted so far. Callers use this to detect a silent encoder. */
    val packetsWritten: Long get() = packetCount

    /** Pages handed to [sink], header pages included. Logging and tests. */
    val pagesWritten: Long get() = pageCount

    /**
     * Emit the two mandatory header pages: `OpusHead` as the beginning-of-stream
     * page (flag `0x02`), then `OpusTags`. Both carry granule 0 — they are not
     * audio, and a player that timed them would start the clock 40 ms early.
     *
     * Idempotent, and called for you by [append] if you never call it, because
     * the interesting case is the caller who cannot write headers until the
     * codec has told them the pre-skip. See [OggOpusEncoder]'s deferral comment.
     */
    fun writeHeaders() {
        if (headersWritten) return
        headersWritten = true

        writePage(listOf(buildOpusHead(preSkip, inputSampleRate)), granule = 0L, flags = FLAG_BOS)
        writePage(listOf(buildOpusTags(vendor)), granule = 0L, flags = FLAG_NONE)
    }

    /**
     * Queue one Opus packet, flushing a page once [packetsPerPage] have piled up.
     *
     * @param packet a complete Opus packet; it is retained until its page is
     *   written, so the caller must not reuse the array. Packets are never split
     *   across pages (Ogg's continuation flag `0x01` would allow it, but every
     *   whole-packet page is one less thing a truncated file can end in the
     *   middle of), which caps a packet at [MAX_PACKET_BYTES].
     */
    fun append(packet: ByteArray) {
        check(!finished) { "append() after finish()" }
        require(packet.size <= MAX_PACKET_BYTES) {
            "Opus packet is ${packet.size} bytes; a single page holds at most " +
                "$MAX_PACKET_BYTES (a real 20 ms packet is ~60)"
        }
        if (!headersWritten) writeHeaders()

        pending.addLast(packet)
        pendingGranules.addLast(granuleOf(packet))
        packetCount++
        emitPages(force = false, eos = false)
    }

    /**
     * What one Opus packet is worth in granule units, from its own TOC byte.
     *
     * Production used to assume a flat [GRANULE_PER_PACKET], i.e. that every
     * `MediaCodec` output buffer carries exactly one 20 ms frame. That is true
     * of `c2.android.opus.encoder` — `OggOpusEncoderDeviceTest` measures it — but
     * it is a property of that encoder, not of the API. A vendor encoder that
     * bundled frames would have produced a file whose clock ran slow, with no
     * error anywhere: mid-file timestamps drifting further out the longer the
     * meeting ran, on the one screen whose whole point is tapping a sentence to
     * hear it. Reading the framing instead of assuming it makes that
     * unrepresentable rather than merely unlikely.
     *
     * RFC 6716 §3.1: the TOC's top five bits pick the configuration, whose frame
     * duration follows the mode, and the bottom two say how many frames the
     * packet packs.
     */
    private fun granuleOf(packet: ByteArray): Long {
        if (packet.isEmpty()) return 0L
        val toc = packet[0].toInt() and 0xFF
        val config = toc ushr 3
        val frameSamples = when {
            config < 12 -> SILK_FRAME_SAMPLES[config % 4]
            config < 16 -> HYBRID_FRAME_SAMPLES[config % 2]
            else -> CELT_FRAME_SAMPLES[config % 4]
        }
        val frames = when (toc and 0x03) {
            0 -> 1
            1, 2 -> 2
            // Code 3 packs an arbitrary count in the six low bits of the next
            // byte. A truncated packet claiming code 3 has no count to read, so
            // it is worth the one frame we can account for rather than zero.
            else -> if (packet.size >= 2) (packet[1].toInt() and 0x3F).coerceAtLeast(1) else 1
        }
        return frameSamples * frames
    }

    /**
     * Flush whatever is pending and close the stream with an end-of-stream page.
     *
     * Whether the tail lands on a page boundary or not, the *last* page written
     * carries flag `0x04`; when everything already flushed evenly (or nothing
     * was ever appended) that means a bare page with no payload, carrying the
     * final granule — the same shape iOS's `emitPages(force:eos:)` produces.
     * Decoders use that page to learn where the stream really ends, which is how
     * a player knows not to report the trailing pre-skip as audio.
     *
     * Idempotent: a second call writes nothing.
     */
    fun finish() {
        if (finished) return
        finished = true
        // A stream with no audio at all still needs its headers, otherwise the
        // file is zero bytes and nothing can tell "empty recording" from
        // "failed to create the file".
        if (!headersWritten) writeHeaders()
        emitPages(force = true, eos = true)
    }

    // ---------------------------------------------------------------- internals

    /**
     * Turn pending packets into pages.
     *
     * With `force = false` this only fires on a full page, so [append] stays
     * cheap; with `true` it drains everything. `eos` marks the final page, which
     * is the one thing that cannot be decided per-page in isolation — hence the
     * `emittedEos` bookkeeping and the bare closing page below.
     */
    private fun emitPages(force: Boolean, eos: Boolean) {
        var emittedEos = false
        while (pending.size >= packetsPerPage || (force && pending.isNotEmpty())) {
            val take = packetsThatFitOnAPage()
            val payloads = ArrayList<ByteArray>(take)
            repeat(take) { payloads.add(pending.removeFirst()) }

            val isLast = eos && pending.isEmpty()
            emittedEos = emittedEos || isLast
            // Granule counts 48 kHz samples through the *end* of this page, and
            // includes the pre-skip (RFC 7845 §4): the decoder subtracts the
            // pre-skip again, so leaving it out makes every timestamp 6.5 ms early.
            repeat(take) { writtenGranule += pendingGranules.removeFirst() }
            writePage(payloads, preSkip + writtenGranule, if (isLast) FLAG_EOS else FLAG_NONE)
        }
        if (eos && !emittedEos) {
            writePage(emptyList(), preSkip + writtenGranule, FLAG_EOS)
        }
    }

    /**
     * How many pending packets the next page can hold.
     *
     * [packetsPerPage] is the usual answer, but the real limit is Ogg's: 255
     * lacing values per page, and a packet spends one lacing value per 255 bytes
     * plus one. At 24 kbps the 50 packets of a page need 50 lacing values, so
     * this never binds — which is exactly why it is worth enforcing rather than
     * asserting. If a codec ever emitted 300-byte packets, silently writing 256
     * lacing values into a byte-wide count would produce a file that looks fine
     * until a decoder reads the page. Flushing a short page instead costs 27
     * bytes and is always correct.
     */
    private fun packetsThatFitOnAPage(): Int {
        var lacingValues = 0
        var take = 0
        while (take < pending.size && take < packetsPerPage) {
            val needed = pending[take].size / MAX_LACING_VALUE + 1
            if (lacingValues + needed > MAX_LACING_VALUES) break
            lacingValues += needed
            take++
        }
        // Only reachable if a single packet needs more than 255 lacing values,
        // which append() rejects up front.
        check(take > 0) { "packet of ${pending.first().size} bytes cannot fit on a page" }
        return take
    }

    /**
     * Assemble one page — header, lacing table, payloads — CRC it and ship it.
     *
     * Layout (RFC 3533 §6): `"OggS"`, structure version 0, flags, granule as a
     * **signed** little-endian int64 (−1 means "no packet ends here"; we never
     * write it, but the field is signed and pretending otherwise would break the
     * day someone does), serial LE32, page sequence LE32, CRC LE32, the segment
     * count, then that many lacing bytes, then the payloads back to back.
     */
    private fun writePage(payloads: List<ByteArray>, granule: Long, flags: Int) {
        val lacing = ByteArrayOutputStream(payloads.size + 1)
        for (payload in payloads) {
            // 255 means "this packet continues"; the terminating value is the
            // remainder, which is why a 255-byte packet laces as `255, 0` — the
            // classic Ogg trap, and the reason the tests pin exactly that case.
            var remaining = payload.size
            while (remaining >= MAX_LACING_VALUE) {
                lacing.write(MAX_LACING_VALUE)
                remaining -= MAX_LACING_VALUE
            }
            lacing.write(remaining)
        }
        val lacingTable = lacing.toByteArray()
        check(lacingTable.size <= MAX_LACING_VALUES) {
            "page needs ${lacingTable.size} lacing values, the format allows $MAX_LACING_VALUES"
        }

        val payloadBytes = payloads.sumOf { it.size }
        val page = ByteBuffer
            .allocate(HEADER_BYTES + lacingTable.size + payloadBytes)
            .order(ByteOrder.LITTLE_ENDIAN)
        page.put(CAPTURE_PATTERN)
        page.put(0)                       // stream structure version
        page.put(flags.toByte())
        page.putLong(granule)
        page.putInt(serial)
        page.putInt(pageSequence)
        page.putInt(0)                    // CRC placeholder, patched below
        page.put(lacingTable.size.toByte())
        page.put(lacingTable)
        for (payload in payloads) page.put(payload)

        val bytes = page.array()
        // The CRC covers the whole page with its own field zeroed — which it
        // still is, because we only ever wrote the placeholder.
        val crc = oggCrc(bytes)
        bytes[CRC_OFFSET] = crc.toByte()
        bytes[CRC_OFFSET + 1] = (crc ushr 8).toByte()
        bytes[CRC_OFFSET + 2] = (crc ushr 16).toByte()
        bytes[CRC_OFFSET + 3] = (crc ushr 24).toByte()

        pageSequence++
        pageCount++
        sink(bytes)
    }

    companion object {
        /** Ogg page capture pattern, the four bytes a resync scans for. */
        private val CAPTURE_PATTERN = byteArrayOf(
            'O'.code.toByte(), 'g'.code.toByte(), 'g'.code.toByte(), 'S'.code.toByte(),
        )

        /** Fixed part of a page header, up to and including the segment count. */
        private const val HEADER_BYTES = 27
        private const val CRC_OFFSET = 22

        private const val FLAG_NONE = 0x00
        private const val FLAG_BOS = 0x02
        private const val FLAG_EOS = 0x04

        /** Segment table limits: 255 values per page, 255 as the "continues" value. */
        private const val MAX_LACING_VALUES = 255
        private const val MAX_LACING_VALUE = 255

        /**
         * The largest packet that can occupy a page on its own: 254 full lacing
         * values plus a terminator below 255. Real Opus packets top out around
         * 1275 bytes, so this is a guard rail, not a constraint.
         */
        const val MAX_PACKET_BYTES =
            (MAX_LACING_VALUES - 1) * MAX_LACING_VALUE + (MAX_LACING_VALUE - 1)

        /**
         * One 20 ms Opus packet in granule units. Ogg/Opus counts granules at 48
         * kHz *whatever the input rate* (RFC 7845 §4), so this is 960 for our
         * 16 kHz capture exactly as it is for a 48 kHz one — the same constant as
         * iOS's `granulePerPacket` and desktop's `GRANULE_PER_FRAME`.
         */
        const val GRANULE_PER_PACKET = 960L

        /**
         * Opus frame durations in 48 kHz granule units, indexed the way RFC 6716
         * §3.1 lays the configurations out: SILK cycles 10/20/40/60 ms, hybrid
         * 10/20 ms, CELT 2.5/5/10/20 ms.
         */
        private val SILK_FRAME_SAMPLES = longArrayOf(480, 960, 1920, 2880)
        private val HYBRID_FRAME_SAMPLES = longArrayOf(480, 960)
        private val CELT_FRAME_SAMPLES = longArrayOf(120, 240, 480, 960)

        /**
         * Opus look-ahead: 312 samples at 48 kHz = 6.5 ms. The value desktop
         * hard-codes; the default here for encoders that do not report their own.
         */
        const val OPUS_PRE_SKIP = 312

        /** ~1 s of audio per page at 20 ms packets, matching iOS's `pageSize`. */
        const val PACKETS_PER_PAGE = 50

        private const val DEFAULT_VENDOR = "Parley Android"

        /** `OpusHead` is fixed-size for channel mapping family 0. */
        internal const val OPUS_HEAD_BYTES = 19

        /**
         * The 19-byte `OpusHead` identification header, byte-for-byte what
         * `src-tauri/src/replay_audio.rs`'s `build_opus_head` and iOS's
         * `writeHeaderPages` produce: version 1, mono, pre-skip, original input
         * rate, 0 dB output gain, channel mapping family 0.
         *
         * This is the single copy in the Android app; [OggOpusEncoder] used to
         * carry an identical one for `MediaMuxer`'s `csd-0` and no longer needs it.
         */
        internal fun buildOpusHead(
            preSkip: Int = OPUS_PRE_SKIP,
            inputSampleRate: Int = Pcm.SAMPLE_RATE,
        ): ByteArray = ByteBuffer.allocate(OPUS_HEAD_BYTES).order(ByteOrder.LITTLE_ENDIAN).apply {
            put('O'.code.toByte())
            put('p'.code.toByte())
            put('u'.code.toByte())
            put('s'.code.toByte())
            put('H'.code.toByte())
            put('e'.code.toByte())
            put('a'.code.toByte())
            put('d'.code.toByte())
            put(1)                          // version
            put(1)                          // channel count (mono)
            putShort(preSkip.toShort())     // pre-skip, 48 kHz samples
            putInt(inputSampleRate)         // original input rate
            putShort(0)                     // output gain, Q7.8
            put(0)                          // channel mapping family
        }.array()

        /**
         * The `OpusTags` comment header: the magic, a length-prefixed vendor
         * string and an empty user-comment list. Mandatory even though we have
         * nothing to say — a stream without it is not Ogg/Opus.
         */
        internal fun buildOpusTags(vendor: String): ByteArray {
            val vendorBytes = vendor.toByteArray(Charsets.UTF_8)
            return ByteBuffer.allocate(8 + 4 + vendorBytes.size + 4)
                .order(ByteOrder.LITTLE_ENDIAN).apply {
                    put('O'.code.toByte())
                    put('p'.code.toByte())
                    put('u'.code.toByte())
                    put('s'.code.toByte())
                    put('T'.code.toByte())
                    put('a'.code.toByte())
                    put('g'.code.toByte())
                    put('s'.code.toByte())
                    putInt(vendorBytes.size)
                    put(vendorBytes)
                    putInt(0)               // user comment count
                }.array()
        }

        /**
         * Ogg's CRC-32 — **not** the one in `java.util.zip.CRC32`.
         *
         * Same polynomial (`0x04C11DB7`), everything else different: initial
         * value 0 instead of all-ones, no bit reflection of input or output, and
         * no final xor. Reaching for `java.util.zip` here produces a checksum
         * that is wrong in a way nothing on the device notices — the file writes,
         * plays back on a forgiving decoder, and gets rejected by ffmpeg on the
         * server. Ported from iOS's `oggCRC`.
         */
        internal fun oggCrc(data: ByteArray): Int {
            var crc = 0
            for (byte in data) {
                val index = ((crc ushr 24) xor (byte.toInt() and 0xFF)) and 0xFF
                crc = (crc shl 8) xor CRC_TABLE[index]
            }
            return crc
        }

        /**
         * Byte-at-a-time table for [oggCrc]. Built once; the bitwise form is
         * eight branches per byte and this runs over every byte of every
         * recording, which for an hour-long meeting is ~10 MB.
         */
        private val CRC_TABLE = IntArray(256) { index ->
            var value = index shl 24
            repeat(8) {
                value = if (value and Int.MIN_VALUE != 0) {
                    (value shl 1) xor 0x04C1_1DB7
                } else {
                    value shl 1
                }
            }
            value
        }
    }
}
