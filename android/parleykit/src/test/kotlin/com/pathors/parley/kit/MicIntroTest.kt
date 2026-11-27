package com.pathors.parley.kit

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Onboarding's microphone check — iOS `MicIntroTests`, case for case. */
class MicIntroTest {

    private fun seg(id: String, text: String, final: Boolean = true) =
        TranscriptSegment(id = id, source = "mix", speaker = 0, text = text, isFinal = final, startMs = 0, endMs = 0)

    // ── transcript ───────────────────────────────────────────────────────────

    @Test
    fun `runs join in id order, then the tail`() {
        val t = MicIntro.Transcript()
        t.accept(seg("mix-1", "我主要用 Parley"))
        t.accept(seg("mix-0", "我是派斯科技的設計師，"))
        t.accept(seg("mix-tail", "來整理", final = false))
        assertEquals("我是派斯科技的設計師，我主要用 Parley來整理", t.text)
    }

    @Test
    fun `a settled run clears the tail so it is not said twice`() {
        val t = MicIntro.Transcript()
        t.accept(seg("mix-0", "我是"))
        t.accept(seg("mix-tail", "王小明", final = false))
        t.accept(seg("mix-0", "我是王小明"))
        assertEquals("我是王小明", t.text)
    }

    @Test
    fun `a growing run replaces itself`() {
        val t = MicIntro.Transcript()
        t.accept(seg("mix-0", "I'm"))
        t.accept(seg("mix-0", "I'm Ming"))
        t.accept(seg("mix-1", "at Pathors"))
        assertEquals("I'm Ming at Pathors", t.text)
    }

    @Test
    fun `runs join with a space only between Latin`() {
        assertEquals("Hello world", MicIntro.joinRuns(listOf("Hello", "world")))
        assertEquals("我是王小明", MicIntro.joinRuns(listOf("我是", "王小明")))
        assertEquals("Parley很好用", MicIntro.joinRuns(listOf("Parley", "很好用")))
        assertEquals("a", MicIntro.joinRuns(listOf("  ", "a", "")))
    }

    // ── normalizing ──────────────────────────────────────────────────────────

    @Test
    fun `the product name is fixed and spaced from Chinese`() {
        assertEquals("我主要用 Parley 來整理", MicIntro.fixProductName("我主要用帕雷來整理"))
        assertEquals("I use Parley daily", MicIntro.fixProductName("I use PARLAY daily"))
        assertEquals("I use Parley daily", MicIntro.fixProductName("I use par lay daily"))
        assertEquals("whole words only", "le parlement", MicIntro.fixProductName("le parlement"))
        assertEquals("already right stays right", "用 Parley 來", MicIntro.fixProductName("用 Parley 來"))
    }

    @Test
    fun `normalize converts to Traditional and applies replacements`() {
        // The app passes android.icu's Hans-Hant; this stands in for the characters the case uses.
        val simplified = mapOf('设' to '設', '计' to '計', '师' to '師', '开' to '開', '会' to '會')
        val toTraditional = { s: String -> s.map { simplified[it] ?: it }.joinToString("") }
        val out = MicIntro.normalize(
            "我是设计师，我用帕利开会",
            toTraditional = toTraditional,
            replace = { it.replace("設計師", "設計總監") },
        )
        assertEquals("我是設計總監，我用 Parley 開會", out)
    }

    // ── the script ───────────────────────────────────────────────────────────

    @Test
    fun `the script gives company and name`() {
        val zh = MicIntro.parseScript("我是派斯科技的設計師王小明，我主要用 Parley 來整理客戶會議。")
        assertEquals("派斯科技", zh.company)
        assertEquals("設計師王小明 is one word with a title in it", "", zh.name)
        assertEquals("王小明", MicIntro.parseScript("我是派斯科技的王小明，我主要用 Parley").name)
        assertEquals("a title is not a name", "", MicIntro.parseScript("我是派斯科技的設計師，我主要用 Parley").name)
        val en = MicIntro.parseScript("I'm Ming, a designer at Pathors, and I use Parley")
        assertEquals("Pathors", en.company)
        assertEquals("Ming", en.name)
    }

    @Test
    fun `company and name always become terms`() {
        val said = "我是派斯科技的王小明，我主要用 Parley"
        val plain = MicIntro.complete(MicIntro.Summary.plain(said), transcript = said)
        assertEquals(listOf("派斯科技", "王小明"), plain.terms)
        val modeled = MicIntro.complete(
            MicIntro.Summary(background = listOf("x"), terms = listOf("Parley"), name = "Ming", company = "Pathors"),
            transcript = "我是別家公司的人",
        )
        assertEquals("the model's names win over the script's", listOf("Parley", "Pathors", "Ming"), modeled.terms)
    }

    // ── the background ───────────────────────────────────────────────────────

    @Test
    fun `append keeps what is there and skips lines it has`() {
        val before = "• 我是設計師\n\n常和東森談外撥  \n"
        val out = MicIntro.append(listOf("我是設計師", "主要用 Parley 整理客戶會議"), to = before)
        assertEquals("• 我是設計師\n\n常和東森談外撥\n主要用 Parley 整理客戶會議", out.text)
        assertEquals(listOf("主要用 Parley 整理客戶會議"), out.lines)
        assertEquals("a", MicIntro.append(listOf("a"), to = "").text)
        assertEquals("nothing new, nothing changed", emptyList<String>(), MicIntro.append(listOf("- a"), to = "a").lines)
    }

    @Test
    fun `remove takes out only those lines`() {
        val bg = "• 我是設計師\n\n常和東森談外撥\n主要用 Parley 整理客戶會議"
        assertEquals("• 我是設計師\n\n常和東森談外撥", MicIntro.remove(listOf("主要用 Parley 整理客戶會議"), from = bg))
        assertEquals(bg, MicIntro.remove(emptyList(), from = bg))
    }

    @Test
    fun `a retest replaces the previous run`() {
        val first = MicIntro.append(listOf("我是派斯科技的設計師"), to = "我的筆記")
        val undone = MicIntro.remove(first.lines, from = first.text)
        val second = MicIntro.append(listOf("我是派斯科技的設計總監"), to = undone)
        assertEquals("我的筆記\n我是派斯科技的設計總監", second.text)
    }

    // ── the model ────────────────────────────────────────────────────────────

    @Test
    fun `the answer is cleaned and capped`() {
        val content = """
            Sure: {"name":" 王小明 ","company":"派斯科技","role":"設計師",
            "background":["- 派斯科技的設計師","用 Parley 整理客戶會議","用 Parley 整理客戶會議","a","b"],
            "terms":["派斯科技","王小明"]}
        """.trimIndent()
        val s = MicIntro.parse(content, transcript = "said")
        assertEquals(listOf("派斯科技的設計師", "用 Parley 整理客戶會議", "a"), s?.background)
        assertEquals(listOf("派斯科技", "王小明"), s?.terms)
        assertEquals("王小明", s?.name)
    }

    @Test
    fun `an empty or unreadable answer falls back to the sentence`() {
        assertEquals(listOf("我是小明"), MicIntro.parse("""{"background":[]}""", transcript = "我是小明")?.background)
        assertNull(MicIntro.parse("no json here", transcript = "我是小明"))
        assertEquals(emptyList<String>(), MicIntro.Summary.plain("  ").background)
    }

    @Test
    fun `the request carries the desktop prompt and language`() {
        val body = Json.parseToJsonElement(MicIntro.requestJson("我是小明", chinese = true)).jsonObject
        assertEquals(FilingPrompt.MODEL, body["model"]?.jsonPrimitive?.content)
        assertEquals("400", body["max_tokens"]?.jsonPrimitive?.content)
        val messages = body["messages"]!!.jsonArray.map { it.jsonObject }
        assertEquals("system", messages[0]["role"]?.jsonPrimitive?.content)
        val system = messages[0]["content"]!!.jsonPrimitive.content
        assertTrue(system.startsWith("The user introduced themself out loud"))
        assertTrue(system.contains("Traditional Chinese (繁體中文)"))
        assertTrue(system.contains("Use the schema's property names EXACTLY"))
        assertEquals("TRANSCRIPT:\n我是小明", messages[1]["content"]?.jsonPrimitive?.content)

        val english = MicIntro.request(transcript = "x", chinese = false)
        assertTrue(english.messages[0].content.contains("in English"))
    }

    @Test
    fun `the request body has exactly the fields the cloud expects`() {
        val body = Json.parseToJsonElement(MicIntro.requestJson("x", chinese = false)) as JsonObject
        assertEquals(setOf("model", "temperature", "max_tokens", "messages"), body.keys)
        assertEquals(2, (body["messages"] as JsonArray).size)
        assertEquals("0.2", (body["temperature"] as JsonPrimitive).content)
    }
}
