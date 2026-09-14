package com.pathors.parley.audio

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * On-device checks for the one thing [OggStreamWriter] takes on faith.
 *
 * ## The assumption under test
 *
 * [OggStreamWriter.GRANULE_PER_PACKET] is 960 — every packet handed to the
 * writer is treated as exactly 20 ms of audio, and [OggOpusEncoder.writePacket]
 * hands it one packet per `MediaCodec` output buffer. So the container's clock is
 * correct only if *one output buffer is one 20 ms Opus packet*. If a device's
 * encoder ever bundled several frames into a buffer, nothing would throw: the
 * file would still be valid Ogg, still play, and its timeline would simply run
 * slow by the bundling factor. The symptom reaches the user as transcript
 * timestamps drifting out of sync with playback — and tapping a transcript line
 * to seek is the app's core interaction.
 *
 * ## Why this has to be an instrumented test
 *
 * `OggStreamWriterTest` covers the container arithmetic on the JVM, and it
 * cannot cover this: the question is not "does the writer count correctly" but
 * "does `MediaCodec` emit what the writer is counting". That needs the real
 * platform codec. It also cannot be reached through `MeetingSession.capture()`,
 * which returns early without a cloud token, so these tests drive the encoder
 * directly — no auth, no session, no microphone.
 *
 * ## Reading a failure
 *
 * Every test logs a full measurement dump under [TAG] before it asserts, and
 * repeats it in the failure message. A failure here is a finding about the
 * device, not a broken test: the numbers to look at are the output-buffer count
 * against the frame count, `frames per packet` from the TOC bytes, and
 * `actualGranule` against `assumedGranule`.
 */
@RunWith(AndroidJUnit4::class)
class OggOpusEncoderDeviceTest {

    private val cacheDir: File
        get() = InstrumentationRegistry.getInstrumentation().targetContext.cacheDir

    /**
     * One `MediaCodec` output buffer is one 20 ms Opus packet.
     *
     * Ten seconds of 16 kHz mono sine goes in as 500 frames of exactly 20 ms;
     * 500 output buffers must come out, each declaring a single 20 ms frame in
     * its TOC byte. The TOC check is the substantive half — a codec could emit
     * 500 buffers that each held two 10 ms frames and the count alone would look
     * fine while the granule was still wrong.
     */
    @Test
    fun oneOutputBufferIsOneTwentyMillisecondPacket() {
        val pcm = OpusProbe.sine(durationMs = TEST_DURATION_MS)
        assertEquals(
            "sine generator produced the wrong number of bytes",
            TEST_DURATION_MS.toLong() * Pcm.BYTES_PER_SECOND / 1000,
            pcm.size.toLong(),
        )

        val run = OpusProbe.encode(pcm)
        val report = buildString {
            appendLine("--- MediaCodec Opus packetisation ---")
            appendLine("all Opus encoders on device: ${OpusProbe.allOpusEncoders()}")
            appendLine("selected by findEncoderForFormat: ${OpusProbe.selectEncoderName()}")
            append(run.summary())
        }
        Log.i(TAG, report)

        val inputFrames = TEST_DURATION_MS / FRAME_MS
        assertEquals(
            "$report\nQueued frame count should equal the PCM's 20 ms frames.",
            inputFrames,
            run.framesQueued,
        )

        // The encoder has to cover the input *plus* its own pre-skip, and it can
        // only do that in whole 20 ms packets — so an exact multiple of 20 ms in
        // yields one extra packet out, and that is correct rather than a frame
        // being duplicated. The bound stays tight on purpose: an encoder that
        // bundled two frames per buffer would emit ~250 and an encoder that
        // dropped frames would emit fewer, and both must fail here.
        assertTrue(
            "$report\nExpected one output buffer per 20 ms frame (plus at most a " +
                "pre-skip packet), i.e. $inputFrames..${inputFrames + 2}, but the codec " +
                "emitted ${run.packetCount}. Far fewer means the encoder is bundling " +
                "frames into buffers, and OggStreamWriter.GRANULE_PER_PACKET=960 is " +
                "then wrong for this device.",
            run.packetCount in inputFrames..(inputFrames + 2),
        )

        val bundled = run.packets.filter { it.samples48k != FRAME_SAMPLES_48K }
        assertTrue(
            "$report\n${bundled.size} of ${run.packetCount} packets are not a single " +
                "20 ms (960-sample) frame. First offenders: " +
                bundled.take(5).joinToString("; ") +
                "\nThat is precisely the silent failure this test exists to catch: " +
                "granule positions would be computed as 960 per packet while the " +
                "audio is worth ${bundled.firstOrNull()?.samples48k} samples.",
            bundled.isEmpty(),
        )

        // The assertion this whole file exists for. Exact equality, no tolerance:
        // these two numbers are the audio's real duration and the duration
        // production infers from the buffer count, and every millisecond they
        // differ by is a millisecond the transcript and the playhead disagree.
        assertEquals(
            "$report\nGranule the packets are worth must equal the granule production " +
                "assumes at 960 per output buffer.",
            run.actualSamples48k,
            run.assumedSamples48k,
        )
        assertTrue(
            "$report\nTotal granule ${run.actualSamples48k} is more than one packet away " +
                "from the ${TEST_DURATION_MS.toLong() * 48} samples of audio encoded.",
            Math.abs(run.actualSamples48k - TEST_DURATION_MS.toLong() * 48) <=
                FRAME_SAMPLES_48K,
        )
    }

    /**
     * A file written by the production encoder is as long as the audio put in.
     *
     * Checked three independent ways, because the interesting failure is one
     * where the file is internally consistent and still wrong: the last page's
     * granule (what a player seeks by), the sum of the packets' own TOC-declared
     * durations (what the audio is really worth), and the PCM a real decoder
     * emits (what a listener hears). The bug this guards against moves the first
     * of those without moving the third.
     */
    @Test
    fun writtenFileHasTheDurationOfItsInput() {
        val pcm = OpusProbe.sine(durationMs = TEST_DURATION_MS)
        val file = File(cacheDir, "device-duration.ogg")
        val encoder = OggOpusEncoder.create(file)
        encoder.append(pcm)
        val written = encoder.finish()

        val bytes = written.readBytes()
        val pages = OpusProbe.parse(bytes)
        val packets = OpusProbe.packetsOf(pages)
        val preSkip = OpusProbe.preSkipOf(pages.first().payload)
        val lastGranule = pages.last().granule
        val tocSamples = packets.sumOf { OpusProbe.describe(it).samples48k.toLong() }
        val decoded = OpusProbe.decode(written)

        val granuleMs = (lastGranule - (preSkip ?: 0)) * 1000 / 48_000
        val tocMs = tocSamples * 1000 / 48_000

        val report = buildString {
            appendLine("--- written file ---")
            appendLine("file=${written.name} bytes=${bytes.size}")
            appendLine("pages=${pages.size} audioPackets=${packets.size}")
            appendLine("preSkip=$preSkip")
            appendLine("lastGranule=$lastGranule -> ${granuleMs}ms")
            appendLine("sum of TOC durations=$tocSamples samples -> ${tocMs}ms")
            appendLine("assuming 960/packet=${packets.size * 960L} samples")
            appendLine("decoded: $decoded")
            appendLine("eos on last page=${pages.last().isEos} bos on first=${pages.first().isBos}")
            appendLine("pages with a continued packet: ${pages.count { it.continued }}")
        }
        Log.i(TAG, report)

        assertTrue(
            "$report\nEvery page must carry a valid Ogg CRC.",
            pages.all { OpusProbe.crcOk(bytes, it) },
        )
        val inputFrames = TEST_DURATION_MS / FRAME_MS
        assertTrue(
            "$report\nExpected one audio packet per 20 ms of input (plus at most a " +
                "pre-skip packet): $inputFrames..${inputFrames + 2}, got ${packets.size}.",
            packets.size in inputFrames..(inputFrames + 2),
        )
        assertTrue(
            "$report\nEvery packet in the file must be a single 20 ms frame, or the " +
                "960-per-packet granule arithmetic does not describe this file.",
            packets.all { OpusProbe.describe(it).samples48k == FRAME_SAMPLES_48K },
        )
        assertEquals(
            "$report\nThe last page's granule must agree with what the packets are " +
                "actually worth. A mismatch means the file's clock is wrong — playback " +
                "and transcript timestamps drift apart with no error anywhere.",
            tocSamples,
            lastGranule - (preSkip ?: 0),
        )
        assertTrue(
            "$report\nGranule duration ${granuleMs}ms is more than one packet away " +
                "from the ${TEST_DURATION_MS}ms of audio encoded.",
            Math.abs(granuleMs - TEST_DURATION_MS) <= FRAME_MS,
        )
        assertTrue(
            "$report\nA real decoder produced ${decoded.decodedMs}ms of PCM for " +
                "${TEST_DURATION_MS}ms of input.",
            Math.abs(decoded.decodedMs - TEST_DURATION_MS) <= DECODE_TOLERANCE_MS,
        )
    }

    /**
     * A file cut short is a recording that ends early, not a broken one.
     *
     * This is the entire reason `MediaMuxer` was dropped: a muxer file is only a
     * file after `stop()`, so a recorder killed mid-meeting left nothing to
     * recover. Hand-written Ogg pages are supposed to make the file readable up
     * to the last complete page. Cut at a page boundary and mid-page, and both
     * must still decode — a truncation-tolerant format that is only tolerant on
     * the developer's laptop would not save anybody's meeting.
     */
    @Test
    fun aTruncatedFileStillDecodes() {
        val pcm = OpusProbe.sine(durationMs = TEST_DURATION_MS)
        val full = File(cacheDir, "device-truncation.ogg")
        val encoder = OggOpusEncoder.create(full)
        encoder.append(pcm)
        encoder.finish()

        val bytes = full.readBytes()
        val pages = OpusProbe.parse(bytes)
        val preSkip = OpusProbe.preSkipOf(pages.first().payload) ?: 0
        val fullDecoded = OpusProbe.decode(full)

        // Cut roughly halfway, on the boundary of a real audio page.
        val target = preSkip + TEST_DURATION_MS.toLong() * 48 / 2
        val cutPage = pages
            .filter { !it.isBos && it.granule > 0 && !it.isEos }
            .minByOrNull { Math.abs(it.granule - target) }
            ?: error("no audio page to cut at; pages=${pages.size}")
        val cutIndex = pages.indexOf(cutPage)
        val nextPage = pages.getOrNull(cutIndex + 1)
            ?: error("cut page is the last page; nothing to truncate")

        val survivingMs = (cutPage.granule - preSkip) * 1000 / 48_000

        val onBoundary = File(cacheDir, "device-truncation-boundary.ogg")
        onBoundary.writeBytes(bytes.copyOfRange(0, cutPage.endOffset))

        // Mid-page: keep everything through cutPage, then half of the next page's
        // bytes — a header and a lacing table with no payload behind them, which
        // is exactly the shape a process killed mid-write leaves.
        val midOffset = cutPage.endOffset + (nextPage.length / 2).coerceAtLeast(1)
        val midPage = File(cacheDir, "device-truncation-midpage.ogg")
        midPage.writeBytes(bytes.copyOfRange(0, midOffset))

        val boundaryDecoded = OpusProbe.decode(onBoundary)
        val midDecoded = OpusProbe.decode(midPage)

        val report = buildString {
            appendLine("--- truncation ---")
            appendLine("full: ${bytes.size} bytes, ${pages.size} pages, $fullDecoded")
            appendLine("preSkip=$preSkip")
            appendLine(
                "cut page: index=$cutIndex seq=${cutPage.sequence} " +
                    "granule=${cutPage.granule} endOffset=${cutPage.endOffset} " +
                    "-> surviving audio ${survivingMs}ms",
            )
            appendLine("next page: length=${nextPage.length}, mid cut at $midOffset")
            appendLine("boundary cut: ${onBoundary.length()} bytes, $boundaryDecoded")
            appendLine("mid-page cut: ${midPage.length()} bytes, $midDecoded")
            appendLine(
                "pages parsed after boundary cut=${
                    OpusProbe.parse(onBoundary.readBytes()).size
                }, after mid cut=${OpusProbe.parse(midPage.readBytes()).size}",
            )
        }
        Log.i(TAG, report)

        assertEquals(
            "$report\nA mid-page cut must leave the same number of *complete* pages " +
                "as the boundary cut — the half-written page is simply not a page yet.",
            OpusProbe.parse(onBoundary.readBytes()).size,
            OpusProbe.parse(midPage.readBytes()).size,
        )

        for ((label, decoded) in listOf(
            "page boundary" to boundaryDecoded,
            "mid-page" to midDecoded,
        )) {
            assertTrue(
                "$report\nTruncated at $label the file decoded to " +
                    "${decoded.decodedMs}ms of audio. Nothing came out, so a recording " +
                    "interrupted by the process dying would still be unrecoverable — " +
                    "which is the failure hand-written Ogg pages were adopted to fix.",
                decoded.decodedFrames > 0,
            )
            assertTrue(
                "$report\nTruncated at $label decoded ${decoded.decodedMs}ms, which is " +
                    "not shorter than the full ${fullDecoded.decodedMs}ms.",
                decoded.decodedMs < fullDecoded.decodedMs,
            )
            assertTrue(
                "$report\nTruncated at $label decoded only ${decoded.decodedMs}ms, but " +
                    "${survivingMs}ms of audio sits in complete, CRC-valid pages. Losing " +
                    "audio that reached the disk intact is the whole failure this design " +
                    "was meant to remove.",
                decoded.decodedMs >= survivingMs - TRUNCATION_TOLERANCE_MS,
            )
        }

        // A cut on a page boundary is the clean case: the file ends exactly where
        // the last complete page says it does.
        assertTrue(
            "$report\nA boundary-truncated file should decode to the granule of its " +
                "last complete page (${survivingMs}ms), not ${boundaryDecoded.decodedMs}ms.",
            Math.abs(boundaryDecoded.decodedMs - survivingMs) <= TRUNCATION_TOLERANCE_MS,
        )

        // A cut *inside* a page may recover more than the complete pages carry:
        // Android's OggExtractor reads the half-written page's header and lacing
        // table and salvages whichever packets' payloads are fully present. That
        // is strictly better than the guarantee this design needs, so the check is
        // an upper bound only — what must never happen is recovering *less* than
        // the complete pages hold (asserted above) or more than was recorded.
        assertTrue(
            "$report\nA mid-page cut decoded ${midDecoded.decodedMs}ms, which exceeds " +
                "the full recording's ${fullDecoded.decodedMs}ms — the extractor cannot " +
                "have found audio that was never written.",
            midDecoded.decodedMs <= fullDecoded.decodedMs,
        )
    }

    private companion object {
        const val TAG = "OpusProbe"

        /** Ten seconds is long enough for ten pages of 50 packets, short enough to be quick. */
        const val TEST_DURATION_MS = 10_000

        const val FRAME_MS = 20
        const val FRAME_SAMPLES_48K = 960

        /**
         * Decoders are allowed a little slack at the edges — pre-skip trimming and
         * end-trimming are decoder-side policy, and two packets of tolerance keeps
         * this test about the container's clock rather than about that policy. The
         * bug being hunted moves the duration by a *factor*, not by 40 ms.
         */
        const val DECODE_TOLERANCE_MS = 40L

        /**
         * A truncated stream additionally loses whatever the last complete page's
         * granule does not cover, and has no end-of-stream page to trim by.
         */
        const val TRUNCATION_TOLERANCE_MS = 100L
    }
}
