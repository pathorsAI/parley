package com.pathors.parley.audio

import android.media.MediaCodec
import android.media.MediaCodecList
import android.media.MediaExtractor
import android.media.MediaFormat
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.sin

/**
 * Read-only instruments for the device tests: they measure what `MediaCodec` and
 * the Ogg files actually contain, and nothing here knows what the answer is
 * supposed to be.
 *
 * The distinction matters because these tests exist to check an assumption in
 * production code ([OggStreamWriter.GRANULE_PER_PACKET] — "one `MediaCodec`
 * output buffer is one 20 ms Opus packet"). A helper that computed durations the
 * same way the writer does would agree with the writer by construction and prove
 * nothing. So every duration here is derived independently: from the Opus TOC
 * byte (RFC 6716 §3.1), from the Ogg page headers on disk (RFC 3533 §6), or from
 * counting PCM bytes out of a decoder.
 */
object OpusProbe {

    /**
     * How long to wait on a `MediaCodec` buffer before turning to the other end
     * of the codec: the same 10 ms the production encoder uses.
     */
    private const val DEQUEUE_TIMEOUT_US = 10_000L

    /** One 20 ms frame, in microseconds, for the input timestamps. */
    private const val FRAME_DURATION_US = 20_000L

    /** The fixed part of an Ogg page header, before the lacing table (RFC 3533 §6). */
    private const val PAGE_HEADER_BYTES = 27

    /**
     * Turns of the decode loop before it gives up. A stall net, not a limit on
     * file length: at one 20 ms packet per turn it allows over half an hour.
     */
    private const val DECODE_LOOP_GUARD = 100_000

    // ------------------------------------------------------------------ PCM in

    /**
     * A sine wave in the internal capture format: 16 kHz mono s16le.
     *
     * Deliberately not silence. An encoder handed nothing but zeros is free to
     * emit degenerate 1-byte DTX packets, which would both flatter the packet
     * count and hide bundling behaviour — the opposite of what these tests are
     * trying to observe.
     */
    fun sine(
        durationMs: Int,
        frequencyHz: Double = 440.0,
        amplitude: Double = 0.3,
        sampleRate: Int = Pcm.SAMPLE_RATE,
    ): ByteArray {
        val samples = sampleRate.toLong() * durationMs / 1000
        val buffer = ByteBuffer.allocate((samples * Pcm.BYTES_PER_SAMPLE).toInt())
            .order(ByteOrder.LITTLE_ENDIAN)
        for (i in 0 until samples) {
            val value = amplitude * sin(2.0 * PI * frequencyHz * i / sampleRate)
            buffer.putShort((value * Short.MAX_VALUE).toInt().toShort())
        }
        return buffer.array()
    }

    // ------------------------------------------------------- Opus packet shape

    /** One Opus packet as the encoder handed it over, with its self-described length. */
    data class Packet(
        /** Bytes in this output buffer. */
        val size: Int,
        /** `MediaCodec`'s own timestamp for the buffer, microseconds. */
        val presentationTimeUs: Long,
        /** The TOC byte, i.e. `(config shl 3) or (stereo shl 2) or frameCountCode`. */
        val toc: Int,
        /** Opus frames packed into this one packet, per the TOC. */
        val frames: Int,
        /** Duration of a single frame, in 48 kHz samples. */
        val frameSamples48k: Int,
    ) {
        /** What this packet is *actually* worth in granule units. */
        val samples48k: Int get() = frames * frameSamples48k

        val config: Int get() = toc ushr 3

        override fun toString() =
            "size=$size toc=0x${"%02x".format(toc)} config=$config frames=$frames " +
                "frameSamples=$frameSamples48k granule=$samples48k ptsUs=$presentationTimeUs"
    }

    /**
     * Decode the framing of an Opus packet from its TOC byte alone.
     *
     * This is the measurement the whole exercise turns on: production assumes
     * every packet is worth 960 samples, and the packet itself says how much it
     * is really worth. RFC 6716 §3.1: the TOC's top five bits select a
     * configuration (mode + bandwidth + frame duration) and the bottom two bits
     * say how many frames follow.
     */
    fun describe(packet: ByteArray, presentationTimeUs: Long = 0L): Packet {
        require(packet.isNotEmpty()) { "an Opus packet is never empty" }
        val toc = packet[0].toInt() and 0xFF
        val config = toc ushr 3
        val frames = when (toc and 0x03) {
            // code 0: one frame
            0 -> 1
            // code 1: two frames, equal size. code 2: two frames, sizes signalled
            1, 2 -> 2
            // code 3: arbitrary count, in the low six bits of the frame-count byte
            else -> {
                require(packet.size >= 2) { "code-3 packet with no frame-count byte" }
                packet[1].toInt() and 0x3F
            }
        }
        return Packet(
            size = packet.size,
            presentationTimeUs = presentationTimeUs,
            toc = toc,
            frames = frames,
            frameSamples48k = frameSamples48k(config),
        )
    }

    /**
     * Frame duration for an Opus configuration, in 48 kHz samples.
     *
     * RFC 6716 §3.1 table 2. Kept in samples rather than milliseconds so the
     * 2.5 ms CELT case stays an integer (120 samples) and granule arithmetic
     * never touches a float.
     */
    private fun frameSamples48k(config: Int): Int = when {
        // 0-11: SILK-only, 10/20/40/60 ms across NB, MB, WB
        config < 12 -> intArrayOf(480, 960, 1920, 2880)[config % 4]
        // 12-15: Hybrid, 10/20 ms across SWB, FB
        config < 16 -> intArrayOf(480, 960)[config % 2]
        // 16-31: CELT-only, 2.5/5/10/20 ms across NB, WB, SWB, FB
        else -> intArrayOf(120, 240, 480, 960)[config % 4]
    }

    // --------------------------------------------------------- encoder driving

    /** Everything one encode run revealed about the codec. */
    data class EncodeRun(
        /** The codec `MediaCodecList` picked, e.g. `c2.android.opus.encoder`. */
        val codecName: String,
        /** True when that name marks it as Google's software reference codec. */
        val isSoftware: Boolean,
        /** 20 ms PCM frames queued as input. */
        val framesQueued: Int,
        /** Every non-config output buffer, in order. */
        val packets: List<Packet>,
        /** Pre-skip the codec reported via `csd-0`, or null if it never did. */
        val reportedPreSkip: Int?,
    ) {
        /** Output buffers the codec produced. The number production assumes equals [framesQueued]. */
        val packetCount: Int get() = packets.size

        /** Granule the packets are really worth, summed from their own TOC bytes. */
        val actualSamples48k: Long get() = packets.sumOf { it.samples48k.toLong() }

        /** Granule production would compute: 960 per output buffer. */
        val assumedSamples48k: Long
            get() = packets.size * OggStreamWriter.GRANULE_PER_PACKET

        fun summary(): String = buildString {
            appendLine("codec=$codecName software=$isSoftware")
            appendLine("framesQueued=$framesQueued packets=$packetCount")
            appendLine("reportedPreSkip=$reportedPreSkip")
            appendLine("actualGranule=$actualSamples48k assumedGranule=$assumedSamples48k")
            appendLine("actualDurationMs=${actualSamples48k * 1000 / 48_000}")
            appendLine("assumedDurationMs=${assumedSamples48k * 1000 / 48_000}")
            val bySize = packets.groupingBy { it.size }.eachCount().toSortedMap()
            appendLine("packet sizes (size -> count): $bySize")
            val byFrames = packets.groupingBy { it.frames }.eachCount().toSortedMap()
            appendLine("frames per packet (frames -> count): $byFrames")
            val byConfig = packets.groupingBy { it.config }.eachCount().toSortedMap()
            appendLine("TOC config (config -> count): $byConfig")
            appendLine("first 5: " + packets.take(5).joinToString("; "))
            appendLine("last 5: " + packets.takeLast(5).joinToString("; "))
        }
    }

    /** Which Opus encoder this device would use for the production format. */
    fun selectEncoderName(): String? {
        val lookup = MediaFormat.createAudioFormat(
            MediaFormat.MIMETYPE_AUDIO_OPUS, Pcm.SAMPLE_RATE, 1,
        )
        return MediaCodecList(MediaCodecList.REGULAR_CODECS).findEncoderForFormat(lookup)
    }

    /** Every Opus encoder on the device, for the report. */
    fun allOpusEncoders(): List<String> =
        MediaCodecList(MediaCodecList.ALL_CODECS).codecInfos
            .filter { it.isEncoder && it.supportedTypes.any { t -> t.equals("audio/opus", true) } }
            .map { it.name }

    /**
     * Run `pcm` through a real `MediaCodec` Opus encoder, one 20 ms frame per
     * input buffer, and report every output buffer.
     *
     * Configured exactly as [OggOpusEncoder.create] configures it — same codec
     * selection, same format keys, same one-frame-per-buffer feeding — because a
     * test that configured it differently would be measuring a different codec
     * instance than the one that ships. What it does *not* share is
     * [OggOpusEncoder]'s assumption about the result: this counts buffers.
     */
    fun encode(pcm: ByteArray, bitrate: Int = OggOpusEncoder.DEFAULT_BITRATE): EncodeRun {
        val codec = createEncoder()
        // Asked of the codec rather than of the lookup, because the fallback path
        // does not say which implementation it landed on.
        val resolvedName = codec.name
        val feed = PcmFeed(pcm)
        val output = EncoderOutput()

        try {
            codec.configure(
                encoderFormat(bitrate), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE,
            )
            codec.start()

            val info = MediaCodec.BufferInfo()
            while (!output.sawEndOfStream) {
                if (!feed.inputDone) {
                    val index = codec.dequeueInputBuffer(DEQUEUE_TIMEOUT_US)
                    if (index >= 0) feed.queueInto(codec, index)
                }
                // While PCM is still going in, poll the output with a zero
                // timeout: the codec is entitled to have nothing ready yet and
                // blocking would only starve it of input. Once the end-of-stream
                // buffer is queued there is nothing left to do but wait, and
                // blocking is then what keeps this loop from spinning.
                drainEncoderOutput(
                    codec, info, if (feed.inputDone) DEQUEUE_TIMEOUT_US else 0L, output,
                )
            }
        } finally {
            runCatching { codec.stop() }
            runCatching { codec.release() }
        }

        return EncodeRun(
            codecName = resolvedName,
            isSoftware = isSoftwareCodec(resolvedName),
            framesQueued = feed.framesQueued,
            packets = output.packets,
            reportedPreSkip = output.reportedPreSkip,
        )
    }

    /**
     * The encoder [OggOpusEncoder.create] would get, found the same two ways it
     * finds one: ask `MediaCodecList` which codec handles the capture format, and
     * fall back to the platform default for the MIME type when it names none.
     */
    private fun createEncoder(): MediaCodec {
        val codecName = selectEncoderName()
        return if (codecName != null) {
            MediaCodec.createByCodecName(codecName)
        } else {
            MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS)
        }
    }

    /** The capture format, with the keys [OggOpusEncoder.create] configures. */
    private fun encoderFormat(bitrate: Int): MediaFormat =
        MediaFormat.createAudioFormat(
            MediaFormat.MIMETYPE_AUDIO_OPUS, Pcm.SAMPLE_RATE, 1,
        ).apply {
            setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
            setInteger(MediaFormat.KEY_PCM_ENCODING, Pcm.ENCODING_PCM_16BIT)
        }

    /**
     * True when the codec's name marks it as one of Google's software codecs.
     *
     * Reported, never asserted on. A vendor encoder that bundled frames is
     * exactly the device-specific failure these tests exist to catch, so the
     * report has to name which kind of codec produced the numbers.
     */
    private fun isSoftwareCodec(name: String): Boolean =
        name.contains(".google.") ||
            name.startsWith("c2.android.") ||
            name.startsWith("OMX.google.")

    /**
     * The PCM still waiting to go into the encoder, handed over one 20 ms frame
     * per input buffer.
     *
     * Its own object because the cursor, the frame count and "input finished"
     * advance together, and [drainEncoderOutput] has to be free to run between
     * any two frames.
     */
    private class PcmFeed(private val pcm: ByteArray) {
        /** Bytes already queued. */
        private var offset = 0

        /** 20 ms input buffers queued so far: one packet each, is what production assumes. */
        var framesQueued = 0
            private set

        /** True once the end-of-stream buffer is queued; nothing may follow it. */
        var inputDone = false
            private set

        /**
         * Fill one dequeued input buffer: the next 20 ms frame, or the empty
         * end-of-stream buffer once the PCM runs out.
         *
         * Timestamps come off the 20 ms grid the frames themselves imply rather
         * than from anything the codec reports, so the input clock stays
         * independent of the output clock under measurement.
         */
        fun queueInto(codec: MediaCodec, index: Int) {
            val buffer = codec.getInputBuffer(index)!!
            val presentationTimeUs = framesQueued * FRAME_DURATION_US
            if (offset < pcm.size) {
                // A trailing partial frame is queued short; the codec pads it.
                val n = minOf(OggOpusEncoder.FRAME_BYTES, pcm.size - offset)
                buffer.clear()
                buffer.put(pcm, offset, n)
                codec.queueInputBuffer(index, 0, n, presentationTimeUs, 0)
                offset += n
                framesQueued++
            } else {
                codec.queueInputBuffer(
                    index, 0, 0, presentationTimeUs,
                    MediaCodec.BUFFER_FLAG_END_OF_STREAM,
                )
                inputDone = true
            }
        }
    }

    /**
     * What one encode run produced, accumulated as the output buffers arrive.
     *
     * Everything here is a tally; nothing in it decides whether the numbers are
     * right. That judgement belongs to the assertions in the device test.
     */
    private class EncoderOutput {
        /** Every non-config output buffer, in the order the codec emitted it. */
        val packets = mutableListOf<Packet>()

        /** The first pre-skip the codec disclosed, from `csd-0` or the output format. */
        var reportedPreSkip: Int? = null

        /** True once a buffer carried `BUFFER_FLAG_END_OF_STREAM`. */
        var sawEndOfStream = false
    }

    /**
     * Take every output buffer the codec currently has ready, then return.
     *
     * A zero [timeoutUs] turns this into a poll, which is what lets [encode] keep
     * feeding input; it also returns the moment end of stream is seen, since no
     * buffer can follow that one.
     */
    private fun drainEncoderOutput(
        codec: MediaCodec,
        info: MediaCodec.BufferInfo,
        timeoutUs: Long,
        output: EncoderOutput,
    ) {
        while (true) {
            val index = codec.dequeueOutputBuffer(info, timeoutUs)
            when {
                index >= 0 -> {
                    takeEncodedBuffer(codec, info, index, output)
                    codec.releaseOutputBuffer(index, false)
                    if (output.sawEndOfStream) return
                }

                // The output format lands before the first packet and carries
                // `csd-0`, which is where the pre-skip usually shows up.
                index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED ->
                    output.reportedPreSkip =
                        output.reportedPreSkip ?: preSkipOf(codec.outputFormat)

                else -> return
            }
        }
    }

    /**
     * Copy one output buffer out of the codec and file it.
     *
     * The copy is deliberate: the buffer goes straight back to the codec
     * afterwards and every measurement here happens later, on bytes this process
     * owns. Config buffers hold `OpusHead` rather than audio, so they are read
     * for their pre-skip and kept out of the packet count.
     */
    private fun takeEncodedBuffer(
        codec: MediaCodec,
        info: MediaCodec.BufferInfo,
        index: Int,
        output: EncoderOutput,
    ) {
        val isConfig = (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0
        val buffer = codec.getOutputBuffer(index)
        if (buffer != null && info.size > 0) {
            buffer.clear()
            buffer.position(info.offset)
            buffer.limit(info.offset + info.size)
            val bytes = ByteArray(info.size)
            buffer.get(bytes)
            if (isConfig) {
                output.reportedPreSkip = output.reportedPreSkip ?: preSkipOf(bytes)
            } else {
                output.packets += describe(bytes, info.presentationTimeUs)
            }
        }
        if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
            output.sawEndOfStream = true
        }
    }

    private fun preSkipOf(format: MediaFormat): Int? = runCatching {
        if (!format.containsKey("csd-0")) return null
        val csd = format.getByteBuffer("csd-0") ?: return null
        val copy = ByteArray(csd.remaining())
        csd.duplicate().get(copy)
        preSkipOf(copy)
    }.getOrNull()

    /** Pre-skip out of an `OpusHead` blob, or null if it is not one. */
    fun preSkipOf(head: ByteArray): Int? {
        if (head.size < 19) return null
        if (String(head, 0, 8, Charsets.US_ASCII) != "OpusHead") return null
        return ByteBuffer.wrap(head).order(ByteOrder.LITTLE_ENDIAN)
            .getShort(10).toInt() and 0xFFFF
    }

    // ------------------------------------------------------------- Ogg on disk

    /** One Ogg page as it sits in the file. */
    data class Page(
        val offset: Int,
        val length: Int,
        val sequence: Int,
        val granule: Long,
        val flags: Int,
        val serial: Int,
        /** Sizes of the packets ending on this page, rebuilt from the lacing table. */
        val packetSizes: List<Int>,
        /** True when the last lacing value is 255, i.e. a packet continues onto the next page. */
        val continued: Boolean,
        val payload: ByteArray,
    ) {
        val isBos: Boolean get() = (flags and 0x02) != 0
        val isEos: Boolean get() = (flags and 0x04) != 0
        val endOffset: Int get() = offset + length
    }

    /**
     * Walk the Ogg pages of a file, stopping at the first thing that is not a
     * complete page.
     *
     * Truncated input is the normal case here, not an error: the third device
     * test cuts a file mid-page on purpose, and "how much of this file is still
     * well-formed" is exactly what it wants to know. So a short or corrupt tail
     * ends the walk rather than failing it, and [parse] additionally reports
     * whether the CRC of every page it returned checked out.
     */
    fun parse(bytes: ByteArray): List<Page> {
        val pages = mutableListOf<Page>()
        var offset = 0
        // Fewer than a fixed header's worth of bytes left cannot be a page at
        // all, complete or otherwise.
        while (offset + PAGE_HEADER_BYTES <= bytes.size) {
            val page = readPage(bytes, offset) ?: break
            pages += page
            offset += page.length
        }
        return pages
    }

    /**
     * Read the page that starts at [offset], or null if what sits there is not a
     * complete, well-formed page.
     *
     * Null covers every way the walk ends: no `OggS` capture pattern, a version
     * this parser does not claim to understand, or a header that promises more
     * bytes than the file still has. None of them is an error — [parse] explains
     * why truncation is the expected case here.
     */
    private fun readPage(bytes: ByteArray, offset: Int): Page? {
        if (!hasCapturePattern(bytes, offset)) return null

        // Absolute gets throughout, so every index below reads as "byte N of the
        // page header" straight out of RFC 3533 §6.
        val header = ByteBuffer.wrap(bytes, offset, PAGE_HEADER_BYTES)
            .order(ByteOrder.LITTLE_ENDIAN)
        val version = header[offset + 4].toInt() and 0xFF
        if (version != 0) return null

        val segCount = bytes[offset + 26].toInt() and 0xFF
        val lacingStart = offset + PAGE_HEADER_BYTES
        if (lacingStart + segCount > bytes.size) return null

        val lacing = readLacingTable(bytes, lacingStart, segCount)
        val length = PAGE_HEADER_BYTES + segCount + lacing.payloadBytes
        if (offset + length > bytes.size) return null

        val payloadStart = lacingStart + segCount
        return Page(
            offset = offset,
            length = length,
            sequence = header.getInt(offset + 18),
            granule = header.getLong(offset + 6),
            flags = header[offset + 5].toInt() and 0xFF,
            serial = header.getInt(offset + 14),
            packetSizes = lacing.packetSizes,
            continued = lacing.continued,
            payload = bytes.copyOfRange(payloadStart, payloadStart + lacing.payloadBytes),
        )
    }

    /** `OggS`, the four bytes every Ogg page begins with. */
    private fun hasCapturePattern(bytes: ByteArray, offset: Int): Boolean =
        bytes[offset] == 'O'.code.toByte() &&
            bytes[offset + 1] == 'g'.code.toByte() &&
            bytes[offset + 2] == 'g'.code.toByte() &&
            bytes[offset + 3] == 'S'.code.toByte()

    /** What a page's lacing table says about the packets sitting on that page. */
    private class Lacing(
        /** Payload bytes the table accounts for, i.e. the rest of the page. */
        val payloadBytes: Int,
        /** Sizes of the packets that *end* on this page. */
        val packetSizes: List<Int>,
        /** True when the table ends in 255, i.e. its last packet spills over. */
        val continued: Boolean,
    )

    /**
     * Rebuild packet boundaries from the [segCount] lacing values at [start].
     *
     * RFC 3533 §6: every value contributes 0..255 bytes of payload, and any value
     * below 255 terminates a packet. So a run of 255s is one packet continuing
     * and its size is the run's sum — which is also why a table whose last value
     * is 255 leaves a packet unfinished on this page.
     */
    private fun readLacingTable(bytes: ByteArray, start: Int, segCount: Int): Lacing {
        var payloadBytes = 0
        val packetSizes = mutableListOf<Int>()
        var running = 0
        var lastLace = 0
        for (i in 0 until segCount) {
            lastLace = bytes[start + i].toInt() and 0xFF
            payloadBytes += lastLace
            running += lastLace
            if (lastLace < 255) {
                packetSizes += running
                running = 0
            }
        }
        return Lacing(
            payloadBytes = payloadBytes,
            packetSizes = packetSizes,
            continued = segCount > 0 && lastLace == 255,
        )
    }

    /** The audio packets of a file, in order, rebuilt from its pages. */
    fun packetsOf(pages: List<Page>): List<ByteArray> {
        val out = mutableListOf<ByteArray>()
        for (page in pages) {
            if (page.isBos) continue
            var cursor = 0
            // An OpusTags page has one packet and no audio; skip it by content.
            val isTags = page.payload.size >= 8 &&
                String(page.payload, 0, 8, Charsets.US_ASCII) == "OpusTags"
            if (isTags) continue
            for (size in page.packetSizes) {
                if (cursor + size > page.payload.size) break
                out += page.payload.copyOfRange(cursor, cursor + size)
                cursor += size
            }
        }
        return out
    }

    /** Ogg's CRC over a page, recomputed with the stored field zeroed. */
    fun crcOk(bytes: ByteArray, page: Page): Boolean {
        val copy = bytes.copyOfRange(page.offset, page.endOffset)
        val stored = ByteBuffer.wrap(copy).order(ByteOrder.LITTLE_ENDIAN).getInt(22)
        for (i in 22..25) copy[i] = 0
        return OggStreamWriter.oggCrc(copy) == stored
    }

    // ------------------------------------------------------------- decode back

    /** What a real decoder made of a file. */
    data class DecodeResult(
        /** Duration `MediaExtractor` advertised, microseconds, or null if absent. */
        val extractorDurationUs: Long?,
        /** PCM frames (per channel) the decoder actually emitted. */
        val decodedFrames: Long,
        val sampleRate: Int,
        val channels: Int,
        /** Compressed samples the extractor handed to the decoder. */
        val sampleCount: Int,
    ) {
        val decodedMs: Long get() = if (sampleRate == 0) 0 else decodedFrames * 1000 / sampleRate

        override fun toString() =
            "extractorDurationUs=$extractorDurationUs decodedFrames=$decodedFrames " +
                "rate=$sampleRate ch=$channels samples=$sampleCount decodedMs=$decodedMs"
    }

    /**
     * Push a file through `MediaExtractor` + `MediaCodec` and count the PCM that
     * comes out the far end.
     *
     * Counting output bytes rather than trusting `KEY_DURATION` is the point: the
     * duration field is just the last granule the extractor found, so believing
     * it would test the writer's arithmetic against itself. Decoded PCM is the
     * independent measure — it is what a listener would actually hear.
     */
    fun decode(file: File): DecodeResult {
        val extractor = MediaExtractor()
        extractor.setDataSource(file.absolutePath)
        check(extractor.trackCount > 0) { "no tracks in ${file.name}" }
        val format = extractor.getTrackFormat(0)
        val mime = format.getString(MediaFormat.KEY_MIME)!!
        extractor.selectTrack(0)

        // Carried into the result for the report only. It is the last granule the
        // extractor found, i.e. the writer's own arithmetic read back, so nothing
        // asserts on it.
        val extractorDurationUs =
            if (format.containsKey(MediaFormat.KEY_DURATION)) {
                format.getLong(MediaFormat.KEY_DURATION)
            } else {
                null
            }

        val codec = MediaCodec.createDecoderByType(mime)
        val pcm = PcmTally()
        val sampleCount = try {
            codec.configure(format, null, null, 0)
            codec.start()
            runDecodeLoop(codec, extractor, pcm)
        } finally {
            runCatching { codec.stop() }
            runCatching { codec.release() }
            runCatching { extractor.release() }
        }

        return DecodeResult(
            extractorDurationUs = extractorDurationUs,
            decodedFrames = pcm.decodedFrames,
            sampleRate = pcm.sampleRate,
            channels = pcm.channels,
            sampleCount = sampleCount,
        )
    }

    /**
     * Pump the decoder until it says end of stream, and report how many
     * compressed samples went in.
     *
     * Input and output are driven from the same turn of the loop because
     * `MediaCodec` produces nothing once its input queue runs dry: draining to
     * exhaustion before feeding again would deadlock against itself.
     *
     * The iteration guard is a stall net rather than a limit on file length — see
     * [DECODE_LOOP_GUARD]. A decoder that stopped answering would otherwise hang
     * the whole test run instead of failing one assertion.
     */
    private fun runDecodeLoop(
        codec: MediaCodec,
        extractor: MediaExtractor,
        pcm: PcmTally,
    ): Int {
        val info = MediaCodec.BufferInfo()
        var sampleCount = 0
        var inputDone = false
        var guard = 0

        while (!pcm.sawEndOfStream && guard++ < DECODE_LOOP_GUARD) {
            if (!inputDone) {
                when (feedDecoder(codec, extractor)) {
                    InputStep.QUEUED_SAMPLE -> sampleCount++
                    InputStep.QUEUED_END_OF_STREAM -> inputDone = true
                    InputStep.NO_BUFFER -> Unit
                }
            }
            drainDecoderOutput(codec, info, pcm)
        }
        return sampleCount
    }

    /** What one attempt to hand the decoder something achieved. */
    private enum class InputStep {
        /** A compressed sample from the extractor went in. */
        QUEUED_SAMPLE,

        /** The track was exhausted, so the end-of-stream buffer went in instead. */
        QUEUED_END_OF_STREAM,

        /** The codec had no free input buffer this time round; try again later. */
        NO_BUFFER,
    }

    /**
     * Move the extractor's next compressed sample into the decoder.
     *
     * Reading straight into the codec's own input buffer is what `MediaExtractor`
     * expects: it copies the sample in, and `sampleTime` describes the sample
     * just read, which is why the timestamp is taken before `advance()`.
     */
    private fun feedDecoder(codec: MediaCodec, extractor: MediaExtractor): InputStep {
        val index = codec.dequeueInputBuffer(DEQUEUE_TIMEOUT_US)
        if (index < 0) return InputStep.NO_BUFFER

        val buffer = codec.getInputBuffer(index)!!
        buffer.clear()
        val size = extractor.readSampleData(buffer, 0)
        if (size < 0) {
            codec.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
            return InputStep.QUEUED_END_OF_STREAM
        }

        codec.queueInputBuffer(index, 0, size, extractor.sampleTime, 0)
        extractor.advance()
        return InputStep.QUEUED_SAMPLE
    }

    /**
     * Take at most one output buffer, or adopt the format the decoder announces
     * before the first of them.
     *
     * One buffer per call rather than a drain loop, so [runDecodeLoop] always
     * gets back to feeding input.
     */
    private fun drainDecoderOutput(
        codec: MediaCodec,
        info: MediaCodec.BufferInfo,
        pcm: PcmTally,
    ) {
        val index = codec.dequeueOutputBuffer(info, DEQUEUE_TIMEOUT_US)
        when {
            index >= 0 -> {
                pcm.take(info)
                codec.releaseOutputBuffer(index, false)
            }

            index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> pcm.adopt(codec.outputFormat)
        }
    }

    /**
     * PCM counted as the decoder emits it, plus the output format it arrived in.
     *
     * Bytes rather than the decoder's presentation timestamps, on purpose: those
     * timestamps come from the container's granule positions, so believing them
     * would be one more way of reading the writer's arithmetic back to itself.
     * Bytes that came out of the decoder are the independent measure.
     */
    private class PcmTally {
        /** PCM bytes emitted so far, codec-config buffers excluded. */
        var decodedBytes = 0L
            private set

        /** True once a buffer carried `BUFFER_FLAG_END_OF_STREAM`. */
        var sawEndOfStream = false
            private set

        private var reportedRate = 0
        private var reportedChannels = 0
        private var bytesPerSample = 2

        /**
         * Sample rate the decoder announced, or Opus's native 48 kHz if it never
         * announced one — which is what a file too short to reach an output
         * format change leaves behind.
         */
        val sampleRate: Int get() = if (reportedRate == 0) 48_000 else reportedRate

        /** Channel count the decoder announced, defaulting to mono for the same reason. */
        val channels: Int get() = if (reportedChannels == 0) 1 else reportedChannels

        /** PCM frames per channel — the only form a duration can be computed from. */
        val decodedFrames: Long get() = decodedBytes / (bytesPerSample.toLong() * channels)

        /** Fold one output buffer into the totals. */
        fun take(info: MediaCodec.BufferInfo) {
            if (info.size > 0 && (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
                decodedBytes += info.size
            }
            if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                sawEndOfStream = true
            }
        }

        /**
         * Record the format the decoder reports, so [decodedFrames] divides the
         * byte count by the right sample width and channel count.
         *
         * `KEY_PCM_ENCODING` is optional and a decoder that omits it means 16-bit,
         * which is also the fallback when it names an encoding of unknown width.
         */
        fun adopt(format: MediaFormat) {
            reportedRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            reportedChannels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            bytesPerSample = if (format.containsKey(MediaFormat.KEY_PCM_ENCODING)) {
                Pcm.bytesPerSample(format.getInteger(MediaFormat.KEY_PCM_ENCODING))
                    .takeIf { it > 0 } ?: 2
            } else {
                2
            }
        }
    }
}
