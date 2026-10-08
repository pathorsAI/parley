package com.pathors.parley.kit

import java.util.Locale

/**
 * The study stages' prompts, assembled exactly as the desktop assembles them
 * (`src/lib/ai/meetingKind.ts`, `timeline.ts`, `actionItems.ts`, `report.ts`,
 * `delivery.ts`) out of the same text — `shared/prompts/study.json`, through
 * the generated [StudyPrompts]. Nothing prompt-shaped is written here: this
 * file only knows the ORDER the pieces go in, and that order is checked
 * against what the desktop really builds (`shared/prompts/study.golden.json`,
 * `StudyPromptsGoldenTest`).
 *
 * The phone has no "about me" profile, so the desktop's `profileContext` is
 * always empty here, and it only ever analyses a finished recording, so only
 * the replay / post-call variants exist.
 *
 * Each `…System` function is the desktop's system prompt verbatim. The request
 * the phone sends appends one more block ([phoneSchema]): the desktop gets the
 * JSON shape from its schema-constrained request, the phone asks for it in
 * words (see [FilingSuggester.systemPrompt] for why it sends no
 * `response_format`).
 */
object StudyPromptBuilder {

    private val PLACEHOLDER = Regex("""\{\{(\w+)\}\}""")

    /** Fill every `{{name}}` in one pass; a placeholder with no value is a bug. */
    fun fill(template: String, vars: Map<String, String>): String =
        PLACEHOLDER.replace(template) { match ->
            val key = match.groupValues[1]
            requireNotNull(vars[key]) { "no value for {{$key}}" }
        }

    /** The desktop's `outputLanguageInstruction`: prose in the app's UI language. */
    fun outputLanguage(language: FilingLanguage): String = fill(
        StudyPrompts.OUTPUT_LANGUAGE_TEMPLATE,
        mapOf(
            "language" to if (language == FilingLanguage.ZH_TW) {
                StudyPrompts.OUTPUT_LANGUAGE_NAME_ZH_TW
            } else {
                StudyPrompts.OUTPUT_LANGUAGE_NAME_EN
            },
        ),
    )

    /** "Here is the JSON shape" — the one block the phone adds to a desktop system prompt. */
    fun phoneSchema(shape: String): String = StudyPrompts.SCHEMA_PREFIX + shape

    // ── shared inputs ────────────────────────────────────────────────────────

    /**
     * The desktop's `meetingBriefText`: the free-text context plus the
     * negotiation setup, each labelled. "" when nothing was entered.
     */
    fun meetingBrief(context: String, batna: String = "", target: String = "", floor: String = ""): String {
        val parts = mutableListOf<String>()
        if (context.isNotBlank()) parts += context.trim()
        val setup = buildList {
            if (batna.isNotBlank()) add("My BATNA (best alternative if no deal): ${batna.trim()}")
            if (target.isNotBlank()) add("My target (what I'm aiming for): ${target.trim()}")
            if (floor.isNotBlank()) add("My bottom line / walk-away point: ${floor.trim()}")
        }
        if (setup.isNotEmpty()) parts += "My negotiation setup —\n" + setup.joinToString("\n")
        return parts.joinToString("\n\n")
    }

    /** The `Meeting context: …` block every stage opens its user message with, or "". */
    fun contextBlock(meetingBrief: String): String {
        val trimmed = meetingBrief.trim()
        return if (trimmed.isEmpty()) "" else StudyPrompts.MEETING_CONTEXT_PREFIX + trimmed + "\n\n"
    }

    /** The desktop's `transcriptWithTimestamps`: `[m:ss] [Speaker] text`, final lines only, oldest first. */
    fun transcriptWithTimestamps(segments: List<TranscriptSegment>, label: (TranscriptSegment) -> String): String =
        FilingSuggester.transcript(segments, label)

    /** The desktop's `transcriptAsText`: `[Speaker] text`, final lines only, oldest first. */
    fun transcriptAsText(segments: List<TranscriptSegment>, label: (TranscriptSegment) -> String): String =
        segments
            .filter { it.isFinal && it.text.isNotBlank() }
            .sortedBy { it.startMs }
            .joinToString("\n") { "[${label(it)}] ${it.text.trim()}" }

    // ── meeting kind ─────────────────────────────────────────────────────────

    fun meetingKindSystem(): String = StudyPrompts.MEETING_KIND_SYSTEM + StudyPrompts.JSON_MODE_INSTRUCTION

    fun meetingKindPrompt(meetingBrief: String, transcript: String): String =
        contextBlock(meetingBrief) + StudyPrompts.MEETING_KIND_TRANSCRIPT_HEADER + "\n" + transcript

    // ── findings (the timeline) ──────────────────────────────────────────────

    /** The desktop's `buildSystem(lens, "replay")` plus the JSON and language instructions. */
    fun timelineSystem(lens: AnalysisLens, language: FilingLanguage): String {
        val key = lens.wire
        val body = fill(
            StudyPrompts.TIMELINE_SYSTEM_TEMPLATE,
            mapOf(
                "intro" to fill(
                    StudyPrompts.TIMELINE_INTRO.getValue(key),
                    mapOf("tense" to StudyPrompts.TIMELINE_TENSE_REPLAY),
                ),
                "selectionRule" to StudyPrompts.TIMELINE_SELECTION_RULE.getValue(key),
                "fieldGuide" to StudyPrompts.TIMELINE_FIELD_GUIDE.getValue(key),
                "severityRule" to StudyPrompts.TIMELINE_SEVERITY_RULE.getValue(key),
                "resolvedFields" to if (lens.hasResolution) StudyPrompts.TIMELINE_RESOLVED_FIELDS else "",
                "interpretation" to StudyPrompts.TIMELINE_INTERPRETATION.getValue(key),
                "resolvedBlock" to if (lens.hasResolution) StudyPrompts.TIMELINE_RESOLVED_BLOCK else "",
                "modeBlock" to StudyPrompts.TIMELINE_MODE_REPLAY.getValue(key),
            ),
        )
        return body + StudyPrompts.JSON_MODE_INSTRUCTION + outputLanguage(language)
    }

    fun timelinePrompt(meetingBrief: String, evals: List<EvalDef>, transcript: String): String {
        val list = if (evals.isEmpty()) {
            StudyPrompts.TIMELINE_NO_EVALS
        } else {
            evals.joinToString("\n\n") {
                fill(StudyPrompts.TIMELINE_EVAL_ENTRY, mapOf("id" to it.id, "name" to it.name, "prompt" to it.prompt))
            }
        }
        return contextBlock(meetingBrief) +
            StudyPrompts.TIMELINE_EVALS_HEADER + "\n" + list + "\n\n" +
            StudyPrompts.TIMELINE_TRANSCRIPT_LABEL_REPLAY + ":\n" + transcript.ifEmpty { StudyPrompts.NO_SPEECH }
    }

    // ── action items ─────────────────────────────────────────────────────────

    fun actionItemsSystem(lens: AnalysisLens, language: FilingLanguage): String {
        val body = fill(
            StudyPrompts.ACTION_ITEMS_SYSTEM_TEMPLATE,
            mapOf(
                "intro" to StudyPrompts.ACTION_ITEMS_INTRO.getValue(lens.wire),
                "flavour" to if (lens == AnalysisLens.DECISION) {
                    StudyPrompts.ACTION_ITEMS_FLAVOUR_DECISION
                } else {
                    StudyPrompts.ACTION_ITEMS_FLAVOUR_DEFAULT
                },
            ),
        )
        return body + StudyPrompts.JSON_MODE_INSTRUCTION + outputLanguage(language)
    }

    fun actionItemsPrompt(meetingBrief: String, findings: List<TimelineEvent>, transcript: String): String {
        val list = if (findings.isEmpty()) {
            StudyPrompts.ACTION_ITEMS_NO_FINDINGS
        } else {
            findings.joinToString("\n\n") {
                fill(
                    StudyPrompts.ACTION_ITEMS_FINDING_ENTRY,
                    mapOf(
                        "id" to it.id,
                        "tag" to (it.side ?: it.category ?: StudyPrompts.ACTION_ITEMS_FINDING_TAG_FALLBACK),
                        "title" to it.title,
                        "detail" to it.detail,
                    ),
                )
            }
        }
        return contextBlock(meetingBrief) +
            StudyPrompts.ACTION_ITEMS_FINDINGS_HEADER + "\n" + list + "\n\n" +
            StudyPrompts.ACTION_ITEMS_TRANSCRIPT_HEADER + "\n" + transcript
    }

    // ── brief ────────────────────────────────────────────────────────────────

    /** The brief is markdown, not JSON: no JSON instruction and no schema. */
    fun briefSystem(lens: AnalysisLens, language: FilingLanguage): String =
        fill(
            StudyPrompts.BRIEF_SYSTEM_TEMPLATE,
            mapOf(
                "intro" to StudyPrompts.BRIEF_INTRO.getValue(lens.wire),
                "sections" to StudyPrompts.BRIEF_SECTIONS.getValue(lens.wire),
            ),
        ) + outputLanguage(language)

    /**
     * The brief's user message: the context, the evaluation rubric, the action
     * items as the agenda checklist (the desktop folds them in this way), then
     * the transcript.
     */
    fun briefPrompt(
        meetingBrief: String,
        evals: List<EvalDef>,
        actionItems: List<ActionItem>,
        transcript: String,
    ): String {
        val rubric = evals.joinToString("\n") {
            fill(StudyPrompts.BRIEF_RUBRIC_ENTRY, mapOf("name" to it.name, "prompt" to it.prompt))
        }
        val checklist = actionItems.joinToString("\n") {
            fill(StudyPrompts.BRIEF_CHECKLIST_ENTRY, mapOf("mark" to if (it.done) "x" else " ", "text" to it.text))
        }
        return contextBlock(meetingBrief) +
            (if (rubric.isNotEmpty()) StudyPrompts.BRIEF_RUBRIC_HEADER + "\n" + rubric + "\n\n" else "") +
            (if (checklist.isNotEmpty()) StudyPrompts.BRIEF_CHECKLIST_HEADER + "\n" + checklist + "\n\n" else "") +
            StudyPrompts.BRIEF_TRANSCRIPT_HEADER + "\n" + transcript.ifEmpty { StudyPrompts.NO_SPEECH }
    }

    // ── delivery ─────────────────────────────────────────────────────────────

    fun deliverySystem(language: FilingLanguage): String =
        fill(StudyPrompts.DELIVERY_SYSTEM_TEMPLATE, mapOf("setting" to StudyPrompts.DELIVERY_SETTING_POST)) +
            StudyPrompts.JSON_MODE_INSTRUCTION + outputLanguage(language)

    /**
     * The delivery pass's user message. [measuredRateHz] is the desktop's
     * acoustically measured articulation rate (`speechRateHz`) when the
     * recording carries one — a phone recording does not.
     */
    fun deliveryPrompt(
        meetingBrief: String,
        measuredRateHz: Double?,
        language: FilingLanguage,
        transcript: String,
    ): String {
        val mc = meetingBrief.trim()
        val rate = if (measuredRateHz != null && measuredRateHz != 0.0) {
            fill(
                StudyPrompts.DELIVERY_MEASURED_RATE_TEMPLATE,
                mapOf(
                    "rate" to String.format(Locale.ROOT, "%.1f", measuredRateHz),
                    "perMinute" to Math.round(measuredRateHz * SECONDS_PER_MINUTE).toString(),
                ),
            )
        } else {
            ""
        }
        val watchlist = fill(
            StudyPrompts.DELIVERY_WATCHLIST_TEMPLATE,
            mapOf("words" to FillerWords.watchlist(language).joinToString(", ")),
        )
        val ctx = (if (mc.isNotEmpty()) StudyPrompts.MEETING_CONTEXT_PREFIX + mc + "\n\n" else "") + rate + watchlist
        return ctx + StudyPrompts.DELIVERY_TRANSCRIPT_LABEL_POST + ":\n" + transcript
    }

    // ── requests ─────────────────────────────────────────────────────────────

    /**
     * One request on the hosted endpoint. No temperature and no `max_tokens`:
     * the desktop sends neither for these stages (the provider default, and
     * the cloud's own output cap), and the phone asks the same question.
     */
    fun request(model: String, system: String, user: String): CloudChat.Request = CloudChat.Request(
        model = model,
        temperature = null,
        maxTokens = null,
        messages = listOf(
            CloudChat.Message(role = "system", content = system),
            CloudChat.Message(role = "user", content = user),
        ),
    )

    private const val SECONDS_PER_MINUTE = 60
}
