package com.pathors.parley.kit

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Onboarding's microphone check, after the words are in: the self-introduction
 * becomes lines of the speaker background and dictionary terms, exactly as on
 * the desktop (`src/lib/onboarding/micCheck.ts`, `appendBackground` and
 * `removeBackgroundLines` in `memoryImport.ts`). A port of iOS
 * `ParleyKit/MicIntro.swift`.
 *
 * The pipeline: the relay's segments are assembled the way the desktop's
 * `CheckTranscript` does (committed runs in order, then the tentative tail);
 * the sentence is normalized (Traditional script, the user's replacements, the
 * product's own name fixed); the hosted model tidies it into 1–3 background
 * lines, names and terms (without an answer, the sentence itself is the line);
 * the company and name the script's blanks held always become terms; and the
 * lines are appended to the background without re-formatting what is there.
 * Testing again takes the previous run's lines and the terms it created back
 * out first.
 *
 * Pure JVM: the Simplified→Traditional transform is `android.icu`, so the app
 * passes it in to [normalize]; the network call is the app's, which sends
 * [requestJson] and hands the answer's content to [parse].
 */
object MicIntro {

    // ── the transcript ───────────────────────────────────────────────────────

    /**
     * The live transcript of one check: committed runs in id order, then the
     * tentative tail. Run ids end in a running number (`mix-3`); the tail is
     * `{source}-tail` and is cleared by the run that settles it.
     */
    class Transcript {
        private val finals = LinkedHashMap<String, String>()
        private var interim = ""

        fun accept(segment: TranscriptSegment) {
            if (segment.isFinal && !segment.id.endsWith("-tail")) {
                finals[segment.id] = segment.text
                interim = ""
            } else {
                interim = segment.text
            }
        }

        val text: String
            get() {
                val committed = finals.entries.sortedBy { order(it.key) }.map { it.value }
                return joinRuns(committed + interim)
            }

        private fun order(id: String): Int =
            RUN_NUMBER.find(id)?.groupValues?.get(1)?.toIntOrNull() ?: Int.MAX_VALUE

        private companion object {
            val RUN_NUMBER = Regex("-(\\d+)$")
        }
    }

    /** Join recognizer runs: CJK runs touch, Latin runs get a space between. */
    fun joinRuns(runs: List<String>): String {
        val out = StringBuilder()
        for (raw in runs) {
            val run = raw.trim()
            if (run.isEmpty()) continue
            val glue = out.isNotEmpty() && isLatinOrDigit(out[out.length - 1]) && isLatinOrDigit(run[0])
            if (glue) out.append(' ')
            out.append(run)
        }
        return out.toString()
    }

    private fun isLatinOrDigit(c: Char): Boolean = c.code < 0x80 && c.isLetterOrDigit()

    // ── normalizing ──────────────────────────────────────────────────────────

    /**
     * The product's name, which the check's script has the user say. It is the
     * first thing Parley ever transcribes for them, so it must not get its own
     * name wrong.
     */
    const val PRODUCT_NAME = "Parley"

    /**
     * How recognizers mishear "Parley" — the desktop's
     * `PRODUCT_NAME_MISHEARINGS`. Safe to rewrite only here: in "I use Parley
     * to…" these can only mean the product. Traditional forms only: the
     * transcript is converted before this runs.
     */
    val PRODUCT_NAME_MISHEARINGS: List<String> = listOf(
        "parley", "parlay", "parlee", "parly", "parlie", "parle", "parli", "parlei", "parleigh", "parlé",
        "barley", "par lay", "par ley", "par lee", "pa ley", "pah ley",
        "帕雷", "帕利", "帕里", "帕莉", "帕麗", "帕力", "帕立", "帕勒", "帕來", "帕萊",
        "趴雷", "趴利", "啪雷", "派雷", "派利", "派力", "怕累", "怕雷", "巴雷",
    )

    /**
     * Each mishearing as its rewrite, longest first so "par lay" is not cut
     * short by a shorter variant. An ASCII variant matches case-insensitively
     * and only as a whole word ("parle" stays inside "parlement"); any other is
     * a plain substring.
     */
    private val MISHEARING_RULES: List<Pair<String, Regex?>> =
        PRODUCT_NAME_MISHEARINGS
            .sortedByDescending { it.codePointCount(0, it.length) }
            .map { variant ->
                val ascii = variant.all { it.code < 0x80 }
                variant to if (ascii) {
                    Regex("(?<![A-Za-z0-9])" + Regex.escape(variant) + "(?![A-Za-z0-9])", RegexOption.IGNORE_CASE)
                } else {
                    null
                }
            }

    private val HAN_THEN_NAME = Regex("(\\p{IsHan})$PRODUCT_NAME")
    private val NAME_THEN_HAN = Regex("$PRODUCT_NAME(\\p{IsHan})")

    /**
     * The desktop's `normalizeTranscriptText` then `fixProductName`:
     * Traditional script ([toTraditional], `android.icu`'s Hans-Hant in the
     * app), the user's own replacements ([replace], [LexiconStore.apply] on the
     * phone), then every mishearing of the product's name rewritten and spaced
     * off from Chinese the way the script writes it.
     */
    fun normalize(
        raw: String,
        toTraditional: (String) -> String = { it },
        replace: (String) -> String = { it },
    ): String = fixProductName(replace(toTraditional(raw)))

    /** Rewrite every mishearing of the product's name, spaced off from Chinese. */
    fun fixProductName(text: String): String {
        var out = text
        for ((variant, regex) in MISHEARING_RULES) {
            out = regex?.replace(out, PRODUCT_NAME) ?: out.replace(variant, PRODUCT_NAME)
        }
        out = HAN_THEN_NAME.replace(out, "\$1 $PRODUCT_NAME")
        out = NAME_THEN_HAN.replace(out, "$PRODUCT_NAME \$1")
        return out
    }

    // ── the summary ──────────────────────────────────────────────────────────

    /** What the introduction gives the setup. */
    data class Summary(
        /** Lines for the speaker background. */
        val background: List<String>,
        /** Proper nouns for the dictionary. */
        val terms: List<String> = emptyList(),
        val name: String = "",
        val company: String = "",
        val role: String = "",
    ) {
        companion object {
            /**
             * The sentence itself as the one line: what a check leaves behind
             * when there is no answer from the model.
             */
            fun plain(transcript: String): Summary {
                val said = transcript.trim()
                return Summary(background = if (said.isEmpty()) emptyList() else listOf(said))
            }
        }
    }

    /** The desktop's `SYSTEM` prompt in `micCheck.ts`, word for word. */
    private const val SYSTEM_PROMPT: String =
        "The user introduced themself out loud to a meeting assistant; you get the speech-to-text " +
            "transcript, which may contain recognition errors. Return JSON:\n" +
            "- \"name\", \"company\", \"role\": as stated, or \"\" when not said.\n" +
            "- \"background\": 1 to 3 short factual lines about the user (who they are, what they use the " +
            "assistant for). No bullet characters, no line over 80 characters.\n" +
            "- \"terms\": the names said, for a speech recogniser: company names, people's names (the user's " +
            "included) and product names, each spelled as the user most likely writes it; one name per entry.\n" +
            "Never invent anything that wasn't said.\n"

    /** The system message: the prompt, the JSON-mode suffix and the output language (`shared/prompts/study.json`). */
    internal fun systemPrompt(chinese: Boolean): String {
        val language = if (chinese) StudyPrompts.OUTPUT_LANGUAGE_NAME_ZH_TW else StudyPrompts.OUTPUT_LANGUAGE_NAME_EN
        return SYSTEM_PROMPT + StudyPrompts.JSON_MODE_INSTRUCTION +
            StudyPrompts.OUTPUT_LANGUAGE_TEMPLATE.replace("{{language}}", language)
    }

    internal fun request(transcript: String, chinese: Boolean): CloudChat.Request =
        CloudChat.Request(
            model = FilingPrompt.MODEL,
            temperature = 0.2,
            maxTokens = 400,
            messages = listOf(
                CloudChat.Message(role = "system", content = systemPrompt(chinese)),
                CloudChat.Message(role = "user", content = "TRANSCRIPT:\n$transcript"),
            ),
        )

    /**
     * The whole `chat/completions` request body as JSON, same prompt as the
     * desktop. Billed as [CloudChat.Feature.MEETING]. An empty transcript has
     * nothing to ask about: the caller uses [Summary.plain] instead.
     */
    fun requestJson(transcript: String, chinese: Boolean): String =
        CloudChat.encode(request(transcript.trim(), chinese))

    private val json = Json { ignoreUnknownKeys = true }

    /**
     * The model's answer cleaned as the desktop's `summarizeIntro` cleans it —
     * background at most three lines, terms at most eight — with the plain
     * sentence as the background when the model gave none; null when there is
     * no readable object in it. Permissive: a missing field is empty rather
     * than a lost answer.
     */
    fun parse(content: String, transcript: String): Summary? {
        val text = FilingSuggester.firstJsonObject(content) ?: return null
        val obj = runCatching { json.parseToJsonElement(text) }.getOrNull() as? JsonObject ?: return null
        val background = cleanLines(obj.strings("background")).take(3)
        return Summary(
            background = background.ifEmpty { Summary.plain(transcript).background },
            terms = cleanLines(obj.strings("terms")).take(8),
            name = obj.string("name").trim(),
            company = obj.string("company").trim(),
            role = obj.string("role").trim(),
        )
    }

    private fun JsonObject.string(key: String): String =
        (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content.orEmpty()

    private fun JsonObject.strings(key: String): List<String> =
        (this[key] as? JsonArray)
            ?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
            .orEmpty()

    // ── names from the script ────────────────────────────────────────────────

    /** Characters that end a Chinese job title rather than a name (設計師, 經理…). */
    private val TITLE_ENDINGS = setOf('師', '長', '理', '員', '監', '裁', '者', '生', '工', '手')

    /** The longest text offered as a term: a name, not a sentence. */
    const val MAX_TERM_CHARS = 16

    private val ZH_SCRIPT = Regex("我是\\s*(.+?)\\s*的\\s*([^，,。.]+)")
    private val EN_SCRIPT = Regex("\\bI(?:'| a)m\\s+(.+?)\\s+at\\s+([^,.;]+)", RegexOption.IGNORE_CASE)
    private val WORD_BREAK = Regex("[\\s/／、,，]+")
    private val LATIN_NAME = Regex("^\\p{Lu}[\\p{L}'-]*$")
    private val HAN_NAME = Regex("^\\p{IsHan}{2,4}$")

    data class Script(val company: String, val name: String)

    /**
     * The company and the speaker's name from the check's own script ("我是
     * {company} 的 {name / title}…", "I'm {name / title} at {company}…"), for
     * when there is no model answer — the desktop's `parseIntroScript`. The
     * name blank keeps only what looks like a name: a capitalised Latin word,
     * or a short Chinese one that doesn't end like a title.
     */
    fun parseScript(text: String): Script {
        val zh = ZH_SCRIPT.find(text)?.groupValues
        val en = EN_SCRIPT.find(text)?.groupValues
        val company = (zh?.get(1) ?: en?.get(2) ?: "").trim()
        val who = zh?.get(2) ?: en?.get(1) ?: ""
        val name = who.split(WORD_BREAK)
            .map { it.trim() }
            .firstOrNull { word ->
                LATIN_NAME.matches(word) ||
                    (HAN_NAME.matches(word) && word.last() !in TITLE_ENDINGS)
            }
            .orEmpty()
        val fits = company.codePointCount(0, company.length) <= MAX_TERM_CHARS
        return Script(company = if (fits) company else "", name = name)
    }

    /**
     * The introduction with its company and name always among the terms: what
     * the model found, else what the script's blanks held — the desktop's
     * `completeIntro`.
     */
    fun complete(summary: Summary, transcript: String): Summary {
        val parsed = parseScript(transcript)
        val company = summary.company.ifEmpty { parsed.company }
        val name = summary.name.ifEmpty { parsed.name }
        val terms = summary.terms.toMutableList()
        for (term in listOf(company, name)) {
            if (term.isNotEmpty() && term !in terms) terms += term
        }
        return summary.copy(company = company, name = name, terms = terms)
    }

    // ── the background ───────────────────────────────────────────────────────

    /**
     * A list marker at the start of a line: a bullet, or "1." / "2)" followed
     * by a space. Digits glued to the text ("3.5 years") and a minus or
     * asterisk with no space after it ("-10%") are content, not markers.
     */
    private val LIST_MARKER = Regex("^\\s*(?:[•‧·]\\s*|[-*+]\\s+|\\d{1,2}[.)]\\s+)")

    /**
     * Lines as the background compares them: trimmed, de-bulleted, non-empty,
     * unique — the desktop's `cleanLines`.
     */
    fun cleanLines(lines: List<String>): List<String> {
        val out = ArrayList<String>()
        for (raw in lines) {
            val line = LIST_MARKER.replaceFirst(raw, "").trim()
            if (line.isNotEmpty() && line !in out) out += line
        }
        return out
    }

    private fun rawLines(background: String): List<String> =
        background.split("\n").map { it.removeSuffix("\r") }

    /** What [append] did: the new background, and the lines that went in. */
    data class Appended(val text: String, val lines: List<String>)

    /**
     * Append the lines the background doesn't already have (compared without
     * list markers), leaving what is there exactly as written.
     */
    fun append(add: List<String>, to: String): Appended {
        val have = cleanLines(rawLines(to)).toSet()
        val fresh = cleanLines(add).filter { it !in have }
        if (fresh.isEmpty()) return Appended(to, emptyList())
        val base = to.trimEnd()
        return Appended((if (base.isEmpty()) "" else base + "\n") + fresh.joinToString("\n"), fresh)
    }

    /** Take out lines added earlier (compared without list markers), leaving the rest as written. */
    fun remove(lines: List<String>, from: String): String {
        val drop = cleanLines(lines).toSet()
        if (drop.isEmpty()) return from
        return rawLines(from)
            .filter { line ->
                val clean = cleanLines(listOf(line)).firstOrNull()
                clean == null || clean !in drop
            }
            .joinToString("\n")
            .trimEnd()
    }

    /**
     * What one check put into the setup, so testing again replaces it instead
     * of piling a second introduction on top: the background lines it appended
     * and the dictionary terms it created.
     */
    data class Run(val lines: List<String>, val createdTerms: List<String>)
}
