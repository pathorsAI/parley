package com.pathors.parley.cloud

import com.pathors.parley.kit.TranscriptSegment
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * DTOs for the Parley cloud (`api.parley.tw`). Field names mirror the desktop's
 * `src/lib/cloud/types.ts` and iOS `ParleyKit/CloudModels.swift` one-for-one:
 * camelCase JSON, epoch-milliseconds numbers. Where the two disagree, iOS wins
 * (it is the phone precedent) — the deviations are called out in the KDoc below
 * and in `android/docs/api-cloud.md`.
 */

/** The signed-in account. `GET /me` returns `{ user, activeOrganizationId }`. */
@Serializable
data class CloudUser(
    val id: String,
    val name: String? = null,
    val email: String,
    val image: String? = null,
)

/** `GET /me`. `user` is null when the token is missing or expired — a 200, not an error. */
@Serializable
data class MeResponse(
    val user: CloudUser? = null,
    val activeOrganizationId: String? = null,
)

/**
 * The library card the cloud stores per recording — the desktop's
 * `HistoryEntrySummary` minus its local-only fields.
 *
 * `speakerCount` / `findingsCount` / `actionItemsCount` / `snippet` / `folderId`
 * / `updatedAt` are nullable to match iOS `CloudRecordingSummary`; the server
 * always sends them, but a null is never pushed (see [CloudJson]: nulls are
 * omitted on encode, exactly like Swift's `encodeIfPresent`).
 */
@Serializable
data class RecordingSummary(
    val id: String,
    val title: String,
    /** "live" (captured in-app) or "upload" (an imported audio file). */
    val source: String,
    @Serializable(with = EpochMillisSerializer::class) val createdAt: Double,
    @Serializable(with = EpochMillisSerializer::class) val durationMs: Double,
    val speakerCount: Int? = null,
    val findingsCount: Int? = null,
    val actionItemsCount: Int? = null,
    val hasAudio: Boolean,
    val snippet: String? = null,
    val folderId: String? = null,
    /** Server push time (epoch ms) — last-writer-wins ordering across devices. */
    @Serializable(with = EpochMillisSerializer::class) val updatedAt: Double? = null,
) {
    companion object {
        /**
         * How many people the transcript accounts for. A transcript with turns
         * in it always has at least one speaker, even when every turn came back
         * unattributed.
         */
        fun speakerCount(segments: List<TranscriptSegmentDto>): Int {
            val distinct = segments.map { "${it.source}-${it.speaker}" }.toSet().size
            return maxOf(distinct, if (segments.isEmpty()) 0 else 1)
        }

        /**
         * The library row's preview line: the opening of the conversation,
         * capped so a list request does not carry whole meetings.
         */
        fun snippet(segments: List<TranscriptSegmentDto>): String =
            segments.take(3).joinToString(" ") { it.text }.take(SNIPPET_LIMIT)

        /**
         * The library card a recording would have, derived from the meta the
         * cloud already holds for it.
         *
         * For callers that have a recording's full entry but not the summary row
         * beside it — the detail screen fetches `GET /recordings/{id}/meta` and
         * nothing else. Every field here is one the meta genuinely knows;
         * `updatedAt` is deliberately left null rather than guessed, because it
         * is the server's own write clock and inventing one would reorder a
         * last-writer-wins merge.
         */
        fun fromMeta(meta: RecordingMeta): RecordingSummary {
            val segments = meta.segments
            return RecordingSummary(
                id = meta.id,
                title = meta.title,
                source = meta.source,
                createdAt = meta.createdAt,
                durationMs = meta.durationMs,
                speakerCount = speakerCount(segments),
                findingsCount = meta.findingsCount,
                actionItemsCount = meta.actionItemsCount,
                hasAudio = meta.hasAudio,
                snippet = snippet(segments),
                folderId = meta.folderId,
                updatedAt = null,
            )
        }

        /** Matches iOS `CloudRecordingSummary.snippet` and the desktop. */
        private const val SNIPPET_LIMIT = 120
    }

    /**
     * The same summary, re-derived for a transcript that replaced the one it was
     * built from.
     *
     * Only the three facts the transcript actually speaks for move: the speaker
     * count, the preview line, and the duration. The title, the folder, and the
     * analysis counts are somebody else's facts about this recording and survive
     * a re-transcription untouched; `hasAudio` stays as it was because the audio
     * in the cloud is the very file that was re-transcribed.
     *
     * The duration is taken as whichever is longer — a batch job's reported
     * length can undershoot what the recording already knew about itself.
     */
    fun replacingTranscript(
        segments: List<TranscriptSegmentDto>,
        durationMs: Double,
    ): RecordingSummary = copy(
        durationMs = maxOf(durationMs, this.durationMs),
        speakerCount = speakerCount(segments),
        snippet = snippet(segments),
    )
}

/** `GET /recordings` → `{ recordings: [...] }`. */
@Serializable
data class RecordingsResponse(
    val recordings: List<RecordingSummary> = emptyList(),
)

/** `POST /recordings/{id}` → `{ ok, updatedAt }`. */
@Serializable
data class PushResponse(
    val ok: Boolean = false,
    @Serializable(with = EpochMillisSerializer::class) val updatedAt: Double? = null,
)

/**
 * A folder, personal or an organization's — iOS `CloudFolder`, desktop
 * `CloudFolder` (`src/lib/cloud/types.ts`).
 *
 * Folders are one level deep and a recording is in at most one of them. A
 * personal folder has no [orgId]; `GET /folders` can return org folders too on
 * some backends, which is why the library filters on it rather than trusting
 * the endpoint.
 */
@Serializable
data class CloudFolder(
    val id: String,
    val name: String,
    val orgId: String? = null,
    @Serializable(with = EpochMillisSerializer::class) val createdAt: Double? = null,
    @Serializable(with = EpochMillisSerializer::class) val updatedAt: Double? = null,
)

/** `GET /folders` and `GET /orgs/{orgId}/folders` → `{ folders: [...] }`. */
@Serializable
data class FoldersResponse(
    val folders: List<CloudFolder> = emptyList(),
)

/** `POST /folders` → `{ folder }`, when the server sends the row back at all. */
@Serializable
data class FolderEnvelope(
    val folder: CloudFolder,
)

/**
 * An organization the signed-in account belongs to, with the account's own
 * [role] in it. `role` is only present from the cloud's `GET /orgs/mine` —
 * better-auth's own organization list drops it, which is why every client uses
 * the former. Mirrors iOS `CloudOrg`.
 */
@Serializable
data class CloudOrg(
    val id: String,
    val name: String,
    val slug: String? = null,
    /** [OrgRole.OWNER], [OrgRole.ADMIN] or [OrgRole.MEMBER]; null reads as member. */
    val role: String? = null,
)

/** The membership roles better-auth's organization plugin hands out. */
object OrgRole {
    const val OWNER = "owner"
    const val ADMIN = "admin"
    const val MEMBER = "member"
}

/** `POST /stt/batch` → `{ id }`, the hosted transcription job to poll. */
@Serializable
data class BatchJobCreated(
    val id: String,
)

/**
 * `GET /me/usage` — the plan and the metered balances the hosted STT relay
 * enforces. Mirrors iOS `HostedQuota`; the server additionally returns
 * `llmTokensUsed` / `llmTokensLimit` (kept for back-compat), which iOS ignores
 * and so do we.
 */
@Serializable
data class HostedQuota(
    val plan: String? = null,
    val sttSecondsUsed: Double? = null,
    val sttSecondsLimit: Double? = null,
    val llmCreditsUsed: Double? = null,
    val llmCreditsLimit: Double? = null,
    @Serializable(with = EpochMillisSerializer::class) val periodResetTs: Double? = null,
) {
    /** Remaining transcription seconds, or null when the plan is unmetered. */
    val sttSecondsRemaining: Double?
        get() {
            val limit = sttSecondsLimit ?: return null
            return (limit - (sttSecondsUsed ?: 0.0)).coerceAtLeast(0.0)
        }
}

/**
 * The wire shape of one transcript segment inside a recording's meta JSON —
 * iOS `TranscriptSegment` / desktop `TranscriptSegment` (`src/lib/types.ts`).
 *
 * This is deliberately a *cloud DTO* rather than a reuse of the `:parleykit`
 * STT type: the two evolve for different reasons, and the upload layer must be
 * able to pin the on-the-wire field names even if the live-transcription type
 * moves. The meeting layer maps its own segments into this on the way to
 * [com.pathors.parley.upload.MeetingUploader.enqueue].
 */
@Serializable
data class TranscriptSegmentDto(
    /** `"{source}-{index}"` for a committed run, `"{source}-tail"` for the tentative one. */
    val id: String,
    /** Capture source. On a phone this is always "mix" — one mic, provider diarization. */
    val source: String = "mix",
    /** Diarized speaker index within the source; 0 = unknown/single. */
    val speaker: Int = 0,
    val text: String,
    val isFinal: Boolean = true,
    val startMs: Long = 0,
    val endMs: Long = 0,
)

/**
 * A recording's full entry JSON (`GET /recordings/{id}/meta`) — the desktop's
 * `HistoryEntry`.
 *
 * Kept as a raw [JsonObject] rather than a typed class, for the same reason iOS
 * keeps a dictionary: the desktop writes fields the phone knows nothing about
 * (brief, intel, deliveryAssessment, companyId …), and a phone-side re-push must
 * not silently drop them.
 */
class RecordingMeta(val raw: JsonObject) {

    val id: String get() = raw.stringOrNull("id").orEmpty()
    val title: String get() = raw.stringOrNull("title").orEmpty()
    val source: String get() = raw.stringOrNull("source") ?: "live"
    val createdAt: Double get() = raw.numberOrNull("createdAt") ?: 0.0
    val durationMs: Double get() = raw.numberOrNull("durationMs") ?: 0.0
    val analyzed: Boolean get() = raw.booleanOrNull("analyzed") ?: false

    /** Audio file name within the entry folder ("audio.ogg"), or null if none. */
    val audio: String? get() = raw.stringOrNull("audio")
    val hasAudio: Boolean get() = audio != null

    /** Personal folder this entry lives in; null = the personal root. */
    val folderId: String? get() = raw.stringOrNull("folderId")

    /** Speaker key (`"{source}-{speaker}"`) → display name assigned by the user. */
    val speakerNames: Map<String, String>
        get() = (raw["speakerNames"] as? JsonObject)
            ?.mapNotNull { (key, value) ->
                (value as? JsonPrimitive)?.takeIf { it.isString }?.let { key to it.content }
            }
            ?.toMap()
            .orEmpty()

    val segments: List<TranscriptSegmentDto>
        get() = (raw["segments"] as? JsonArray)
            ?.mapNotNull { element ->
                val obj = element as? JsonObject ?: return@mapNotNull null
                val id = obj.stringOrNull("id") ?: return@mapNotNull null
                val text = obj.stringOrNull("text") ?: return@mapNotNull null
                TranscriptSegmentDto(
                    id = id,
                    source = obj.stringOrNull("source") ?: "mix",
                    speaker = obj.intOrNull("speaker") ?: 0,
                    text = text,
                    isFinal = obj.booleanOrNull("isFinal") ?: true,
                    startMs = obj.longOrNull("startMs") ?: 0L,
                    endMs = obj.longOrNull("endMs") ?: 0L,
                )
            }
            .orEmpty()

    /** The key a segment's speaker name is stored under: `"{source}-{speaker}"`. */
    fun speakerKey(segment: TranscriptSegmentDto): String = "${segment.source}-${segment.speaker}"

    /**
     * The user-assigned name for a segment's speaker, or null when there is none.
     * The fallback label ("You" / "Them" / "Speaker N") is display copy and so
     * belongs to the UI layer, which owns the bilingual string table.
     */
    fun speakerName(segment: TranscriptSegmentDto): String? =
        speakerNames[speakerKey(segment)]?.takeIf { it.isNotEmpty() }

    /** How many findings a desktop analysis has attached, for a summary row. */
    val findingsCount: Int get() = (raw["findings"] as? JsonArray)?.size ?: 0

    /** How many action items a desktop analysis has attached. */
    val actionItemsCount: Int get() = (raw["actionItems"] as? JsonArray)?.size ?: 0

    /**
     * A copy with a different `folderId`, every other field preserved verbatim.
     *
     * Moving to the personal root writes an explicit `"folderId": null` rather
     * than dropping the key — the statement iOS (`RecordingMeta.folderId`'s
     * setter) and the desktop (`buildSummary`) both make. An absent key is what
     * a fresh upload with no folder says; a re-push that is *un*filing a
     * recording has to say so out loud, or a server that merges would keep the
     * old folder.
     */
    fun withFolderId(folderId: String?): RecordingMeta = RecordingMeta(
        buildJsonObject {
            raw.forEach { (key, value) -> if (key != "folderId") put(key, value) }
            put("folderId", if (folderId != null) JsonPrimitive(folderId) else JsonNull)
        }
    )

    /**
     * Swap in a transcript produced by a later, better pass over the same audio,
     * and change nothing else.
     *
     * Surgical on purpose. A re-transcription of a recording that has been
     * around for a while is not a fresh upload: the entry may carry speaker
     * names somebody typed, findings and action items from a desktop analysis, a
     * brief, meeting context, a filing decision. Rebuilding the meta from the
     * new transcript would be correct about the words and would silently throw
     * all of that away — a far worse outcome than the thin transcript the person
     * was trying to fix. Keeping [raw] and replacing two keys in it is what
     * makes that guarantee hold for fields this app has never heard of.
     *
     * `speakerNames` is the one field this arguably *should* clear, since a
     * second diarization pass can number the speakers differently. It is kept
     * anyway: a name attached to the wrong turn is visible and fixable in
     * seconds, and a name the user typed and then lost is neither.
     *
     * The duration is taken as whichever is longer, matching the queue's own
     * reconciliation — a batch job's reported length can undershoot what the
     * recording already knew about itself.
     */
    fun replacingTranscript(
        segments: List<TranscriptSegmentDto>,
        durationMs: Double,
    ): RecordingMeta = RecordingMeta(
        buildJsonObject {
            raw.forEach { (key, value) ->
                if (key != "segments" && key != "durationMs") put(key, value)
            }
            put("segments", encodeSegments(segments))
            put("durationMs", msPrimitive(maxOf(durationMs, this@RecordingMeta.durationMs)))
        }
    )

    override fun toString(): String = raw.toString()

    companion object {
        /**
         * The `segments` array as every Parley client writes it.
         *
         * `isFinal` is written as `true` unconditionally: the tentative tail is
         * never persisted, so everything that reaches here is committed by
         * definition, and a segment that arrived claiming otherwise would
         * confuse a desktop reading the entry back.
         */
        fun encodeSegments(segments: List<TranscriptSegmentDto>): JsonArray = buildJsonArray {
            segments.forEach { segment ->
                addJsonObject {
                    put("id", segment.id)
                    put("source", segment.source)
                    put("speaker", segment.speaker)
                    put("text", segment.text)
                    put("isFinal", true)
                    put("startMs", segment.startMs)
                    put("endMs", segment.endMs)
                }
            }
        }
    }
}

/**
 * The cloud DTO for a segment the relay or a batch job produced.
 *
 * The two types stay separate on purpose (see [TranscriptSegmentDto]); this is
 * the one place the conversion lives, so a field added to either is a compile
 * error here rather than a silently dropped value on the wire.
 */
fun TranscriptSegment.toDto(): TranscriptSegmentDto = TranscriptSegmentDto(
    id = id,
    source = source,
    speaker = speaker,
    text = text,
    isFinal = isFinal,
    startMs = startMs,
    endMs = endMs,
)

fun List<TranscriptSegment>.toDtos(): List<TranscriptSegmentDto> = map { it.toDto() }

// ── JsonObject readers ────────────────────────────────────────────────────────
// Tolerant on purpose: a field the desktop wrote with an unexpected type must
// degrade to the default, never crash a library listing.

internal fun JsonObject.stringOrNull(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

internal fun JsonObject.numberOrNull(key: String): Double? =
    (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull

internal fun JsonObject.intOrNull(key: String): Int? =
    (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull

internal fun JsonObject.longOrNull(key: String): Long? =
    (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull

internal fun JsonObject.booleanOrNull(key: String): Boolean? =
    (this[key] as? JsonPrimitive)?.booleanOrNull

/**
 * Epoch-millisecond (and duration) numbers, written the way every other Parley
 * client writes them.
 *
 * Kotlin's default `Double` encoder would emit `1.723600000123E12` for a
 * timestamp — valid JSON, and `JSON.parse` reads it fine, but no other client
 * produces it and it reads as corrupt in the D1 row. So: decode as a Double
 * (iOS pushes `timeIntervalSince1970 * 1000`, which can be fractional, and the
 * value comes back through a SQLite INTEGER column that keeps the fraction),
 * encode integral values as integers.
 */
internal object EpochMillisSerializer : KSerializer<Double> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("com.pathors.parley.cloud.EpochMillis", PrimitiveKind.DOUBLE)

    override fun serialize(encoder: Encoder, value: Double) {
        val asLong = value.toLong()
        if (encoder is JsonEncoder && asLong.toDouble() == value) {
            encoder.encodeJsonElement(JsonPrimitive(asLong))
        } else {
            encoder.encodeDouble(value)
        }
    }

    override fun deserialize(decoder: Decoder): Double = decoder.decodeDouble()
}

/** The same integer-when-integral rule, for hand-built meta JSON. */
internal fun msPrimitive(value: Double): JsonPrimitive {
    val asLong = value.toLong()
    return if (asLong.toDouble() == value) JsonPrimitive(asLong) else JsonPrimitive(value)
}

/** Where a recording came from — the `source` field of a summary and its meta. */
object RecordingSource {
    /** Captured live in the app (iOS only ever pushes this). */
    const val LIVE = "live"

    /** Imported from an existing audio file — Android/desktop only. */
    const val UPLOAD = "upload"
}
