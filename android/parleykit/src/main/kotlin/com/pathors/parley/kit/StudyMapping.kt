package com.pathors.parley.kit

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * What the study stages' answers become — the desktop's mapping rules, rule for
 * rule (`mapTimelineEvent` / `parseClockMs` / `snapToSegment` in
 * `src/lib/ai/timeline.ts`, `mapActionItem` in `actionItems.ts`, the
 * `DeliveryAssessment` assembly in `delivery.ts`, the kind guard in
 * `meetingKind.ts`). The model is not trusted: every rule here exists because
 * an answer once broke it.
 *
 * Answers are read leniently (the phone asks for JSON in words, so a code
 * fence or a line of preamble around the object is tolerated — the same
 * [FilingSuggester.firstJsonObject] the filing pass uses); a reply with no
 * object in it is null, which the caller treats as a failed stage.
 */
object StudyMapping {

    private val json = Json { ignoreUnknownKeys = true }

    /** The first JSON object in a model reply, or null. */
    fun parseObject(content: String): JsonObject? {
        val text = FilingSuggester.firstJsonObject(content) ?: return null
        return runCatching { json.parseToJsonElement(text) }.getOrNull() as? JsonObject
    }

    // ── meeting kind ─────────────────────────────────────────────────────────

    /** The classified kind, or null for anything but one of the four. */
    fun meetingKind(content: String): MeetingKind? =
        parseObject(content)?.let { MeetingKind.fromWire(it.rawString("kind")) }

    // ── findings ─────────────────────────────────────────────────────────────

    private val CLOCK = Regex("""(\d{1,2}):(\d{2})(?::(\d{2}))?""")

    /** A model-cited "[m:ss]" / "m:ss" / "h:mm:ss", in milliseconds; null when there is none. */
    fun parseClockMs(raw: String?): Long? {
        if (raw.isNullOrEmpty()) return null
        val match = CLOCK.find(raw) ?: return null
        val a = match.groupValues[1].toLong()
        val b = match.groupValues[2].toLong()
        val c = match.groups[3]?.value?.toLong()
        val totalSec = if (c == null) a * SECONDS_PER_MINUTE + b else a * SECONDS_PER_HOUR + b * SECONDS_PER_MINUTE + c
        return totalSec * MS_PER_SECOND
    }

    /**
     * Snap a parsed (second-precision) clock to a real transcript line: the line
     * that DISPLAYS that clock, else the line in progress at that time, else the
     * nearest line, else the raw value — so a jump lands on the words.
     */
    fun snapToSegment(atMs: Long, segments: List<TranscriptSegment>): Long {
        var exact: Long? = null
        var active: Long? = null
        var nearest: Long? = null
        var nearestDelta = Long.MAX_VALUE
        for (s in segments) {
            if (s.text.isBlank()) continue
            if (exact == null && s.startMs >= atMs && s.startMs < atMs + MS_PER_SECOND) exact = s.startMs
            if (s.startMs <= atMs && atMs <= s.endMs) active = s.startMs
            val delta = kotlin.math.abs(s.startMs - atMs)
            if (delta < nearestDelta) {
                nearestDelta = delta
                nearest = s.startMs
            }
        }
        return exact ?: active ?: nearest ?: atMs
    }

    /**
     * Place ONE raw moment on the timeline, or null when it cannot be: a field
     * the UI renders is missing (which ones depends on the lens), or it has no
     * usable time — none, negative, or more than five seconds past the last
     * line (a model inventing a moment after the meeting ended).
     *
     * @param maxMs the transcript's last end, or null when it has none (no bound).
     */
    fun timelineEvent(
        raw: JsonObject,
        id: String,
        segments: List<TranscriptSegment>,
        validEvalIds: Set<String>,
        maxMs: Long?,
        lens: AnalysisLens,
    ): TimelineEvent? {
        // The desktop's schema admits only these values; a moment outside them is
        // dropped here rather than failing the whole answer.
        val severity = raw.rawString("severity")?.takeIf { it in SEVERITIES } ?: return null
        val title = raw.rawString("title")?.takeIf { it.isNotEmpty() } ?: return null
        val detail = raw.rawString("detail")?.takeIf { it.isNotEmpty() } ?: return null
        val side = raw.rawString("side")?.takeIf { it in SIDES }
        val category = raw.rawString("category")?.takeIf { it in CATEGORIES }
        if (lens.hasSides && side == null) return null
        if (lens.hasCategories && category == null) return null

        val atMs = placedAtMs(raw, segments, maxMs) ?: return null

        val matched = matchedEvalIds(raw, validEvalIds)
        val isEval = raw.rawString("source") == "eval" && matched.isNotEmpty()
        val resolution = raw.rawString("resolution")?.trim().orEmpty()
        val resolvedFlag = (raw["resolved"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
        // A "resolved" with no "how" is useless and ambiguous: keep the severity.
        val resolved = lens.hasResolution && resolvedFlag == true && resolution.isNotEmpty()
        return TimelineEvent(
            id = id,
            atMs = atMs.coerceAtLeast(0L),
            side = if (lens.hasSides) side else null,
            category = if (lens.hasCategories) category else null,
            severity = severity,
            source = if (isEval) "eval" else "extra",
            evalIds = if (isEval) matched else null,
            title = title,
            detail = detail,
            resolved = true.takeIf { resolved },
            resolution = if (resolved) resolution else null,
        )
    }

    /**
     * Where a raw moment lands on the timeline, snapped to the nearest line
     * start, or null when it has no usable time — none, negative, or more than
     * five seconds past the last line.
     */
    private fun placedAtMs(raw: JsonObject, segments: List<TranscriptSegment>, maxMs: Long?): Long? {
        val parsed = parseClockMs(raw.rawString("time")) ?: return null
        if (parsed < 0 || (maxMs != null && parsed > maxMs + MAX_OVERSHOOT_MS)) return null
        return snapToSegment(parsed, segments)
    }

    /** The eval ids a moment cites that are actually configured, trimmed, in order. */
    private fun matchedEvalIds(raw: JsonObject, validEvalIds: Set<String>): List<String> =
        (raw["evalIds"] as? JsonArray).orEmpty()
            .mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content?.trim() }
            .filter { it.isNotEmpty() && it in validEvalIds }

    /**
     * Every placeable moment in a findings reply, in time order (a stable sort,
     * as the desktop's). [newId] mints the id for the moment at an index.
     * Null when the reply holds no object with a `moments` array — a failed
     * pass, not an empty one.
     */
    fun timelineEvents(
        content: String,
        segments: List<TranscriptSegment>,
        evals: List<EvalDef>,
        lens: AnalysisLens,
        newId: (Int) -> String,
    ): List<TimelineEvent>? {
        val moments = parseObject(content)?.get("moments") as? JsonArray ?: return null
        val valid = evals.mapTo(HashSet()) { it.id }
        val maxMs = segments.maxOfOrNull { it.endMs }?.takeIf { it > 0 }
        return moments
            .mapIndexedNotNull { index, element ->
                (element as? JsonObject)?.let { timelineEvent(it, newId(index), segments, valid, maxMs, lens) }
            }
            .sortedBy { it.atMs }
    }

    // ── action items ─────────────────────────────────────────────────────────

    /**
     * Every usable action item in a reply, in the model's order. An item links
     * to a finding only when the id names one; its moment is the finding's, else
     * the clock it cites. Null when the reply holds no `actions` array.
     */
    fun actionItems(content: String, findings: List<TimelineEvent>, newId: (Int) -> String): List<ActionItem>? {
        val actions = parseObject(content)?.get("actions") as? JsonArray ?: return null
        val byId = findings.associateBy { it.id }
        return actions.mapIndexedNotNull { index, element ->
            val raw = element as? JsonObject ?: return@mapIndexedNotNull null
            val text = raw.rawString("text")?.takeIf { it.isNotEmpty() } ?: return@mapIndexedNotNull null
            val linked = raw.rawString("linkedEventId")?.let(byId::get)
            ActionItem(
                id = newId(index),
                text = text,
                done = false,
                linkedEventId = linked?.id,
                atMs = linked?.atMs ?: parseClockMs(raw.rawString("time")),
                severity = linked?.severity,
            )
        }
    }

    // ── delivery ─────────────────────────────────────────────────────────────

    /**
     * The delivery read, or null when the reply is unusable: no object, or a
     * tone or filler level outside the schema's values (the desktop's schema
     * rejects those too). An unknown pace is dropped rather than fatal.
     */
    fun deliveryAssessment(content: String): DeliveryAssessment? {
        val obj = parseObject(content) ?: return null
        val tone = obj.rawString("tone")?.takeIf { it in DeliveryAssessment.TONES } ?: return null
        val level = obj.rawString("filler_level")?.takeIf { it in DeliveryAssessment.FILLER_LEVELS } ?: return null
        val examples = (obj["filler_examples"] as? JsonArray).orEmpty()
            .mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content?.trim() }
            .filter { it.isNotEmpty() }
        return DeliveryAssessment(
            tone = tone,
            toneEvidence = obj.rawString("tone_evidence")?.trim().orEmpty(),
            fillers = FillerAssessment(level = level, examples = examples, note = obj.rawString("filler_note")?.trim().orEmpty()),
            pace = obj.rawString("pace")?.takeIf { it in DeliveryAssessment.PACES },
            summary = obj.rawString("summary")?.trim().orEmpty(),
        )
    }

    private fun JsonObject.rawString(key: String): String? =
        (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    val SEVERITIES = setOf("info", "warn", "critical")
    val SIDES = setOf("me", "them")
    val CATEGORIES = setOf("decision", "open", "fact")

    private const val SECONDS_PER_MINUTE = 60L
    private const val SECONDS_PER_HOUR = 3600L
    private const val MS_PER_SECOND = 1000L

    /** How far past the last line a cited time may land (the desktop's `maxMs + 5000`). */
    const val MAX_OVERSHOOT_MS = 5000L
}
