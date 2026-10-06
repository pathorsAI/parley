package com.pathors.parley.kit

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The rules that stand between a model's answer and the user's library. The
 * recording already has a name and a home, so every gate here is free to be
 * strict: a dropped suggestion costs nothing, and a bad one accepted costs a
 * renamed recording in the wrong folder.
 *
 * Ported from `ios/ParleyKit/Tests/ParleyKitTests/FilingSuggesterTests.swift`
 * case for case, plus the end-to-end call against a fake transport.
 */
class FilingSuggesterTest {

    private val folders = listOf(
        FilingFolder(ACME_ID, ACME),
        FilingFolder(HIRING_ID, HIRING),
        FilingFolder(BOARD_ID, BOARD),
        FilingFolder(OPS_ID, OPS),
    )

    private fun pick(name: String, isNew: Boolean = false, reason: String = FITS) =
        FilingSuggester.RawFolder(name, isNew, reason)

    private fun suggestion(id: String?, name: String, reason: String = FITS) =
        FilingFolderSuggestion(id, name, reason)

    private fun resolve(vararg raw: FilingSuggester.RawFolder, registry: List<FilingFolder> = folders) =
        FilingSuggester.resolveFolders(raw.toList(), registry)

    // ── resolveFolders ───────────────────────────────────────────────────────

    @Test
    fun `matches an existing folder by exact name`() {
        assertEquals(listOf(suggestion(ACME_ID, ACME)), resolve(pick(ACME)))
    }

    @Test
    fun `matches case and whitespace insensitively keeping the registry spelling`() {
        assertEquals(listOf(suggestion(ACME_ID, ACME)), resolve(pick("  acme CORP ")))
    }

    @Test
    fun `treats a name matching nothing as a new folder`() {
        assertEquals(listOf(suggestion(null, GLOBEX)), resolve(pick(GLOBEX)))
    }

    @Test
    fun `resolves to the existing folder even when the model claims it is new`() {
        assertEquals(listOf(suggestion(HIRING_ID, HIRING)), resolve(pick(HIRING, isNew = true)))
    }

    @Test
    fun `keeps only the first new folder suggestion`() {
        assertEquals(
            listOf(suggestion(null, GLOBEX), suggestion(ACME_ID, ACME)),
            resolve(pick(GLOBEX, true), pick("Initech", true), pick(ACME)),
        )
    }

    @Test
    fun `collapses duplicate folder ids to one entry`() {
        assertEquals(
            listOf(suggestion(ACME_ID, ACME, CUSTOMER), suggestion(OPS_ID, OPS)),
            resolve(pick(ACME, false, CUSTOMER), pick("acme corp", true, "same again"), pick(OPS)),
        )
    }

    @Test
    fun `caps at three entries preserving the model's order`() {
        val out = resolve(pick(ACME), pick(HIRING), pick(BOARD), pick(OPS))
        assertEquals(listOf(ACME_ID, HIRING_ID, BOARD_ID), out.map { it.folderId })
    }

    @Test
    fun `drops empty and whitespace-only names`() {
        assertEquals(listOf(suggestion(BOARD_ID, BOARD)), resolve(pick(""), pick("   "), pick(BOARD)))
    }

    @Test
    fun `trims the reason and allows an empty one`() {
        assertEquals(
            listOf(suggestion(BOARD_ID, BOARD, "ongoing governance")),
            resolve(pick(BOARD, false, "  ongoing governance  ")),
        )
        assertEquals(listOf(suggestion(BOARD_ID, BOARD, "")), resolve(pick(BOARD, false, "   ")))
    }

    @Test
    fun `returns an empty list for empty input`() {
        assertEquals(emptyList<FilingFolderSuggestion>(), resolve())
        assertEquals(emptyList<FilingFolderSuggestion>(), resolve(registry = emptyList()))
    }

    /**
     * An org's shared folders belong to a workspace, not to the personal library
     * this pass files into. The name is not "taken" by the org folder either: it
     * falls through to the new-folder path like any other unknown name.
     */
    @Test
    fun `org folders are never offered as filing targets`() {
        val mixed = folders + FilingFolder("f-shared", SALES, orgId = ORG_ID)
        assertEquals(listOf(suggestion(null, SALES)), resolve(pick(SALES), registry = mixed))
    }

    @Test
    fun `first occurrence wins when two folders share a name`() {
        val dupes = listOf(FilingFolder("f-old", ACME), FilingFolder("f-new", "acme corp"))
        assertEquals(listOf(suggestion("f-old", ACME)), resolve(pick("ACME CORP"), registry = dupes))
    }

    // ── the folder menu ──────────────────────────────────────────────────────

    @Test
    fun `the menu lists personal folders only`() {
        val menu = FilingSuggester.folderMenu(folders + FilingFolder("f-s", SALES, orgId = ORG_ID))
        assertTrue(menu.contains("- $ACME"))
        assertFalse(menu.contains(SALES))
    }

    @Test
    fun `an empty registry asks for exactly one new folder`() {
        val menu = FilingSuggester.folderMenu(emptyList())
        assertTrue(menu.contains("NO folders yet"))
        assertTrue(menu.contains("isNew: true"))
    }

    // ── parsing what came back ───────────────────────────────────────────────

    @Test
    fun `parses a plain JSON object`() {
        val parsed = FilingSuggester.parse(
            """{"title":"Acme renewal terms","folders":[{"name":"Acme Corp","isNew":false,"reason":"the customer"}]}""",
        )
        assertEquals(RENEWAL, parsed?.title)
        assertEquals(1, parsed?.folders?.size)
        assertEquals(ACME, parsed?.folders?.first()?.name)
    }

    @Test
    fun `parses JSON inside code fences`() {
        val parsed = FilingSuggester.parse(
            """
            ```json
            {"title": "Board Q3 budget", "folders": [{"name": "Board", "isNew": false, "reason": "governance"}]}
            ```
            """.trimIndent(),
        )
        assertEquals("Board Q3 budget", parsed?.title)
        assertEquals("governance", parsed?.folders?.first()?.reason)
    }

    @Test
    fun `parses JSON after a preamble`() {
        val parsed = FilingSuggester.parse(
            "Sure! Here is the suggestion:\n{\"title\":\"Hiring loop debrief\",\"folders\":[]}",
        )
        assertEquals("Hiring loop debrief", parsed?.title)
        assertEquals(0, parsed?.folders?.size)
    }

    /** A brace inside a `reason` must not end the object early. */
    @Test
    fun `a brace inside a string does not end the object`() {
        val parsed = FilingSuggester.parse(
            """{"title":"Ops handover","folders":[{"name":"Ops","isNew":false,"reason":"the {ops} rota \"q\""}]}""",
        )
        assertEquals("the {ops} rota \"q\"", parsed?.folders?.first()?.reason)
    }

    @Test
    fun `malformed answers parse to null`() {
        assertNull(FilingSuggester.parse("I'm sorry, I can't help with that."))
        assertNull(FilingSuggester.parse(""))
        assertNull(
            "an unbalanced object is a truncated answer, not a suggestion",
            FilingSuggester.parse("{\"title\": \"truncated mid-answer\", \"folders\": ["),
        )
    }

    /** A row missing `isNew` or `reason` still names a folder. */
    @Test
    fun `missing fields fall back rather than failing the parse`() {
        val parsed = FilingSuggester.parse("""{"folders":[{"name":"Board"}]}""")
        assertEquals("", parsed?.title)
        assertEquals(BOARD, parsed?.folders?.first()?.name)
        assertEquals(false, parsed?.folders?.first()?.isNew)
        assertEquals("", parsed?.folders?.first()?.reason)
    }

    // ── the title gate ───────────────────────────────────────────────────────

    @Test
    fun `accepts a plausible title`() {
        assertTrue(
            FilingSuggester.acceptTitle(
                RENEWAL,
                currentTitle = CLOCK_TITLE,
                transcript = "[0:00] [Speaker 1] Let's start with the renewal.",
            ),
        )
    }

    @Test
    fun `rejects an empty title`() {
        assertFalse(FilingSuggester.acceptTitle("", currentTitle = "x", transcript = "y"))
        assertFalse(FilingSuggester.acceptTitle("  \n ", currentTitle = "x", transcript = "y"))
    }

    /** The shape of a model that answered with the meeting's summary. */
    @Test
    fun `rejects a title longer than eighty characters`() {
        assertFalse(FilingSuggester.acceptTitle("a".repeat(81), currentTitle = "x", transcript = "y"))
        assertTrue(
            "the cap is loose enough to let a long but honest title through",
            FilingSuggester.acceptTitle("a".repeat(80), currentTitle = "x", transcript = "y"),
        )
    }

    /** Proposing the name it already has is proposing nothing. */
    @Test
    fun `rejects the current title`() {
        assertFalse(FilingSuggester.acceptTitle(RENEWAL, currentTitle = "  $RENEWAL ", transcript = "y"))
    }

    @Test
    fun `rejects simplified drift`() {
        assertFalse(
            "Traditional in, Simplified out is the failure that looks like success",
            FilingSuggester.acceptTitle(
                SIMPLIFIED_TITLE,
                currentTitle = TRADITIONAL_TITLE,
                transcript = "[0:00] [Speaker 1] 我們來討論報價的部分。",
            ),
        )
    }

    /** Per character: one Simplified character the conversation used does not license another. */
    @Test
    fun `simplified drift is judged character by character`() {
        val transcript = "[0:00] [Speaker 1] 我們來看報價。"
        assertFalse(FilingSuggester.acceptTitle("報價说明", currentTitle = "即時會議", transcript = transcript))
        assertTrue(
            "说 is fine once the conversation itself said it",
            FilingSuggester.acceptTitle("報價说明", currentTitle = "即時會議", transcript = "[0:00] [Speaker 1] 我说報價。"),
        )
        assertTrue(
            "or the current title already had it",
            FilingSuggester.acceptTitle("報價说明", currentTitle = "说明會", transcript = transcript),
        )
        assertFalse(
            "a different Simplified character in the transcript does not excuse 说",
            FilingSuggester.acceptTitle("報價说明", currentTitle = "即時會議", transcript = "[0:00] [Speaker 1] 时间到了。"),
        )
        assertTrue("台 and 后 are written that way in Traditional too", FilingSuggester.acceptTitle("台北會後檢討", "即時會議", transcript))
    }

    @Test
    fun `a simplified meeting keeps its own script`() {
        assertTrue(
            "the guard is about drift, not about preferring one script",
            FilingSuggester.acceptTitle(SIMPLIFIED_TITLE, currentTitle = "即时会议", transcript = SIMPLIFIED_LINE),
        )
        assertTrue(
            "the transcript alone is enough to establish the script",
            FilingSuggester.acceptTitle(SIMPLIFIED_TITLE, currentTitle = TRADITIONAL_TITLE, transcript = SIMPLIFIED_LINE),
        )
    }

    // ── the transcript we send ───────────────────────────────────────────────

    private fun segment(
        id: String,
        text: String,
        speaker: Int = 1,
        startMs: Long = 0,
        isFinal: Boolean = true,
    ) = TranscriptSegment(id, "mix", speaker, text, isFinal, startMs, startMs + 1000)

    /** Named speakers win; unnamed ones get whatever label the caller renders. */
    private val label: (TranscriptSegment) -> String = { if (it.speaker == 2) "Mei" else "Speaker ${it.speaker}" }

    @Test
    fun `renders final segments oldest first with clock and speaker`() {
        val rendered = FilingSuggester.transcript(
            listOf(
                segment("b", "Second thing.", speaker = 2, startMs = 72_000),
                segment("a", "  First thing.  ", speaker = 1, startMs = 5_000),
                segment("t", "tentative tail", startMs = 90_000, isFinal = false),
                segment("blank", "   ", startMs = 95_000),
            ),
            label,
        )
        assertEquals("[0:05] [Speaker 1] First thing.\n[1:12] [Mei] Second thing.", rendered)
    }

    @Test
    fun `an empty transcript renders as nothing`() {
        assertEquals("", FilingSuggester.transcript(emptyList(), label))
        assertEquals("", FilingSuggester.transcript(listOf(segment("t", "tail", isFinal = false)), label))
    }

    /**
     * A long meeting is sent as its two ends; the middle must be visibly gone
     * rather than look like the meeting stopped mid-sentence.
     */
    @Test
    fun `a long transcript keeps its head and tail`() {
        val long = "x".repeat(20_000) + "MIDDLE" + "y".repeat(20_000) + "THE DECISION"
        val capped = FilingSuggester.capped(long)

        assertTrue(
            capped.length <= FilingPrompt.MAX_TRANSCRIPT_CHARACTERS + FilingPrompt.ELISION_MARKER.length,
        )
        assertTrue(capped.startsWith("xxx"))
        assertTrue(capped.endsWith("THE DECISION"))
        assertTrue(capped.contains(FilingPrompt.ELISION_MARKER))
        assertFalse(capped.contains("MIDDLE"))
    }

    /** A cut never lands inside a surrogate pair. */
    @Test
    fun `a long transcript is cut on code point boundaries`() {
        val capped = FilingSuggester.capped("😀".repeat(FilingPrompt.MAX_TRANSCRIPT_CHARACTERS + 10))
        val body = capped.replace(FilingPrompt.ELISION_MARKER, "")
        assertTrue(body.all { it == '\uD83D' || it == '\uDE00' })
        assertEquals(0, body.length % 2)
    }

    /** The split is the shared one: two thirds head, the rest tail, around the marker. */
    @Test
    fun `a long transcript is split by the shared head share`() {
        val max = FilingPrompt.MAX_TRANSCRIPT_CHARACTERS
        val capped = FilingSuggester.capped("h".repeat(max) + "t".repeat(max))
        val head = max * FilingPrompt.HEAD_SHARE_NUMERATOR / FilingPrompt.HEAD_SHARE_DENOMINATOR
        assertEquals("h".repeat(head) + FilingPrompt.ELISION_MARKER + "t".repeat(max - head), capped)
        assertEquals("a transcript exactly at the cap is sent whole", "x".repeat(max), FilingSuggester.capped("x".repeat(max)))
    }

    @Test
    fun `a short transcript is sent whole`() {
        val short = "[0:00] [Speaker 1] Short and complete."
        assertEquals(short, FilingSuggester.capped(short))
    }

    // ── the prompt and the request ───────────────────────────────────────────

    /**
     * The desktop and the phones file the same person's recordings into the same
     * registry, so the rules travel verbatim.
     */
    @Test
    fun `the prompt carries the desktop's filing rules`() {
        val prompt = FilingSuggester.systemPrompt(FilingLanguage.EN)
        assertTrue(prompt.startsWith("Given a finished meeting transcript, decide what the recording"))
        assertTrue(prompt.contains("No date and no time."))
        assertTrue(prompt.contains("Copy an existing folder's name EXACTLY"))
        assertTrue(prompt.contains("AT MOST ONE candidate"))
        assertTrue(prompt.contains("2-3 candidates ordered best-first"))
        assertTrue(prompt.contains("it is shown as a tooltip, not read as prose.\n\nWrite the title and every reason in English"))
        assertTrue(prompt.endsWith(FilingPrompt.JSON_INSTRUCTION))
    }

    /** The title follows the app's language, not the language spoken. */
    @Test
    fun `the system prompt is rules, then the language, then the JSON shape`() {
        assertEquals(
            FilingPrompt.RULES + FilingPrompt.LANGUAGE_INSTRUCTION_ZH_TW + FilingPrompt.JSON_INSTRUCTION,
            FilingSuggester.systemPrompt(FilingLanguage.ZH_TW),
        )
        assertEquals(
            FilingPrompt.RULES + FilingPrompt.LANGUAGE_INSTRUCTION_EN + FilingPrompt.JSON_INSTRUCTION,
            FilingSuggester.systemPrompt(FilingLanguage.EN),
        )
    }

    @Test
    fun `the UI language tag picks the title language`() {
        listOf("zh-TW", "zh-Hant", "zh-Hant-TW", "zh-HK", "zh_TW", "zh-MO").forEach {
            assertEquals(it, FilingLanguage.ZH_TW, FilingLanguage.forTag(it))
        }
        listOf("en", "en-US", "zh-CN", "zh-Hans", "zh-Hans-TW", "zh", "ja-JP", "").forEach {
            assertEquals(it, FilingLanguage.EN, FilingLanguage.forTag(it))
        }
    }

    @Test
    fun `the prompt asks for JSON in words`() {
        val prompt = FilingSuggester.systemPrompt(FilingLanguage.EN)
        assertTrue(prompt.contains("\"isNew\": boolean"))
        assertTrue(prompt.contains("no code fences"))
    }

    @Test
    fun `the user message names the current title, the menu and the transcript`() {
        val message = FilingSuggester.userMessage("  $CLOCK_TITLE  ", folders, HELLO_LINE)
        assertTrue(message.contains("currently called: $CLOCK_TITLE"))
        assertTrue(message.contains("- $HIRING"))
        assertTrue(message.endsWith("Transcript:\n$HELLO_LINE"))
    }

    /** The exact message every client sends, byte for byte. */
    @Test
    fun `the user message is context, title, folders, transcript in that order`() {
        val message = FilingSuggester.userMessage(
            "  $CLOCK_TITLE  ",
            listOf(FilingFolder(ACME_ID, " $ACME "), FilingFolder("blank", "  "), FilingFolder("s", SALES, orgId = ORG_ID)),
            HELLO_LINE,
            meetingContext = "  Renewal with Acme  ",
        )
        assertEquals(
            "Meeting context: Renewal with Acme\n\n" +
                "The recording is currently called: $CLOCK_TITLE\n\n" +
                "The user's existing folders:\n- $ACME\n\n" +
                "Transcript:\n$HELLO_LINE",
            message,
        )
    }

    @Test
    fun `no meeting context sends no context line`() {
        val message = FilingSuggester.userMessage(CLOCK_TITLE, folders, HELLO_LINE, meetingContext = "   ")
        assertTrue(message.startsWith(FilingPrompt.CURRENT_TITLE_PREFIX + CLOCK_TITLE + "\n\n"))
        assertFalse(message.contains(FilingPrompt.MEETING_CONTEXT_PREFIX))
    }

    @Test
    fun `no folders asks for exactly one new one`() {
        assertEquals(
            FilingPrompt.CURRENT_TITLE_PREFIX + FilingPrompt.UNTITLED + "\n\n" +
                FilingPrompt.NO_FOLDERS + "\n\n" +
                FilingPrompt.TRANSCRIPT_HEADER + "\n" + HELLO_LINE,
            FilingSuggester.userMessage("", listOf(FilingFolder("s", SALES, orgId = ORG_ID)), HELLO_LINE),
        )
    }

    /** An untitled recording must not send an empty line the model reads as "blank on purpose". */
    @Test
    fun `a blank current title is spelled out`() {
        assertTrue(
            FilingSuggester.userMessage("   ", emptyList(), "x").contains("currently called: (untitled)"),
        )
    }

    @Test
    fun `the request uses the fast model and no response format`() {
        val body = CloudChat.encode(FilingSuggester.request(CLOCK_TITLE, folders, HELLO_LINE, FilingLanguage.EN))
        val obj = Json.parseToJsonElement(body) as JsonObject
        assertEquals("parley-fast", obj["model"]?.jsonPrimitive?.content)
        assertEquals("snake_case, as the OpenAI shape wants", 512, obj["max_tokens"]?.jsonPrimitive?.int)
        assertNull("unverified against the worker; a rejected request costs the whole pass", obj["response_format"])
        assertEquals(FilingPrompt.TEMPERATURE, obj["temperature"]?.jsonPrimitive?.content?.toDouble())
    }

    @Test
    fun `the request carries the language and the meeting context`() {
        val request = FilingSuggester.request(CLOCK_TITLE, folders, HELLO_LINE, FilingLanguage.ZH_TW, "Acme renewal")
        assertEquals(FilingSuggester.systemPrompt(FilingLanguage.ZH_TW), request.messages[0].content)
        assertTrue(request.messages[1].content.startsWith("Meeting context: Acme renewal\n\n"))
    }

    // ── the whole pass against a fake transport ──────────────────────────────

    private class FakeChat(private val reply: String) : ChatCompletions {
        var sent: String? = null

        override suspend fun chatCompletion(requestJson: String): String {
            sent = requestJson
            return reply
        }
    }

    private fun chatReply(content: String): String =
        """{"choices":[{"message":{"role":"assistant","content":${Json.encodeToString(String.serializer(), content)}}}]}"""

    private fun suggestWith(chat: ChatCompletions, segments: List<TranscriptSegment> = listOf(segment("a", "Hello."))) =
        runBlocking { FilingSuggester.suggest(segments, label, CLOCK_TITLE, folders, chat, FilingLanguage.EN) }

    @Test
    fun `suggest returns the gated title and resolved folders`() {
        val chat = FakeChat(
            chatReply("""{"title":" Acme renewal terms ","folders":[{"name":"acme corp","isNew":true,"reason":"$CUSTOMER"}]}"""),
        )
        assertEquals(
            FilingSuggestion(RENEWAL, listOf(suggestion(ACME_ID, ACME, CUSTOMER))),
            suggestWith(chat),
        )
        assertTrue(chat.sent.orEmpty().contains("[0:00] [Speaker 1] Hello."))
    }

    @Test
    fun `a rejected title does not sink the folders`() {
        val chat = FakeChat(chatReply("""{"title":"${"a".repeat(200)}","folders":[{"name":"Board"}]}"""))
        assertEquals(FilingSuggestion("", listOf(suggestion(BOARD_ID, BOARD, ""))), suggestWith(chat))
    }

    @Test
    fun `an unchanged title comes back empty and the folders still stand`() {
        val chat = FakeChat(chatReply("""{"title":"$CLOCK_TITLE","folders":[{"name":"Board"}]}"""))
        assertEquals(FilingSuggestion("", listOf(suggestion(BOARD_ID, BOARD, ""))), suggestWith(chat))
    }

    @Test
    fun `nothing surviving the gates is no suggestion`() {
        assertNull(suggestWith(FakeChat(chatReply("""{"title":"","folders":[]}"""))))
        assertNull(suggestWith(FakeChat(chatReply("no json here"))))
        assertNull(suggestWith(FakeChat("""{"choices":[]}""")))
        assertNull(suggestWith(FakeChat("<html>bad gateway</html>")))
    }

    @Test
    fun `no final transcript never reaches the network`() {
        val chat = FakeChat(chatReply("""{"title":"Anything","folders":[]}"""))
        assertNull(suggestWith(chat, segments = listOf(segment("t", "tail", isFinal = false))))
        assertNull(chat.sent)
    }

    private companion object {
        const val FITS = "fits"
        const val CUSTOMER = "customer"
        const val ACME = "Acme Corp"
        const val ACME_ID = "f-acme"
        const val HIRING = "Hiring"
        const val HIRING_ID = "f-hiring"
        const val BOARD = "Board"
        const val BOARD_ID = "f-board"
        const val OPS = "Ops"
        const val OPS_ID = "f-ops"
        const val GLOBEX = "Globex"
        const val SALES = "Sales"
        const val ORG_ID = "org-1"
        const val RENEWAL = "Acme renewal terms"
        const val CLOCK_TITLE = "Meeting Sep 7, 3:20 PM"
        const val HELLO_LINE = "[0:00] [Speaker 1] Hello."
        const val SIMPLIFIED_TITLE = "报价讨论"
        const val TRADITIONAL_TITLE = "即時會議"
        const val SIMPLIFIED_LINE = "[0:00] [Speaker 1] 我们来讨论报价的部分。"
    }
}
