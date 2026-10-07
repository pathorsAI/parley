package com.pathors.parley.kit

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.boolean
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The phone asks the model exactly what the desktop asks it.
 *
 * `shared/prompts/study.golden.json` holds the system and user prompts the
 * DESKTOP builds (`tests/studyPrompts.test.ts` writes it from the real desktop
 * functions, and fails when it goes stale) for fixed inputs: every stage, the
 * three lenses, both UI languages. Here the phone builds the same prompts from
 * the same inputs and they must match character for character — so a change
 * to how either side assembles the pieces fails a test instead of quietly
 * analysing a recording differently on the phone.
 *
 * The desktop labels an unnamed diarized speaker "Speaker N" (with an
 * undecided speaker 0 as "Speaker 1"); the phone's own labels are localized
 * letters, so the test hands the builder the desktop's labeller. Which label
 * a line carries is display copy, not the prompt's structure.
 */
class StudyPromptsGoldenTest {

    private val golden: JsonObject = run {
        val file = File("../../shared/prompts/study.golden.json")
        assertTrue("not found from ${File("").absolutePath}: $file", file.isFile)
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    private val input = golden["input"]!!.jsonObject

    private val segments: List<TranscriptSegment> = input["segments"]!!.jsonArray.map {
        val o = it.jsonObject
        TranscriptSegment(
            id = o.str("id"),
            source = o.str("source"),
            speaker = o["speaker"]!!.jsonPrimitive.int,
            text = o.str("text"),
            isFinal = o["isFinal"]!!.jsonPrimitive.boolean,
            startMs = o["startMs"]!!.jsonPrimitive.long,
            endMs = o["endMs"]!!.jsonPrimitive.long,
        )
    }

    private val names: Map<String, String> =
        input["speakerNames"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content }

    private val context = input.str("meetingContext")
    private val findings = TimelineEvent.listFromJson(input["findings"])
    private val actionItems = ActionItem.listFromJson(input["actionItems"])

    /** The desktop's `speakerLabel` for a diarized `mix` line. */
    private val desktopLabel: (TranscriptSegment) -> String = { s ->
        names["${s.source}-${s.speaker}"] ?: "Speaker ${if (s.speaker == 0) 1 else s.speaker}"
    }

    private val timestamped = StudyPromptBuilder.transcriptWithTimestamps(segments, desktopLabel)
    private val plain = StudyPromptBuilder.transcriptAsText(segments, desktopLabel)

    private data class Built(val system: String, val prompt: String)

    private fun build(case: JsonObject): Built {
        val language = if (case.str("language") == "zh-TW") FilingLanguage.ZH_TW else FilingLanguage.EN
        val kind = case["kind"]?.jsonPrimitive?.content?.let { MeetingKind.fromWire(it) }
        val lens = AnalysisLens.of(kind)
        val evals = EvalPresets.forKind(kind, language)
        return when (case.str("stage")) {
            "meetingKind" -> Built(
                StudyPromptBuilder.meetingKindSystem(),
                StudyPromptBuilder.meetingKindPrompt(context, timestamped),
            )
            "timeline" -> Built(
                StudyPromptBuilder.timelineSystem(lens, language),
                StudyPromptBuilder.timelinePrompt(context, evals, timestamped),
            )
            "actionItems" -> Built(
                StudyPromptBuilder.actionItemsSystem(lens, language),
                StudyPromptBuilder.actionItemsPrompt(context, findings, timestamped),
            )
            "brief" -> Built(
                StudyPromptBuilder.briefSystem(lens, language),
                StudyPromptBuilder.briefPrompt(context, evals, actionItems, timestamped),
            )
            "delivery" -> Built(
                StudyPromptBuilder.deliverySystem(language),
                StudyPromptBuilder.deliveryPrompt(context, null, language, plain),
            )
            else -> error("unknown stage ${case.str("stage")}")
        }
    }

    @Test
    fun `every golden case is built identically on the phone`() {
        val cases = golden["cases"] as JsonArray
        assertTrue("no golden cases", cases.size >= 22)
        for (element in cases) {
            val case = element.jsonObject
            val label = listOfNotNull(case.str("stage"), case["kind"]?.jsonPrimitive?.content, case.str("language"))
                .joinToString("/")
            val built = build(case)
            assertEquals("$label system", case.str("system"), built.system)
            assertEquals("$label prompt", case.str("prompt"), built.prompt)
        }
    }

    @Test
    fun `the lens a golden case names is the lens its kind earns`() {
        for (element in golden["cases"] as JsonArray) {
            val case = element.jsonObject
            val kind = case["kind"]?.jsonPrimitive?.content ?: continue
            assertEquals(case.str("lens"), MeetingKind.fromWire(kind)!!.lens.wire)
        }
    }

    private fun JsonObject.str(key: String): String = this[key]!!.jsonPrimitive.content
}
