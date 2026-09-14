package com.pathors.parley.audio

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * The Ogg container written by hand, byte by byte.
 *
 * Everything here is a *file format* claim, which is the kind that fails
 * quietly: a wrong lacing byte, a reflected CRC or a granule that forgot the
 * pre-skip all produce a file that this app happily writes, some players
 * happily play, and the server's ffmpeg rejects — days later, with the meeting
 * already gone. So each test pins one field against the spec rather than
 * against our own implementation, and the CRC is re-derived here from the
 * polynomial instead of borrowing the production table.
 *
 * `an abandoned writer still leaves every flushed page complete and valid` is
 * the reason the class exists at all: when the app is killed mid-meeting,
 * finish() never runs, and what reached the disk has to be a recording.
 */
class OggStreamWriterTest {

    // ------------------------------------------------------------------ helpers

    /** A fixed serial keeps every byte of the output reproducible. */
    private val serial = 0x1234_5678

    /** Collects the pages a writer emits, in order. */
    private class Pages {
        val list = ArrayList<ByteArray>()
        fun sink(page: ByteArray) = list.add(page)
        fun bytes(): ByteArray {
            val out = ByteArray(list.sumOf { it.size })
            var at = 0
            for (page in list) {
                page.copyInto(out, at)
                at += page.size
            }
            return out
        }
    }

    private fun writer(
        pages: Pages,
        packetsPerPage: Int = 50,
        preSkip: Int = 312,
        inputSampleRate: Int = 16_000,
    ) = OggStreamWriter(
        sink = pages::sink,
        serial = serial,
        preSkip = preSkip,
        inputSampleRate = inputSampleRate,
        packetsPerPage = packetsPerPage,
    )

    /** A recognisable packet of a given size, so payload mix-ups are visible. */
    private fun packet(size: Int, seed: Int = 0) =
        ByteArray(size) { (seed * 31 + it).toByte() }

    /**
     * Ogg's CRC-32 done the slow, obvious way: poly 0x04C11DB7, init 0, no
     * reflection, no final xor. Deliberately *not* the production table — a
     * table generated from the wrong polynomial would agree with itself.
     */
    private fun oggCrc(data: ByteArray, from: Int = 0, to: Int = data.size): Int {
        var crc = 0
        for (i in from until to) {
            crc = crc xor ((data[i].toInt() and 0xFF) shl 24)
            repeat(8) {
                crc = if (crc and Int.MIN_VALUE != 0) (crc shl 1) xor 0x04C1_1DB7 else crc shl 1
            }
        }
        return crc
    }

    private fun le16(page: ByteArray, at: Int) =
        ByteBuffer.wrap(page).order(ByteOrder.LITTLE_ENDIAN).getShort(at).toInt() and 0xFFFF

    private fun le32(page: ByteArray, at: Int) =
        ByteBuffer.wrap(page).order(ByteOrder.LITTLE_ENDIAN).getInt(at)

    private fun le64(page: ByteArray, at: Int) =
        ByteBuffer.wrap(page).order(ByteOrder.LITTLE_ENDIAN).getLong(at)

    private fun flags(page: ByteArray) = page[5].toInt() and 0xFF
    private fun granule(page: ByteArray) = le64(page, 6)
    private fun sequence(page: ByteArray) = le32(page, 18)
    private fun segmentCount(page: ByteArray) = page[26].toInt() and 0xFF
    private fun lacing(page: ByteArray) =
        IntArray(segmentCount(page)) { page[27 + it].toInt() and 0xFF }

    private fun payload(page: ByteArray): ByteArray {
        val start = 27 + segmentCount(page)
        return page.copyOfRange(start, page.size)
    }

    /** Assert one page is internally consistent: magic, version, size, CRC. */
    private fun assertValidPage(page: ByteArray) {
        assertEquals("capture pattern", "OggS", String(page, 0, 4, Charsets.US_ASCII))
        assertEquals("structure version", 0, page[4].toInt())

        val segments = segmentCount(page)
        val declared = lacing(page).sum()
        assertEquals("page length implied by the lacing table", 27 + segments + declared, page.size)

        val zeroed = page.copyOf()
        for (i in 22 until 26) zeroed[i] = 0
        assertEquals("CRC", oggCrc(zeroed), le32(page, 22))
    }

    /**
     * Walk a byte stream as a sequence of pages, the way a decoder does, and
     * check every one. Fails if the stream ends mid-page — which is the property
     * these tests are really about.
     */
    private fun walkPages(bytes: ByteArray): List<ByteArray> {
        val found = ArrayList<ByteArray>()
        var at = 0
        while (at < bytes.size) {
            assertTrue("page header truncated at $at", at + 27 <= bytes.size)
            val segments = bytes[at + 26].toInt() and 0xFF
            assertTrue("lacing table truncated at $at", at + 27 + segments <= bytes.size)
            var body = 0
            for (i in 0 until segments) body += bytes[at + 27 + i].toInt() and 0xFF
            val end = at + 27 + segments + body
            assertTrue("payload truncated at $at", end <= bytes.size)
            val page = bytes.copyOfRange(at, end)
            assertValidPage(page)
            found.add(page)
            at = end
        }
        return found
    }

    // -------------------------------------------------------------------- tests

    @Test
    fun `the first page is a BOS OpusHead a player can identify the stream from`() {
        val pages = Pages()
        writer(pages).writeHeaders()

        val head = pages.list[0]
        assertValidPage(head)
        assertEquals("BOS flag", 0x02, flags(head))
        assertEquals("header pages carry no audio time", 0L, granule(head))
        assertEquals("first page in the file", 0, sequence(head))
        assertEquals(serial, le32(head, 14))

        val body = payload(head)
        assertEquals("OpusHead is fixed-size for mapping family 0", 19, body.size)
        assertEquals("OpusHead", String(body, 0, 8, Charsets.US_ASCII))
        assertEquals("version", 1, body[8].toInt())
        assertEquals("mono", 1, body[9].toInt())
        assertEquals("pre-skip", 312, le16(body, 10))
        assertEquals("original input rate", 16_000, le32(body, 12))
        assertEquals("output gain", 0, le16(body, 16))
        assertEquals("channel mapping family", 0, body[18].toInt())
    }

    @Test
    fun `a non default pre-skip and input rate reach OpusHead`() {
        // The codec's real priming figure is what keeps playback aligned with
        // the transcript; a writer that ignored it would drift silently.
        val pages = Pages()
        writer(pages, preSkip = 356, inputSampleRate = 48_000).writeHeaders()

        val body = payload(pages.list[0])
        assertEquals(356, le16(body, 10))
        assertEquals(48_000, le32(body, 12))
    }

    @Test
    fun `OpusTags follows as its own page, or the stream is not Ogg Opus`() {
        val pages = Pages()
        writer(pages).writeHeaders()

        val tags = pages.list[1]
        assertValidPage(tags)
        assertEquals("no flags: not BOS, not EOS", 0x00, flags(tags))
        assertEquals(0L, granule(tags))
        assertEquals("second page in the file", 1, sequence(tags))

        val body = payload(tags)
        assertEquals("OpusTags", String(body, 0, 8, Charsets.US_ASCII))
        val vendorLength = le32(body, 8)
        assertEquals("Parley Android", String(body, 12, vendorLength, Charsets.UTF_8))
        assertEquals("no user comments", 0, le32(body, 12 + vendorLength))
    }

    @Test
    fun `writeHeaders is idempotent so a lazy caller cannot double the headers`() {
        val pages = Pages()
        val w = writer(pages)
        w.writeHeaders()
        w.writeHeaders()
        w.append(packet(60))
        assertEquals("two header pages, no more", 2, pages.list.size)
    }

    @Test
    fun `every page checksums, so ffmpeg on the server accepts the upload`() {
        val pages = Pages()
        val w = writer(pages, packetsPerPage = 4)
        repeat(11) { w.append(packet(57 + it, seed = it)) }
        w.finish()

        assertTrue("expected several pages", pages.list.size >= 5)
        pages.list.forEach(::assertValidPage)
    }

    @Test
    fun `the CRC is Ogg's, not java util zip's`() {
        // Same polynomial, but zip's CRC-32 reflects input and output and starts
        // from all-ones. Getting that wrong produces files that some decoders
        // tolerate and strict ones reject, so the answer is pinned by hand.
        val ogg = "OggS".toByteArray(Charsets.US_ASCII)
        assertEquals("known answer for \"OggS\"", 0x5FB0A94F, oggCrc(ogg))
        assertEquals("production CRC agrees", oggCrc(ogg), OggStreamWriter.oggCrc(ogg))

        val other = "Parley".toByteArray(Charsets.US_ASCII)
        assertEquals(0x2AAE5FD4, oggCrc(other))
        assertEquals(oggCrc(other), OggStreamWriter.oggCrc(other))

        val zip = java.util.zip.CRC32().apply { update(ogg) }.value.toInt()
        assertFalse("must not be the zip CRC", zip == OggStreamWriter.oggCrc(ogg))
    }

    @Test
    fun `lacing terminates every packet, including one of exactly 255 bytes`() {
        // The classic Ogg trap: 255 means "continues", so a 255-byte packet needs
        // a trailing zero. Omit it and the next packet is swallowed into this one.
        val pages = Pages()
        val w = writer(pages, packetsPerPage = 3)
        w.append(packet(60, seed = 1))
        w.append(packet(255, seed = 2))
        w.append(packet(300, seed = 3))
        w.finish()

        val audio = pages.list[2]
        assertArrayEquals(intArrayOf(60, 255, 0, 255, 45), lacing(audio))
        assertEquals(60 + 255 + 300, payload(audio).size)
        assertArrayEquals(packet(60, seed = 1), payload(audio).copyOfRange(0, 60))
        assertArrayEquals(packet(255, seed = 2), payload(audio).copyOfRange(60, 315))
        assertArrayEquals(packet(300, seed = 3), payload(audio).copyOfRange(315, 615))
    }

    @Test
    fun `granule counts 48 kHz samples and includes the pre-skip`() {
        // Ogg-Opus granules are always at 48 kHz whatever the capture rate, and a
        // decoder subtracts the pre-skip again. Drop it and every timestamp in
        // the file lands 6_5 ms early; count at 16 kHz and playback runs 3x fast.
        val pages = Pages()
        val w = writer(pages, packetsPerPage = 10)
        repeat(25) { w.append(packet(60, seed = it)) }
        w.finish()

        val audio = pages.list.drop(2)
        assertEquals(3, audio.size)
        assertEquals(312 + 10 * 960L, granule(audio[0]))
        assertEquals(312 + 20 * 960L, granule(audio[1]))
        assertEquals("final granule covers every packet", 312 + 25 * 960L, granule(audio[2]))
        assertEquals(960L, OggStreamWriter.GRANULE_PER_PACKET)
    }

    @Test
    fun `page sequence numbers are contiguous from zero across headers and audio`() {
        // A gap or a repeat makes a decoder report a hole and resync, dropping
        // audio that is actually present in the file.
        val pages = Pages()
        val w = writer(pages, packetsPerPage = 3)
        repeat(10) { w.append(packet(60, seed = it)) }
        w.finish()

        pages.list.forEachIndexed { index, page ->
            assertEquals("page $index sequence", index, sequence(page))
        }
    }

    @Test
    fun `exactly one page carries EOS when the tail is partial`() {
        val pages = Pages()
        val w = writer(pages, packetsPerPage = 4)
        repeat(10) { w.append(packet(60, seed = it)) }
        w.finish()

        val eosCount = pages.list.count { flags(it) and 0x04 != 0 }
        assertEquals("only the last page ends the stream", 1, eosCount)
        assertEquals(0x04, flags(pages.list.last()))
        assertEquals(312 + 10 * 960L, granule(pages.list.last()))
        assertEquals(
            "the tail page holds the 2 leftover packets",
            2,
            segmentCount(pages.list.last()),
        )
    }

    @Test
    fun `a stream that divides evenly still gets an EOS page`() {
        // Nothing is left to flush, so the stream is closed with a bare page
        // carrying the final granule — without it a decoder cannot tell a
        // finished recording from a truncated one.
        val pages = Pages()
        val w = writer(pages, packetsPerPage = 5)
        repeat(10) { w.append(packet(60, seed = it)) }
        w.finish()

        val last = pages.list.last()
        assertEquals(0x04, flags(last))
        assertEquals("bare closing page", 0, segmentCount(last))
        assertEquals(0, payload(last).size)
        assertEquals(312 + 10 * 960L, granule(last))
        assertEquals(
            "only the closing page is EOS",
            1,
            pages.list.count { flags(it) and 0x04 != 0 },
        )
    }

    @Test
    fun `a recording with no audio at all is still a playable file`() {
        // Start-then-immediately-stop happens; it should leave an empty
        // recording, not a zero-byte file that looks like a failed write.
        val pages = Pages()
        writer(pages).finish()

        assertEquals("headers plus a closing page", 3, pages.list.size)
        walkPages(pages.bytes())
        assertEquals(0x02, flags(pages.list[0]))
        assertEquals(0x04, flags(pages.list[2]))
        assertEquals("no audio, so granule is just the pre-skip", 312L, granule(pages.list[2]))
    }

    @Test
    fun `an abandoned writer still leaves every flushed page complete and valid`() {
        // The reason this class replaced MediaMuxer. The app is killed mid
        // meeting: finish() never runs, nothing is finalised, and the bytes that
        // reached the disk are all there is. Each of them must still decode.
        val pages = Pages()
        val w = writer(pages, packetsPerPage = 5)
        repeat(23) { w.append(packet(60, seed = it)) }
        // No finish(): the process is gone.

        val onDisk = pages.bytes()
        val walked = walkPages(onDisk)
        assertEquals(
            "2 headers + 4 full audio pages; 3 packets die with the process",
            6,
            walked.size,
        )
        assertEquals(
            "no page claims to end the stream",
            0,
            walked.count { flags(it) and 0x04 != 0 },
        )
        assertEquals(312 + 20 * 960L, granule(walked.last()))
        assertEquals("20 packets survived", 20, walked.drop(2).sumOf { segmentCount(it) })

        // And the same holds for any earlier kill instant: truncating after any
        // whole page leaves a file that still walks cleanly end to end.
        var prefix = 0
        for (page in walked) {
            prefix += page.size
            walkPages(onDisk.copyOfRange(0, prefix))
        }
    }

    @Test
    fun `finish is idempotent so a double stop cannot append a second EOS page`() {
        val pages = Pages()
        val w = writer(pages, packetsPerPage = 4)
        repeat(6) { w.append(packet(60, seed = it)) }
        w.finish()
        val after = pages.list.size
        w.finish()

        assertEquals("second finish() writes nothing", after, pages.list.size)
        assertEquals("still exactly one EOS page", 1, pages.list.count { flags(it) and 0x04 != 0 })
    }

    @Test
    fun `counters report what actually reached the sink`() {
        val pages = Pages()
        val w = writer(pages, packetsPerPage = 4)
        repeat(9) { w.append(packet(60, seed = it)) }
        w.finish()

        assertEquals(9L, w.packetsWritten)
        assertEquals(pages.list.size.toLong(), w.pagesWritten)
    }

    @Test
    fun `a packet too large for any page is rejected instead of silently corrupting one`() {
        // A page's segment table holds 255 lacing values; a packet needing more
        // could not be described at all, and truncating the count to a byte would
        // produce a page that looks fine and decodes as garbage.
        val pages = Pages()
        val w = writer(pages)
        assertThrows(IllegalArgumentException::class.java) {
            w.append(packet(OggStreamWriter.MAX_PACKET_BYTES + 1))
        }

        // The largest packet that *can* be described still works, alone on a page.
        val ok = Pages()
        val w2 = writer(ok)
        w2.append(packet(OggStreamWriter.MAX_PACKET_BYTES))
        w2.finish()
        walkPages(ok.bytes())
        assertEquals("255 lacing values, the format's maximum", 255, segmentCount(ok.list[2]))
    }

    @Test
    fun `large packets flush early rather than overflow a page's segment table`() {
        // packetsPerPage is a target, not a promise: 50 packets of 600 bytes
        // would need 150 lacing values, and 50 of 3000 would need 650. The page
        // has to close early instead.
        val pages = Pages()
        val w = writer(pages, packetsPerPage = 50)
        repeat(100) { w.append(packet(3_000, seed = it)) }
        w.finish()

        walkPages(pages.bytes())
        pages.list.forEach { assertTrue("segment table overflow", segmentCount(it) <= 255) }
        assertEquals("every packet made it", 312 + 100 * 960L, granule(pages.list.last()))
    }
}
