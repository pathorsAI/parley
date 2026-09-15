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
        val codecName = selectEncoderName()
        val codec = if (codecName != null) {
            MediaCodec.createByCodecName(codecName)
        } else {
            MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS)
        }
        val resolvedName = codec.name

        val format = MediaFormat.createAudioFormat(
            MediaFormat.MIMETYPE_AUDIO_OPUS, Pcm.SAMPLE_RATE, 1,
        ).apply {
            setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
            setInteger(MediaFormat.KEY_PCM_ENCODING, Pcm.ENCODING_PCM_16BIT)
        }

        val frameBytes = OggOpusEncoder.FRAME_BYTES
        val packets = mutableListOf<Packet>()
        var reportedPreSkip: Int? = null
        var framesQueued = 0

        try {
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            codec.start()

            val info = MediaCodec.BufferInfo()
            var offset = 0
            var inputDone = false
            var outputDone = false

            fun drain(timeoutUs: Long) {
                while (true) {
                    val index = codec.dequeueOutputBuffer(info, timeoutUs)
                    when {
                        index >= 0 -> {
                            val isConfig =
                                (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0
                            val buffer = codec.getOutputBuffer(index)
                            if (buffer != null && info.size > 0) {
                                buffer.clear()
                                buffer.position(info.offset)
                                buffer.limit(info.offset + info.size)
                                val bytes = ByteArray(info.size)
                                buffer.get(bytes)
                                if (isConfig) {
                                    reportedPreSkip = reportedPreSkip ?: preSkipOf(bytes)
                                } else {
                                    packets += describe(bytes, info.presentationTimeUs)
                                }
                            }
                            if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                                outputDone = true
                            }
                            codec.releaseOutputBuffer(index, false)
                            if (outputDone) return
                        }

                        index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                            if (reportedPreSkip == null) {
                                reportedPreSkip = preSkipOf(codec.outputFormat)
                            }
                        }

                        else -> return
                    }
                }
            }

            while (!outputDone) {
                if (!inputDone) {
                    val index = codec.dequeueInputBuffer(10_000L)
                    if (index >= 0) {
                        val buffer = codec.getInputBuffer(index)!!
                        if (offset < pcm.size) {
                            val n = minOf(frameBytes, pcm.size - offset)
                            buffer.clear()
                            buffer.put(pcm, offset, n)
                            codec.queueInputBuffer(
                                index, 0, n, framesQueued * 20_000L, 0,
                            )
                            offset += n
                            framesQueued++
                        } else {
                            codec.queueInputBuffer(
                                index, 0, 0, framesQueued * 20_000L,
                                MediaCodec.BUFFER_FLAG_END_OF_STREAM,
                            )
                            inputDone = true
                        }
                    }
                }
                drain(if (inputDone) 10_000L else 0L)
            }
        } finally {
            runCatching { codec.stop() }
            runCatching { codec.release() }
        }

        return EncodeRun(
            codecName = resolvedName,
            isSoftware = resolvedName.contains(".google.") ||
                resolvedName.startsWith("c2.android.") ||
                resolvedName.startsWith("OMX.google."),
            framesQueued = framesQueued,
            packets = packets,
            reportedPreSkip = reportedPreSkip,
        )
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
        while (offset + 27 <= bytes.size) {
            if (bytes[offset] != 'O'.code.toByte() ||
                bytes[offset + 1] != 'g'.code.toByte() ||
                bytes[offset + 2] != 'g'.code.toByte() ||
                bytes[offset + 3] != 'S'.code.toByte()
            ) {
                break
            }
            val header = ByteBuffer.wrap(bytes, offset, 27).order(ByteOrder.LITTLE_ENDIAN)
            val version = header.get(offset + 4).toInt() and 0xFF
            if (version != 0) break
            val flags = header.get(offset + 5).toInt() and 0xFF
            val granule = header.getLong(offset + 6)
            val serial = header.getInt(offset + 14)
            val sequence = header.getInt(offset + 18)
            val segCount = bytes[offset + 26].toInt() and 0xFF
            if (offset + 27 + segCount > bytes.size) break

            var payloadBytes = 0
            val packetSizes = mutableListOf<Int>()
            var running = 0
            for (i in 0 until segCount) {
                val lace = bytes[offset + 27 + i].toInt() and 0xFF
                payloadBytes += lace
                running += lace
                if (lace < 255) {
                    packetSizes += running
                    running = 0
                }
            }
            val continued = segCount > 0 &&
                (bytes[offset + 27 + segCount - 1].toInt() and 0xFF) == 255
            val length = 27 + segCount + payloadBytes
            if (offset + length > bytes.size) break

            pages += Page(
                offset = offset,
                length = length,
                sequence = sequence,
                granule = granule,
                flags = flags,
                serial = serial,
                packetSizes = packetSizes,
                continued = continued,
                payload = bytes.copyOfRange(
                    offset + 27 + segCount, offset + 27 + segCount + payloadBytes,
                ),
            )
            offset += length
        }
        return pages
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

        val extractorDurationUs =
            if (format.containsKey(MediaFormat.KEY_DURATION)) {
                format.getLong(MediaFormat.KEY_DURATION)
            } else {
                null
            }

        val codec = MediaCodec.createDecoderByType(mime)
        var decodedBytes = 0L
        var sampleCount = 0
        var outRate = 0
        var outChannels = 0
        var bytesPerSample = 2

        try {
            codec.configure(format, null, null, 0)
            codec.start()
            val info = MediaCodec.BufferInfo()
            var inputDone = false
            var outputDone = false
            var guard = 0

            while (!outputDone && guard++ < 100_000) {
                if (!inputDone) {
                    val index = codec.dequeueInputBuffer(10_000L)
                    if (index >= 0) {
                        val buffer = codec.getInputBuffer(index)!!
                        buffer.clear()
                        val size = extractor.readSampleData(buffer, 0)
                        if (size < 0) {
                            codec.queueInputBuffer(
                                index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM,
                            )
                            inputDone = true
                        } else {
                            codec.queueInputBuffer(
                                index, 0, size, extractor.sampleTime, 0,
                            )
                            sampleCount++
                            extractor.advance()
                        }
                    }
                }
                val index = codec.dequeueOutputBuffer(info, 10_000L)
                when {
                    index >= 0 -> {
                        if (info.size > 0 &&
                            (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0
                        ) {
                            decodedBytes += info.size
                        }
                        if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                            outputDone = true
                        }
                        codec.releaseOutputBuffer(index, false)
                    }

                    index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                        val out = codec.outputFormat
                        outRate = out.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                        outChannels = out.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
                        bytesPerSample = if (out.containsKey(MediaFormat.KEY_PCM_ENCODING)) {
                            Pcm.bytesPerSample(out.getInteger(MediaFormat.KEY_PCM_ENCODING))
                                .takeIf { it > 0 } ?: 2
                        } else {
                            2
                        }
                    }
                }
            }
        } finally {
            runCatching { codec.stop() }
            runCatching { codec.release() }
            runCatching { extractor.release() }
        }

        if (outRate == 0) outRate = 48_000
        if (outChannels == 0) outChannels = 1

        return DecodeResult(
            extractorDurationUs = extractorDurationUs,
            decodedFrames = decodedBytes / (bytesPerSample.toLong() * outChannels),
            sampleRate = outRate,
            channels = outChannels,
            sampleCount = sampleCount,
        )
    }
}
