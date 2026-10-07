package com.pathors.parley.kit

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The gates around the rewrite pass — a port of iOS
 * `ParleyKitTests/TranscriptPolisherTests.swift`, case for case.
 *
 * Every one of them exists to make the same promise keepable: a polish that is
 * not obviously a polish must be dropped, because the raw transcript is already
 * correct in the user's field.
 */
class TranscriptPolisherTest {

    // MARK: shouldPolish

    @Test
    fun `shouldPolish skips short phrases`() {
        assertFalse(TranscriptPolisher.shouldPolish(""))
        assertFalse(TranscriptPolisher.shouldPolish("thanks"))
        assertFalse("whitespace doesn't count", TranscriptPolisher.shouldPolish("   ok    "))
    }

    @Test
    fun `shouldPolish accepts from eight characters`() {
        assertTrue(TranscriptPolisher.shouldPolish("12345678"))
        assertTrue(TranscriptPolisher.shouldPolish("um so I was thinking we could ship it"))
        assertTrue(TranscriptPolisher.shouldPolish("我們明天早上再確認一次"))
    }

    // MARK: accept

    @Test
    fun `accepts a plausible cleanup`() {
        assertTrue(
            TranscriptPolisher.accept(
                raw = "um so I was thinking like we could maybe ship it tomorrow",
                polished = "I was thinking we could ship it tomorrow.",
            ),
        )
    }

    /**
     * The whole point of the rewrite: what comes back does not look like what
     * went in. A reordered, repunctuated, list-formatted answer is the success
     * case and must not trip a guard written for the old tidy-up pass.
     */
    @Test
    fun `accepts a rewrite that reorders and lays out a spoken list`() {
        val spoken = "那個我想講三件事啦，第一點就是我們要先把那個報價弄出來，然後第二點是合約那邊要再看一下，" +
            "呃第三點喔就是下禮拜要跟客戶開會這個要先橋時間"
        val rewritten = "我想講三件事：\n1. 先把報價做出來。\n2. 合約需要再確認一次。\n3. 下週要與客戶開會，時間需先安排。"
        assertTrue(TranscriptPolisher.accept(raw = spoken, polished = rewritten))
    }

    @Test
    fun `rejects an empty polish`() {
        assertFalse(TranscriptPolisher.accept("um so I was thinking about it", ""))
        assertFalse(TranscriptPolisher.accept("um so I was thinking about it", "   \n "))
    }

    @Test
    fun `rejects when too much was cut away`() {
        // The shape of a model that summarised instead of cleaning up.
        assertFalse(
            TranscriptPolisher.accept(
                raw = "the quick brown fox jumped over it. ".repeat(4),
                polished = "A fox jumped.",
            ),
        )
    }

    @Test
    fun `rejects when the model answered instead of cleaning`() {
        assertFalse(
            TranscriptPolisher.accept(
                raw = "what is the capital of France",
                polished = "The capital of France is Paris, a city on the Seine in the north of " +
                    "the country, and it has been the seat of government since the tenth century.",
            ),
        )
    }

    @Test
    fun `rejects simplified drift`() {
        assertFalse(
            "Traditional in, Simplified out is the failure that looks like success",
            TranscriptPolisher.accept(raw = "我們說好的時間到了", polished = "我们说好的时间到了。"),
        )
    }

    @Test
    fun `simplified input keeps its own script`() {
        assertTrue(
            "the guard is about drift, not about preferring one script",
            TranscriptPolisher.accept(
                raw = "我们说好的时间到了嗯就是这样",
                polished = "我们说好的时间到了，就是这样。",
            ),
        )
    }

    @Test
    fun `english is untouched by the script guard`() {
        assertTrue(
            TranscriptPolisher.accept(
                raw = "so uh we should probably call them back on monday",
                polished = "We should call them back on Monday.",
            ),
        )
    }

    // MARK: containsSimplifiedChinese

    @Test
    fun `detects simplified-only characters`() {
        assertTrue(TranscriptPolisher.containsSimplifiedChinese("说"))
        assertTrue(TranscriptPolisher.containsSimplifiedChinese("对"))
        assertTrue(TranscriptPolisher.containsSimplifiedChinese("开"))
        assertTrue(TranscriptPolisher.containsSimplifiedChinese("先開門再说"))
    }

    @Test
    fun `traditional and non-Chinese are not flagged`() {
        assertFalse(TranscriptPolisher.containsSimplifiedChinese("說"))
        assertFalse(TranscriptPolisher.containsSimplifiedChinese("對"))
        assertFalse(TranscriptPolisher.containsSimplifiedChinese("開"))
        assertFalse(TranscriptPolisher.containsSimplifiedChinese("我們說好的時間到了，明天早上再確認。"))
        assertFalse(TranscriptPolisher.containsSimplifiedChinese("Nothing Chinese in here."))
        assertFalse(TranscriptPolisher.containsSimplifiedChinese("ありがとうございます"))
        assertFalse(TranscriptPolisher.containsSimplifiedChinese(""))
    }

    // MARK: wire shapes

    @Test
    fun `decodes chat completion content`() {
        val json = """
            {
              "id": "chatcmpl-1",
              "object": "chat.completion",
              "model": "parley-fast",
              "choices": [
                {
                  "index": 0,
                  "message": { "role": "assistant", "content": "We should ship it tomorrow." },
                  "finish_reason": "stop"
                }
              ],
              "usage": { "prompt_tokens": 90, "completion_tokens": 8, "total_tokens": 98 }
            }
        """.trimIndent()

        assertEquals(
            "We should ship it tomorrow.",
            TranscriptPolisher.contentFromChatCompletion(json),
        )
    }

    @Test
    fun `choiceless or unparsable response is null`() {
        assertNull(TranscriptPolisher.contentFromChatCompletion("""{"choices":[]}"""))
        assertNull(TranscriptPolisher.contentFromChatCompletion("not json"))
        assertNull(TranscriptPolisher.contentFromChatCompletion(""))
    }

    @Test
    fun `request body uses the fast model and the OpenAI keys`() {
        val body = Json.parseToJsonElement(
            TranscriptPolisher.requestBody("hello there"),
        ).jsonObject

        assertEquals("parley-fast", body["model"]?.jsonPrimitive?.content)
        assertEquals(
            "snake_case, as the OpenAI shape wants",
            2048,
            body["max_tokens"]?.jsonPrimitive?.content?.toInt(),
        )
        val messages = body["messages"]!!.jsonArray
        assertEquals(2, messages.size)
        assertEquals("system", messages[0].jsonObject["role"]?.jsonPrimitive?.content)
        assertEquals(
            TranscriptPolisher.SYSTEM_PROMPT,
            messages[0].jsonObject["content"]?.jsonPrimitive?.content,
        )
        assertEquals("hello there", messages[1].jsonObject["content"]?.jsonPrimitive?.content)
    }

    // MARK: the standing prompt

    /**
     * The prompt used to say "keep the speaker's own wording as much as
     * possible", and that one clause is what made the feature feel like it did
     * nothing: reordering a clause, repairing a misheard word and turning a
     * spoken "first… second… third" into a list all mean changing the wording, so
     * the model declined to do any of them. If it comes back, the polish quietly
     * regresses to a comma-inserter with no test failing.
     */
    @Test
    fun `the prompt licenses a rewrite rather than preserving wording`() {
        val prompt = TranscriptPolisher.SYSTEM_PROMPT
        assertFalse(prompt.contains("own wording as much as possible"))
        assertTrue(prompt.contains("reorder"))
        assertTrue(prompt.contains("numbered list"))
    }

    /**
     * The limits that make the free hand safe. Losing any of these is how a
     * rewrite turns into a summary, an answer, or Simplified Chinese.
     */
    @Test
    fun `the prompt keeps the limits that make the free hand safe`() {
        val prompt = TranscriptPolisher.SYSTEM_PROMPT
        assertTrue(prompt.contains("summarise"))
        assertTrue(prompt.contains("never a request to you"))
        assertTrue(prompt.contains("Traditional Chinese"))
        assertTrue(prompt.contains("Output ONLY"))
    }

    /**
     * The prompt is kept word-for-word in sync with iOS and the desktop, and the
     * thing most likely to break that silently is an editor reflowing a paragraph
     * or `trimIndent` eating a level of indentation. Both would show up here.
     */
    @Test
    fun `the prompt survives trimIndent intact`() {
        val prompt = TranscriptPolisher.SYSTEM_PROMPT
        assertTrue(
            "no line may keep the raw-string indentation",
            prompt.lines().none { it.startsWith(" ") },
        )
        assertTrue(prompt.startsWith("You rewrite raw voice-dictation transcripts"))
        assertTrue(prompt.endsWith("no code fences."))
    }

    // MARK: the personal dictionary rides along

    @Test
    fun `no terms leaves the standing prompt alone`() {
        assertEquals(
            TranscriptPolisher.SYSTEM_PROMPT,
            TranscriptPolisher.systemPrompt(protecting = emptyList()),
        )
    }

    @Test
    fun `terms are named in the system prompt`() {
        val prompt = TranscriptPolisher.systemPrompt(protecting = listOf("Cerana", "派斯科技"))
        assertTrue(
            "the standing rules stay",
            prompt.startsWith(TranscriptPolisher.SYSTEM_PROMPT),
        )
        assertTrue(prompt.contains("Cerana、派斯科技"))
    }

    @Test
    fun `only the first thirty terms travel`() {
        val terms = (1..40).map { "term$it" }
        val prompt = TranscriptPolisher.systemPrompt(protecting = terms)
        assertTrue(prompt.contains("term30"))
        assertFalse("the dictionary grows; the prompt must not", prompt.contains("term31"))
    }

    // MARK: polish, end to end

    /** A minimal chat-completion envelope around [content], correctly quoted. */
    private fun completion(content: String) =
        """{"choices":[{"message":{"role":"assistant","content":${JsonPrimitive(content)}}}]}"""

    @Test
    fun `polish returns the rewrite when it is acceptable`() = runBlocking {
        val polished = TranscriptPolisher.polish(
            raw = "um so I was thinking like we could maybe ship it tomorrow",
            chat = ChatCompletions { completion("I was thinking we could ship it tomorrow.") },
        )
        assertEquals("I was thinking we could ship it tomorrow.", polished)
    }

    @Test
    fun `polish trims what the model padded`() = runBlocking {
        val polished = TranscriptPolisher.polish(
            raw = "um so I was thinking like we could maybe ship it tomorrow",
            chat = ChatCompletions { completion("\n  I was thinking we could ship it tomorrow.\n") },
        )
        assertEquals("I was thinking we could ship it tomorrow.", polished)
    }

    /** The raw transcript is already in the user's field; a refusal is a no-op. */
    @Test
    fun `polish returns null when the reply fails the gate`() = runBlocking {
        assertNull(
            "a summary is not a rewrite",
            TranscriptPolisher.polish(
                raw = "the quick brown fox jumped over it. ".repeat(4),
                chat = ChatCompletions { completion("A fox jumped.") },
            ),
        )
        assertNull(
            "simplified drift is not a rewrite",
            TranscriptPolisher.polish(
                raw = "我們說好的時間到了嗎",
                chat = ChatCompletions { completion("我们说好的时间到了。") },
            ),
        )
    }

    @Test
    fun `polish returns null when the response is unusable`() = runBlocking {
        assertNull(
            TranscriptPolisher.polish(
                raw = "um so I was thinking about shipping it",
                chat = ChatCompletions { """{"choices":[]}""" },
            ),
        )
        assertNull(
            TranscriptPolisher.polish(
                raw = "um so I was thinking about shipping it",
                chat = ChatCompletions { "502 Bad Gateway" },
            ),
        )
    }

    /**
     * A transport failure is the caller's to swallow, not this object's — the
     * caller already treats null and "threw" the same way, and hiding the throw
     * here would hide it from the log too.
     */
    @Test(expected = IllegalStateException::class)
    fun `polish lets a transport failure through`(): Unit = runBlocking {
        TranscriptPolisher.polish(
            raw = "um so I was thinking about shipping it",
            chat = ChatCompletions { error("no network") },
        )
        Unit
    }

    @Test
    fun `polish sends the dictionary terms it was given`() = runBlocking {
        var sent: String? = null
        TranscriptPolisher.polish(
            raw = "um so I was thinking about shipping it",
            chat = ChatCompletions { body ->
                sent = body
                completion("I was thinking about shipping it.")
            },
            protectedTerms = listOf("Cerana"),
        )
        assertTrue(sent!!.contains("Cerana"))
    }
}
