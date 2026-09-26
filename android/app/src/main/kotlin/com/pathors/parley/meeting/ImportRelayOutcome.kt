package com.pathors.parley.meeting

import com.pathors.parley.cloud.CloudException
import com.pathors.parley.kit.SttRelayEvent
import com.pathors.parley.kit.TranscriptCoverage

/**
 * What one relay event means for an import that is still running.
 *
 * An import streams the decoded file through the same realtime relay a live
 * meeting uses, so it inherits the relay's ways of dying. They used to be
 * ignored outright, which is how an import whose transcription had been refused
 * — out of quota, signed out, relay down — still ended on "Done" with an empty
 * or half transcript. They split three ways, because they need three different
 * things from the person holding the phone:
 *
 * - [Fatal]: nothing about this is fixed by carrying on. Out of quota and a dead
 *   session refuse every transcription the account asks for, the background
 *   re-transcription included, so decoding the rest of the file would only
 *   produce a library row with a transcript that cannot be finished until the
 *   user does something. Unlike a live meeting, nothing is lost by stopping:
 *   the user still has the file they picked. So the import stops, says which of
 *   "wait for the quota" or "sign in again" is needed, and the file can simply
 *   be imported again. iOS ends the same two cases the same way
 *   (`RecordingImporter.run`, `CloudError.batchTranscriptionMessage`).
 * - [Degraded]: the live transcript stopped short for some other reason — the
 *   relay errored, the socket dropped, the tail never arrived. The audio is
 *   still being encoded in full, so the recording is kept and uploaded with the
 *   transcript it has, and the upload's own coverage check hands it to the
 *   backfill queue to be transcribed again from the file. That is exactly what a
 *   live meeting does with the same failure.
 * - [Healthy]: a segment, or the normal end of the stream.
 *
 * Pure and platform-free so the mapping is tested on the JVM; [ImportSession]
 * owns what happens next.
 */
sealed interface ImportRelayVerdict {
    data object Healthy : ImportRelayVerdict

    /** Stop the import and report [failure]; [detail] is for the log. */
    data class Fatal(val failure: ImportFailure, val detail: String) : ImportRelayVerdict

    /** Keep going; the transcript will be short. [detail] is for the log. */
    data class Degraded(val detail: String) : ImportRelayVerdict
}

/** How the transcript of a finished import stands. */
enum class ImportTranscript {
    /** What the relay sent back accounts for the audio. */
    COMPLETE,

    /**
     * The live transcript came up short and the recording is queued to be
     * transcribed again in full — right after it uploads, or once it can.
     */
    COMPLETES_IN_BACKGROUND,
}

object ImportRelayOutcome {

    /**
     * Classify one relay event.
     *
     * @param finishSent whether the import has already sent `finalize`. After
     *   that, the relay closing the socket is the normal end of the stream;
     *   before it, a close means the transcript stopped partway.
     */
    fun classify(event: SttRelayEvent, finishSent: Boolean): ImportRelayVerdict = when (event) {
        is SttRelayEvent.Segment -> ImportRelayVerdict.Healthy

        is SttRelayEvent.QuotaExceeded ->
            ImportRelayVerdict.Fatal(ImportFailure.QUOTA_EXHAUSTED, event.message)

        is SttRelayEvent.Error ->
            if (event.isUnauthorized) {
                ImportRelayVerdict.Fatal(ImportFailure.SESSION_EXPIRED, event.message)
            } else {
                ImportRelayVerdict.Degraded(event.message)
            }

        is SttRelayEvent.Closed ->
            if (finishSent) ImportRelayVerdict.Healthy else ImportRelayVerdict.Degraded(event.reason)
    }

    /**
     * Fold a new verdict into the one already held. The first bad news wins: a
     * relay that errors and then closes has one story, and it is the error. A
     * [ImportRelayVerdict.Fatal] is never demoted by a later, milder event.
     */
    fun merge(current: ImportRelayVerdict, next: ImportRelayVerdict): ImportRelayVerdict = when {
        current is ImportRelayVerdict.Fatal -> current
        next is ImportRelayVerdict.Fatal -> next
        current is ImportRelayVerdict.Degraded -> current
        else -> next
    }

    /**
     * Why the uploader dropped an imported recording instead of queueing it —
     * see `MeetingUploader.dispositionOf`. Out of quota gets its own copy
     * because it names a different next step (wait or upgrade) from every
     * other refusal.
     */
    fun uploadRefusal(refusal: Throwable): ImportFailure =
        if ((refusal as? CloudException)?.isQuotaExhausted == true) {
            ImportFailure.QUOTA_EXHAUSTED
        } else {
            ImportFailure.UPLOAD_REFUSED
        }

    /**
     * What to tell the user about the transcript once the recording is saved.
     *
     * "Completes in the background" is only said when it is true: the relay
     * actually stopped short **and** the transcript leaves enough of the audio
     * unaccounted for that the uploader will queue a backfill
     * ([TranscriptCoverage.Report.needsBackfill], the same test
     * `MeetingUploader` applies). A relay that died on the last second of an
     * hour-long file cost nothing worth mentioning, and promising a repair the
     * app will not run would be the same quiet dishonesty this replaces.
     */
    fun transcript(verdict: ImportRelayVerdict, coverage: TranscriptCoverage.Report): ImportTranscript =
        if (verdict is ImportRelayVerdict.Degraded && coverage.needsBackfill()) {
            ImportTranscript.COMPLETES_IN_BACKGROUND
        } else {
            ImportTranscript.COMPLETE
        }
}
