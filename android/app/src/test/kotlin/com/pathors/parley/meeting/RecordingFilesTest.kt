package com.pathors.parley.meeting

import com.pathors.parley.upload.MeetingUploader
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The two decisions [RecordingFiles.adoptOrphans] makes about a file it finds,
 * both of which have to be right without a `Context` to hand.
 *
 * The sweep itself needs an Android `Context` and a real uploader, so it is not
 * unit-testable in this module (there is no Robolectric here). What *is* tested
 * is the arithmetic and the parsing the sweep hangs off — which is where the
 * mistakes that matter live: an estimate that reads low throws a meeting away,
 * and a misparsed name files a rescued meeting under the wrong day.
 */
class RecordingFilesTest {

    @get:Rule
    val folder = TemporaryFolder()

    // ── is this a meeting, or a scrap? ──────────────────────────────────────

    /**
     * 24 kbps is 3 000 bytes per second, so a minute of audio is about 180 kB.
     * Hand-computed rather than derived from the production expression, so a
     * change to the bitrate constant has to be thought about rather than
     * silently absorbed.
     */
    @Test
    fun `duration is estimated from the file size at the recording bitrate`() {
        assertEquals(1_000.0, RecordingFiles.estimateDurationMs(3_000), 0.001)
        assertEquals(60_000.0, RecordingFiles.estimateDurationMs(180_000), 0.001)
        assertEquals(3_600_000.0, RecordingFiles.estimateDurationMs(10_800_000), 0.001)
    }

    /** An empty or impossible file is zero, never a negative duration. */
    @Test
    fun `an empty file estimates as no audio at all`() {
        assertEquals(0.0, RecordingFiles.estimateDurationMs(0), 0.0)
        assertEquals(0.0, RecordingFiles.estimateDurationMs(-1), 0.0)
    }

    /**
     * The gate the sweep applies: under two seconds is a tap of the record
     * button, not a meeting. Both sides of it, in bytes, because the bytes are
     * what the sweep actually has.
     *
     * Note which way the arithmetic errs. Ogg page headers are counted in the
     * file size but carry no audio, so this over-estimates slightly — which is
     * the harmless direction, since it errs towards keeping a recording.
     */
    @Test
    fun `the two-second gate falls where the uploader's own gate does`() {
        val gateBytes = (MeetingUploader.MIN_LIVE_DURATION_MS / 8_000.0 * 24_000).toLong()
        assertEquals(6_000L, gateBytes)

        assertTrue(RecordingFiles.estimateDurationMs(6_001) >= MeetingUploader.MIN_LIVE_DURATION_MS)
        assertTrue(RecordingFiles.estimateDurationMs(5_999) < MeetingUploader.MIN_LIVE_DURATION_MS)
        // A file the encoder opened and never wrote a page into.
        assertTrue(RecordingFiles.estimateDurationMs(0) < MeetingUploader.MIN_LIVE_DURATION_MS)
    }

    // ── when was this recorded? ─────────────────────────────────────────────

    /**
     * The name is exact and the modification time is not: a file the process
     * died while writing was last modified at the moment of the crash, which
     * for a long meeting is an hour after it began. A rescued meeting has to
     * appear in the library where the user expects to find it.
     */
    @Test
    fun `the start time comes from the file name, not the file clock`() {
        val startedAt = 1_757_000_000_000L
        val file = folder.newFile("meeting-$startedAt.ogg")
        file.setLastModified(startedAt + 3_600_000)

        assertEquals(startedAt, RecordingFiles.startedAtMsOf(file))
    }

    /**
     * A name from a version that wrote them differently, or a file a user
     * dropped in by hand, still gets a plausible time rather than none — the
     * sweep must not refuse to rescue a recording just because it cannot date
     * it precisely.
     */
    @Test
    fun `an unparseable name falls back to the file's own timestamp`() {
        val file = folder.newFile("something-else.ogg")
        val stamp = 1_700_000_000_000L
        file.setLastModified(stamp)

        // Filesystems store mtime at second granularity, so compare loosely.
        val parsed = RecordingFiles.startedAtMsOf(file)
        assertTrue(
            "expected roughly $stamp, got $parsed",
            kotlin.math.abs(parsed - stamp) < 2_000,
        )
    }

    /**
     * A name that parses to something nonsensical is not trusted either. Zero
     * would file the recording in 1970, which looks like data loss to a user
     * even though the audio is fine.
     */
    @Test
    fun `a zero or negative timestamp in the name is not trusted`() {
        val zero = folder.newFile("meeting-0.ogg")
        zero.setLastModified(1_700_000_000_000L)
        assertTrue(RecordingFiles.startedAtMsOf(zero) > 0)

        val negative = folder.newFile("meeting--5.ogg")
        negative.setLastModified(1_700_000_000_000L)
        assertTrue(RecordingFiles.startedAtMsOf(negative) > 0)
    }

    /** A file that does not exist at all still produces a usable time. */
    @Test
    fun `a missing file still produces a usable start time`() {
        val missing = File(folder.root, "meeting-not-a-number.ogg")

        assertTrue(RecordingFiles.startedAtMsOf(missing) > 0)
    }
}
