package com.pathors.parley.kit

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

/**
 * The study pipeline's outputs in the shapes the desktop writes into a
 * recording's meta (`src/lib/types.ts`), so the desktop, iOS and Android all
 * read one shape. Written with the desktop's key order, and — like
 * `JSON.stringify` — an absent optional is left out rather than written null,
 * except where the desktop itself writes null (`ActionItem.linkedEventId`,
 * `ActionItem.atMs`).
 */

/** One time-anchored finding — the desktop's `TimelineEvent`. */
data class TimelineEvent(
    val id: String,
    val atMs: Long,
    /** "me" / "them" — the opportunity and adversarial lenses only. */
    val side: String? = null,
    /** "decision" / "open" / "fact" — the decision lens only. */
    val category: String? = null,
    /** "info" / "warn" / "critical". */
    val severity: String,
    /** "eval" (matched a configured evaluation) or "extra". */
    val source: String,
    /** The matched evaluation ids; null for an "extra" moment. */
    val evalIds: List<String>? = null,
    val title: String,
    val detail: String,
    /** True only when ME meaningfully handled it (adversarial lens); null otherwise. */
    val resolved: Boolean? = null,
    /** How ME handled it — present exactly when [resolved]. */
    val resolution: String? = null,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("id", id)
        put("atMs", atMs)
        side?.let { put("side", it) }
        category?.let { put("category", it) }
        put("severity", severity)
        put("source", source)
        evalIds?.let { ids -> putJsonArray("evalIds") { ids.forEach { add(JsonPrimitive(it)) } } }
        put("title", title)
        put("detail", detail)
        resolved?.let { put("resolved", it) }
        resolution?.let { put("resolution", it) }
    }

    companion object {
        /**
         * A finding as stored — tolerant, because another analyst (the desktop,
         * an MCP client) may have written it: a finding needs an id and a title;
         * everything else degrades to a default.
         */
        fun fromJson(obj: JsonObject, fallbackId: String): TimelineEvent? {
            val title = obj.text("title") ?: return null
            return TimelineEvent(
                id = obj.text("id") ?: fallbackId,
                atMs = (obj.number("atMs") ?: 0.0).toLong().coerceAtLeast(0L),
                side = obj.text("side"),
                category = obj.text("category"),
                severity = obj.text("severity") ?: "info",
                source = obj.text("source") ?: "extra",
                evalIds = (obj["evalIds"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content },
                title = title,
                detail = obj.text("detail").orEmpty(),
                resolved = obj.bool("resolved"),
                resolution = obj.text("resolution"),
            )
        }

        fun listToJson(events: List<TimelineEvent>): JsonArray = buildJsonArray { events.forEach { add(it.toJson()) } }

        fun listFromJson(element: JsonElement?): List<TimelineEvent> =
            (element as? JsonArray).orEmpty().mapIndexedNotNull { index, item ->
                (item as? JsonObject)?.let { fromJson(it, "finding-$index") }
            }
    }
}

/** One post-meeting action item — the desktop's `ActionItem`. */
data class ActionItem(
    val id: String,
    val text: String,
    val done: Boolean = false,
    /** The finding it derives from, or null for a general item. */
    val linkedEventId: String? = null,
    /** Where on the recording it relates to, or null. */
    val atMs: Long? = null,
    /** Carried from the linked finding. */
    val severity: String? = null,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("id", id)
        put("text", text)
        put("done", done)
        put("linkedEventId", linkedEventId?.let(::JsonPrimitive) ?: JsonNull)
        put("atMs", atMs?.let(::JsonPrimitive) ?: JsonNull)
        severity?.let { put("severity", it) }
    }

    companion object {
        fun listToJson(items: List<ActionItem>): JsonArray = buildJsonArray { items.forEach { add(it.toJson()) } }

        /** The stored items, tolerant like [TimelineEvent.fromJson]; one without text is dropped. */
        fun listFromJson(element: JsonElement?): List<ActionItem> =
            (element as? JsonArray).orEmpty().mapIndexedNotNull { index, item ->
                val obj = item as? JsonObject ?: return@mapIndexedNotNull null
                val text = (obj.text("text") ?: obj.text("title"))?.takeIf { it.isNotBlank() }
                    ?: return@mapIndexedNotNull null
                ActionItem(
                    id = obj.text("id") ?: "action-$index",
                    text = text,
                    done = obj.bool("done") ?: false,
                    linkedEventId = obj.text("linkedEventId"),
                    atMs = obj.number("atMs")?.toLong()?.coerceAtLeast(0L),
                    severity = obj.text("severity"),
                )
            }
    }
}

/** The user's filler-word read — the desktop's `FillerAssessment`. */
data class FillerAssessment(
    /** "ok" or "frequent". */
    val level: String,
    val examples: List<String>,
    val note: String,
)

/** The user's delivery read — the desktop's `DeliveryAssessment`. */
data class DeliveryAssessment(
    /** neutral / warm / firm / sharp / aggressive / rude. */
    val tone: String,
    val toneEvidence: String,
    val fillers: FillerAssessment,
    /** slow / comfortable / fast; null when the model did not say. */
    val pace: String?,
    val summary: String,
) {
    /** Sharp and above: the scorecard marks the tone tile. */
    val toneNeedsWatch: Boolean get() = tone == "sharp" || tone == "aggressive" || tone == "rude"

    fun toJson(): JsonObject = buildJsonObject {
        put("tone", tone)
        put("toneEvidence", toneEvidence)
        putJsonObject("fillers") {
            put("level", fillers.level)
            putJsonArray("examples") { fillers.examples.forEach { add(JsonPrimitive(it)) } }
            put("note", fillers.note)
        }
        pace?.let { put("pace", it) }
        put("summary", summary)
    }

    companion object {
        val TONES = listOf("neutral", "warm", "firm", "sharp", "aggressive", "rude")
        val PACES = listOf("slow", "comfortable", "fast")
        val FILLER_LEVELS = listOf("ok", "frequent")

        /** The stored assessment, or null when there is none (or it is unreadable). */
        fun fromJson(element: JsonElement?): DeliveryAssessment? {
            val obj = element as? JsonObject ?: return null
            val tone = obj.text("tone")?.takeIf { it in TONES } ?: return null
            val fillers = obj["fillers"] as? JsonObject
            return DeliveryAssessment(
                tone = tone,
                toneEvidence = obj.text("toneEvidence").orEmpty(),
                fillers = FillerAssessment(
                    level = fillers?.text("level")?.takeIf { it in FILLER_LEVELS } ?: "ok",
                    examples = (fillers?.get("examples") as? JsonArray).orEmpty()
                        .mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content },
                    note = fillers?.text("note").orEmpty(),
                ),
                pace = obj.text("pace")?.takeIf { it in PACES },
                summary = obj.text("summary").orEmpty(),
            )
        }
    }
}

// ── tolerant readers ──────────────────────────────────────────────────────────

internal fun JsonObject.text(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() }

internal fun JsonObject.number(key: String): Double? =
    (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull

internal fun JsonObject.bool(key: String): Boolean? =
    (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
