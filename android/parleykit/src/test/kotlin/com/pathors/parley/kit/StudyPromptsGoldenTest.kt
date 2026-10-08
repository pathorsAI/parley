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
 * The labels are the ones the phone's study pass uses ([SpeakerLabel.prompt]),
 * not its localized display copy: an unnamed speaker reads "You" / "Them" /
 * "Remote N" / "Speaker N" in the prompt exactly as on the desktop, on every
 * source — the golden's `unnamedSpeakers` cases pin that.
 */
class StudyPromptsGoldenTest {

    private val golden: JsonObject = run {
        val file = File("../../shared/prompts/study.golden.json")
        assertTrue("not found from ${File("").absolutePath}: $file", file.isFile)
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    private val input = golden["input"]!!.jsonObject

    private val segments: List<TranscriptSegment> = segmentsOf(input)

    private fun segmentsOf(holder: JsonObject): List<TranscriptSegment> = holder["segments"]!!.jsonArray.map {
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

    private val timestamped = StudyPromptBuilder.transcriptWithTimestamps(segments) { SpeakerLabel.prompt(it, names) }
    private val plain = StudyPromptBuilder.transcriptAsText(segments) { SpeakerLabel.prompt(it, names) }

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
    fun `unnamed speakers on every source are labelled in the prompt as the desktop labels them`() {
        val unnamed = golden["unnamedSpeakers"]!!.jsonObject
        val unnamedSegments = segmentsOf(unnamed)
        val unnamedNames = unnamed["speakerNames"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content }
        val label: (TranscriptSegment) -> String = { SpeakerLabel.prompt(it, unnamedNames) }
        val cases = unnamed["cases"] as JsonArray
        assertTrue("no unnamed-speaker cases", cases.size >= 4)
        for (element in cases) {
            val case = element.jsonObject
            val language = if (case.str("language") == "zh-TW") FilingLanguage.ZH_TW else FilingLanguage.EN
            val built = when (case.str("stage")) {
                "meetingKind" -> Built(
                    StudyPromptBuilder.meetingKindSystem(),
                    StudyPromptBuilder.meetingKindPrompt(
                        context,
                        StudyPromptBuilder.transcriptWithTimestamps(unnamedSegments, label),
                    ),
                )
                "delivery" -> Built(
                    StudyPromptBuilder.deliverySystem(language),
                    StudyPromptBuilder.deliveryPrompt(
                        context,
                        null,
                        language,
                        StudyPromptBuilder.transcriptAsText(unnamedSegments, label),
                    ),
                )
                else -> error("unknown stage ${case.str("stage")}")
            }
            val name = "${case.str("stage")}/${case.str("language")}"
            assertEquals("$name system", case.str("system"), built.system)
            assertEquals("$name prompt", case.str("prompt"), built.prompt)
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
