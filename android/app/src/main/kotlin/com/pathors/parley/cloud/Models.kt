package com.pathors.parley.cloud

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull

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
)

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

    /** A copy with a different `folderId`, every other field preserved verbatim. */
    fun withFolderId(folderId: String?): RecordingMeta = RecordingMeta(
        buildJsonObject {
            raw.forEach { (key, value) -> if (key != "folderId") put(key, value) }
            if (folderId != null) put("folderId", JsonPrimitive(folderId))
        }
    )

    override fun toString(): String = raw.toString()
}

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
