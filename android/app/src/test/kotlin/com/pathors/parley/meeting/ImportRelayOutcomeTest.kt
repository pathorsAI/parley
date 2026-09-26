package com.pathors.parley.meeting

import com.pathors.parley.cloud.CloudException
import com.pathors.parley.kit.SttRelayEvent
import com.pathors.parley.kit.TranscriptCoverage
import com.pathors.parley.kit.TranscriptSegment
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * An import used to ignore every relay terminal event, so running out of quota,
 * losing the session or the relay simply dying all ended on "Done". These pin
 * which of the three outcomes each one now produces.
 */
class ImportRelayOutcomeTest {

    private fun classify(event: SttRelayEvent, finishSent: Boolean = false) =
        ImportRelayOutcome.classify(event, finishSent)

    // ── quota ────────────────────────────────────────────────────────────────

    @Test
    fun `out of quota stops the import with the quota failure`() {
        // Handshake 402, in-band 402 and the relay's mid-session cut all arrive
        // as QuotaExceeded; the import treats them identically.
        listOf(
            "relay handshake failed: HTTP 402 Payment Required",
            "relay error 402: quota_exhausted",
            "close code=1011 quota cap reached",
        ).forEach { message ->
            val verdict = classify(SttRelayEvent.QuotaExceeded(message))
            assertEquals(ImportRelayVerdict.Fatal(ImportFailure.QUOTA_EXHAUSTED, message), verdict)
        }
    }

    @Test
    fun `out of quota while the tail drains is still fatal`() {
        val verdict = classify(SttRelayEvent.QuotaExceeded("close code=1011 quota"), finishSent = true)
        assertTrue(verdict is ImportRelayVerdict.Fatal)
    }

    // ── auth ─────────────────────────────────────────────────────────────────

    @Test
    fun `a refused session sends the user back to sign in`() {
        val event = SttRelayEvent.Error("relay handshake failed: HTTP 401 Unauthorized", httpStatus = 401)
        assertEquals(
            ImportRelayVerdict.Fatal(ImportFailure.SESSION_EXPIRED, event.message),
            classify(event),
        )
    }

    @Test
    fun `a vendor-side 401 frame is not the user's session`() {
        // In-band codes belong to the transcription vendor; httpStatus stays null.
        val verdict = classify(SttRelayEvent.Error("relay error 401: bad key"))
        assertTrue(verdict is ImportRelayVerdict.Degraded)
    }

    // ── everything else keeps the recording ──────────────────────────────────

    @Test
    fun `other relay errors keep the recording with a short transcript`() {
        listOf(
            SttRelayEvent.Error("relay handshake failed: HTTP 429 Too Many Requests", httpStatus = 429),
            SttRelayEvent.Error("relay handshake failed: HTTP 502 Bad Gateway", httpStatus = 502),
            SttRelayEvent.Error("relay error 500: upstream exploded"),
        ).forEach { event ->
            assertEquals(ImportRelayVerdict.Degraded(event.message), classify(event))
        }
    }

    @Test
    fun `a close before finalize is a transcript that stopped partway`() {
        val event = SttRelayEvent.Closed("close code=0 Software caused connection abort")
        assertEquals(ImportRelayVerdict.Degraded(event.reason), classify(event, finishSent = false))
    }

    @Test
    fun `a close after finalize is the normal end of the stream`() {
        assertEquals(ImportRelayVerdict.Healthy, classify(SttRelayEvent.Closed("finished"), finishSent = true))
        assertEquals(
            ImportRelayVerdict.Healthy,
            classify(SttRelayEvent.Closed("close code=1000 "), finishSent = true),
        )
    }

    @Test
    fun `segments are healthy`() {
        val segment = TranscriptSegment("mix-0", "mix", 1, "hello", true, 0, 1_000)
        assertEquals(ImportRelayVerdict.Healthy, classify(SttRelayEvent.Segment(segment)))
    }

    // ── folding several events ───────────────────────────────────────────────

    @Test
    fun `the first bad news wins and fatal is never demoted`() {
        val degraded = ImportRelayVerdict.Degraded("relay error 500")
        val fatal = ImportRelayVerdict.Fatal(ImportFailure.QUOTA_EXHAUSTED, "402")
        val healthy = ImportRelayVerdict.Healthy

        assertEquals(degraded, ImportRelayOutcome.merge(healthy, degraded))
        assertEquals(degraded, ImportRelayOutcome.merge(degraded, healthy))
        assertEquals(degraded, ImportRelayOutcome.merge(degraded, ImportRelayVerdict.Degraded("close")))
        assertEquals(fatal, ImportRelayOutcome.merge(degraded, fatal))
        assertEquals(fatal, ImportRelayOutcome.merge(fatal, degraded))
        assertEquals(fatal, ImportRelayOutcome.merge(fatal, healthy))
    }

    // ── what the finished screen says ────────────────────────────────────────

    private fun coverage(coveredMs: Long, totalMs: Long): TranscriptCoverage.Report =
        TranscriptCoverage.report(
            listOf(TranscriptSegment("mix-0", "mix", 1, "hello", true, 0, coveredMs)),
            totalMs,
        )

    @Test
    fun `a relay that died partway promises a background transcript`() {
        val verdict = ImportRelayVerdict.Degraded("relay error 500")
        assertEquals(
            ImportTranscript.COMPLETES_IN_BACKGROUND,
            ImportRelayOutcome.transcript(verdict, coverage(coveredMs = 60_000, totalMs = 600_000)),
        )
    }

    @Test
    fun `a relay that died with nothing missing promises nothing`() {
        // The uploader would not queue a backfill for this, so neither may the
        // screen claim one is coming.
        val verdict = ImportRelayVerdict.Degraded("relay tail timed out")
        assertEquals(
            ImportTranscript.COMPLETE,
            ImportRelayOutcome.transcript(verdict, coverage(coveredMs = 599_000, totalMs = 600_000)),
        )
    }

    @Test
    fun `a healthy relay is complete whatever the coverage says`() {
        assertEquals(
            ImportTranscript.COMPLETE,
            ImportRelayOutcome.transcript(ImportRelayVerdict.Healthy, coverage(0, 600_000)),
        )
    }

    // ── an upload the cloud refused for good ─────────────────────────────────

    @Test
    fun `a refused upload names quota separately from everything else`() {
        assertEquals(
            ImportFailure.QUOTA_EXHAUSTED,
            ImportRelayOutcome.uploadRefusal(CloudException(402, "quota")),
        )
        assertEquals(
            ImportFailure.UPLOAD_REFUSED,
            ImportRelayOutcome.uploadRefusal(CloudException(413, "too large")),
        )
        assertEquals(ImportFailure.UPLOAD_REFUSED, ImportRelayOutcome.uploadRefusal(IOException("?")))
    }
}
