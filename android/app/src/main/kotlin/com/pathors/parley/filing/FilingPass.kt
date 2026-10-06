package com.pathors.parley.filing

import android.content.Context
import com.pathors.parley.R
import com.pathors.parley.cloud.CloudClient
import com.pathors.parley.cloud.CloudFolder
import com.pathors.parley.cloud.RecordingMeta
import com.pathors.parley.cloud.TranscriptSegmentDto
import com.pathors.parley.kit.FilingFolder
import com.pathors.parley.kit.FilingLanguage
import com.pathors.parley.kit.FilingSuggester
import com.pathors.parley.kit.FilingSuggestion
import com.pathors.parley.kit.SpeakerLabel
import com.pathors.parley.kit.TranscriptSegment
import com.pathors.parley.library.LibraryFolders
import com.pathors.parley.ui.speakerStrings
import kotlinx.coroutines.CancellationException

/**
 * The filing pass (the AI title + folder suggestion) for one recording that is
 * already in the cloud, run once and written down at once — the one way every
 * Android door into a recording (the live meeting screen, an import) asks the
 * question, and the same inputs the desktop and iOS send.
 *
 * ## The inputs
 *
 * Everything the pass reads comes from the recording as the cloud holds it
 * right now, not from what a screen remembers: the stored transcript, the
 * speaker names somebody typed (the desktop's `transcriptWithTimestamps`
 * labels), the meeting context, the current title, and the personal folder
 * registry. The title is written in the app's UI language ([language]),
 * whatever language the meeting was held in.
 *
 * ## Generate once, persist immediately
 *
 * A pass that only lived in memory left the recording looking untouched: if
 * the offer was ignored, the desktop ran a pass of its own and synced a
 * second, different title back. So a successful pass is written into the meta
 * straight away — `filingSuggestion` (the pending offer, in the desktop's
 * shape) and `filingSuggested: true` — by a fresh read-modify-write, unless
 * the fresh meta says another device has meanwhile spent a pass of its own,
 * in which case ours is dropped rather than offered as a competitor.
 *
 * Answering the offer (accept, edit, skip) clears `filingSuggestion` as
 * before; that is [FilingSuggestionModel]'s job.
 */
class FilingPass(
    private val cloud: CloudClient,
    /**
     * The label for a speaker nobody has named — display copy, so the app's
     * bilingual string table (`SpeakerLabel.fallback`). A name stored in the
     * recording's `speakerNames` always wins over it.
     */
    private val fallbackSpeakerLabel: (source: String, speaker: Int) -> String,
    /** The app's UI language, read when a pass runs (it can change in between). */
    private val language: () -> FilingLanguage,
) {
    /** A pass that produced something, with what it was made against. */
    data class Generated(
        val suggestion: FilingSuggestion,
        /** The meta the pass read — what the recording is called and where it lives. */
        val meta: RecordingMeta,
        /** The personal folders the suggestion was made against. */
        val folders: List<CloudFolder>,
        /** Whether the suggestion reached the cloud; false when that write failed. */
        val persisted: Boolean,
    )

    /**
     * Run the pass for [recordingId] and persist what it produced.
     *
     * Null when a pass has already been spent on the recording (here, before
     * the model is asked; or by another device while it was thinking), when
     * there is nothing to read, or when nothing the model said survived the
     * gates. Throws on a failed read or model call; a failed *persist* is not
     * thrown — the suggestion is still worth offering on the screen that asked,
     * and the user's answer writes the flag anyway.
     *
     * @param fallbackSegments what to read if the stored meta carries no
     *   transcript at all (the live screen's own copy); the stored one wins.
     */
    suspend fun generate(
        recordingId: String,
        fallbackSegments: List<TranscriptSegment> = emptyList(),
    ): Generated? {
        val meta = cloud.recordingMeta(recordingId)
        if (meta.filingSuggested) return null
        // Personal folders only: an org folder is not somewhere this recording
        // can be moved to from here.
        val folders = LibraryFolders.personalFolders(cloud.listFolders())
        val segments = meta.segments.map { it.toKit() }.ifEmpty { fallbackSegments }
        val suggestion = FilingSuggester.suggest(
            segments = segments,
            speakerLabel = { speakerLabel(meta, it) },
            currentTitle = meta.title,
            folders = folders.map { FilingFolder(id = it.id, name = it.name, orgId = it.orgId) },
            chat = cloud,
            language = language(),
            meetingContext = meta.meetingContext,
        ) ?: return null
        return when (persist(recordingId, suggestion)) {
            Persist.SPENT_ELSEWHERE -> null
            Persist.WRITTEN -> Generated(suggestion, meta, folders, persisted = true)
            Persist.FAILED -> Generated(suggestion, meta, folders, persisted = false)
        }
    }

    /**
     * [generate], for a caller nobody is watching (an import that just
     * finished): never throws, and says only whether a suggestion is now
     * waiting on the recording in the cloud.
     */
    suspend fun generateInBackground(recordingId: String): Boolean = try {
        generate(recordingId)?.persisted == true
    } catch (e: CancellationException) {
        throw e
    } catch (e: Throwable) {
        // Best-effort by design: the recording is already in the cloud under
        // the name it arrived with, and the desktop can still ask.
        false
    }

    private enum class Persist { WRITTEN, SPENT_ELSEWHERE, FAILED }

    /** One fresh read-modify-write; declines when a pass has meanwhile been spent. */
    private suspend fun persist(recordingId: String, suggestion: FilingSuggestion): Persist = try {
        val written = cloud.editRecordingIf(recordingId) { fresh ->
            if (fresh.filingSuggested) null else fresh.withFilingSuggestion(suggestion)
        }
        if (written == null) Persist.SPENT_ELSEWHERE else Persist.WRITTEN
    } catch (e: CancellationException) {
        throw e
    } catch (e: Throwable) {
        Persist.FAILED
    }

    private fun speakerLabel(meta: RecordingMeta, segment: TranscriptSegment): String =
        meta.speakerNames["${segment.source}-${segment.speaker}"]?.takeIf { it.isNotEmpty() }
            ?: fallbackSpeakerLabel(segment.source, segment.speaker)

    companion object {
        /** The pass as the app runs it: its string table, its UI language. */
        fun create(context: Context, cloud: CloudClient): FilingPass {
            val app = context.applicationContext
            return FilingPass(
                cloud = cloud,
                fallbackSpeakerLabel = { source, speaker ->
                    SpeakerLabel.fallback(source, speaker, speakerStrings(app))
                },
                language = { uiLanguage(app) },
            )
        }

        /**
         * The language the app is actually being read in. Taken from the
         * resources Android resolved — `values-zh-rTW` or the English default —
         * rather than from the system locale, so the per-app language setting
         * and Android's own fallback rules (a Simplified Chinese phone reads
         * Parley in English) decide it exactly as they decide every label.
         */
        fun uiLanguage(context: Context): FilingLanguage =
            FilingLanguage.forTag(context.getString(R.string.filing_title_language))
    }
}

/** A stored segment as the kit's pass reads it. */
private fun TranscriptSegmentDto.toKit(): TranscriptSegment = TranscriptSegment(
    id = id,
    source = source,
    speaker = speaker,
    text = text,
    isFinal = isFinal,
    startMs = startMs,
    endMs = endMs,
)
