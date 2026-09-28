package com.pathors.parley.kit

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray

/**
 * The bundled sample recording's manifest — `public/sample/sample.<lang>.json`,
 * produced by `scripts/sample/render.ts` alongside the Ogg/Opus it describes.
 *
 * The same files the desktop and iOS read (iOS `SampleManifest.swift`). Only the
 * fields the phone uses are decoded; anything else in the file (the render
 * script's voices and rates, the desktop's MCP questions) is ignored rather than
 * required, so a later render that adds a field cannot break an installed app.
 *
 * The analysis half — [suggestion], [brief], [findings], [actionItems] — is
 * optional on the way in. A manifest rendered before those fields existed still
 * decodes, and the sample then simply opens on its transcript with no
 * suggestion card, exactly like an unanalysed recording would.
 */
@Serializable
data class SampleManifest(
    /** Always starts with [ID_PREFIX], which is how the app tells a sample from a real recording. */
    val id: String,
    /** `zh-TW` or `en`. */
    val lang: String,
    val title: String,
    /** The Ogg/Opus file's name, next to the manifest. */
    val audio: String,
    val durationMs: Double,
    val meetingKind: String? = null,
    val context: String? = null,
    val speakers: Speakers,
    val segments: List<Segment>,
    /**
     * The analysis questions the hand-off prompt asks about this meeting,
     * written for this script rather than the generic three — so the first
     * answer the user sees from their AI is a good one.
     */
    val questions: List<String> = emptyList(),
    /**
     * The filing suggestion the script ships with: the title a filing pass would
     * have proposed and the folder it would have proposed it for. See
     * [filingSuggestion] for how the card offers it.
     */
    val suggestion: Suggestion? = null,
    /** The prewritten analysis, passed through untouched into the recording's meta. */
    val brief: String? = null,
    val findings: JsonArray? = null,
    val actionItems: JsonArray? = null,
) {

    @Serializable
    data class Speakers(val me: String, val them: String)

    /**
     * The script's proposed title and folder. The folder never exists yet —
     * accepting it is what creates it (unless the user already has one by that
     * name; see [filingSuggestion]).
     */
    @Serializable
    data class Suggestion(
        val title: String,
        val folders: List<Folder> = emptyList(),
    ) {
        @Serializable
        data class Folder(val name: String, val reason: String = "")
    }

    @Serializable
    data class Segment(
        /** `"me"` or `"them"`. */
        val speaker: String,
        val startMs: Double,
        val endMs: Double,
        val text: String,
    )

    /**
     * The segments as the transcript screens read them: `me` is speaker 1 and
     * `them` speaker 2 — distinct indices, because the detail screen counts
     * speakers by `source-speaker` — with ids in the synced shape.
     */
    val transcriptSegments: List<TranscriptSegment>
        get() = segments.mapIndexed { index, segment ->
            val isMe = segment.speaker == SPEAKER_ME
            val source = if (isMe) SPEAKER_ME else SPEAKER_THEM
            TranscriptSegment(
                id = "$source-$index",
                source = source,
                speaker = if (isMe) 1 else 2,
                text = segment.text,
                isFinal = true,
                startMs = segment.startMs.toLong().coerceAtLeast(0L),
                endMs = segment.endMs.toLong().coerceAtLeast(0L),
            )
        }

    /** The names keyed the way a synced entry keys them (`"{source}-{speaker}"`). */
    val speakerNames: Map<String, String>
        get() = mapOf("$SPEAKER_ME-1" to speakers.me, "$SPEAKER_THEM-2" to speakers.them)

    /**
     * The filing suggestion as the card offers it: the script's proposed title,
     * its new folder, and — so the card is not a single take-it-or-leave-it
     * chip — up to two of the folders the user already works in, most recently
     * used first. Never more than three. iOS `SampleManifest.filingSuggestion`.
     *
     * A proposed folder whose name the user already has (their own customer
     * called 泓昇科技, say) points at that folder instead of proposing a second
     * one under the same name, by [FolderSearch]'s loose rules. Organization
     * folders are never offered. Null when the manifest carries no suggestion.
     */
    fun filingSuggestion(existingFolders: List<FilingFolder>): FilingSuggestion? {
        val proposed = suggestion ?: return null
        val personal = existingFolders.filter { it.orgId == null }
        val chips = proposed.folders.take(1).map { folder ->
            FilingFolderSuggestion(
                folderId = FolderSearch.exactMatch(personal, folder.name) { it.name }?.id,
                name = folder.name,
                reason = folder.reason,
            )
        }
        val taken = chips.mapNotNull { it.folderId }.toSet()
        val room = (MAX_SUGGESTED_FOLDERS - chips.size).coerceIn(0, MAX_RECENT_FOLDERS)
        val recent = personal
            .filterNot { it.id in taken }
            .sortedByDescending { it.lastUsedAtMs ?: 0.0 }
            .take(room)
            .map { FilingFolderSuggestion(folderId = it.id, name = it.name, reason = "") }
        return FilingSuggestion(title = proposed.title, folders = chips + recent)
    }

    companion object {
        const val ID_PREFIX = "sample-"
        private const val SPEAKER_ME = "me"
        private const val SPEAKER_THEM = "them"
        private const val MAX_SUGGESTED_FOLDERS = 3
        private const val MAX_RECENT_FOLDERS = 2

        private val json = Json { ignoreUnknownKeys = true }

        /** The desktop's rule too: any id with the prefix is the sample. */
        fun isSample(id: String): Boolean = id.startsWith(ID_PREFIX)

        fun decode(text: String): SampleManifest = json.decodeFromString(serializer(), text)

        /**
         * Which manifest a phone in [language] gets: Traditional Chinese for
         * any `zh`, English for everything else — iOS `preferredLang`.
         */
        fun langFor(language: String): String = if (language.startsWith("zh")) "zh-TW" else "en"
    }
}
