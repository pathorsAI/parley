package com.pathors.parley.kit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The hand-off prompt, line for line against what iOS `HandoffPrompt.build`
 * produces from the same inputs. The copy below is the iOS catalogue's
 * (`ios/App/Parley/Localizable.xcstrings`) in Android's placeholder spelling; the
 * app's own test checks that `strings.xml` still says exactly this.
 */
class HandoffPromptTest {

    private val english = HandoffPrompt.Strings(
        preamble = "You are my meeting analyst. Below is the full transcript of a meeting. " +
            "Read all of it first, then answer:",
        closing = "Quote the transcript's own words and give the timestamp when you answer.",
        meeting = "Meeting: %1\$s (%2\$s)",
        context = "Context: %1\$s",
        contextMissing = "not provided",
        speakers = "Speakers: %1\$s",
        transcriptHeader = "--- Transcript ---",
        line = "%1\$s: %2\$s",
    )

    private val chinese = HandoffPrompt.Strings(
        preamble = "你是我的會議分析助理。以下是一場會議的完整逐字稿，請先讀完，再回答：",
        closing = "回答時引用逐字稿原句並標時間。",
        meeting = "會議：%1\$s（%2\$s）",
        context = "背景：%1\$s",
        contextMissing = "未填",
        speakers = "說話者：%1\$s",
        transcriptHeader = "--- 逐字稿 ---",
        line = "%1\$s：%2\$s",
    )

    private val genericEnglish = listOf(
        "What was this meeting about and what was concluded? Five sentences or fewer.",
        "What did each side commit to? Include owner and timing.",
        "What did I fail to ask, or should follow up on next time?",
    )

    @Test
    fun `english matches the iOS shape`() {
        val prompt = HandoffPrompt.build(
            english,
            HandoffPrompt.Meeting(
                title = "Renewal terms",
                date = "Sep 27, 2026 at 10:19 AM",
                context = "  Second call with procurement.  ",
                speakers = "You and Mr. Lin",
                turns = listOf(
                    HandoffPrompt.Turn("You", 300L, "Good afternoon."),
                    HandoffPrompt.Turn("Mr. Lin", 65_400L, "Afternoon."),
                ),
                questions = genericEnglish,
            ),
        )

        assertEquals(
            """
            You are my meeting analyst. Below is the full transcript of a meeting. Read all of it first, then answer:
            1. What was this meeting about and what was concluded? Five sentences or fewer.
            2. What did each side commit to? Include owner and timing.
            3. What did I fail to ask, or should follow up on next time?
            Quote the transcript's own words and give the timestamp when you answer.

            Meeting: Renewal terms (Sep 27, 2026 at 10:19 AM)
            Context: Second call with procurement.
            Speakers: You and Mr. Lin

            --- Transcript ---
            [0:00] You: Good afternoon.
            [1:05] Mr. Lin: Afternoon.
            """.trimIndent(),
            prompt,
        )
    }

    @Test
    fun `chinese uses full-width punctuation and says the context is missing`() {
        val prompt = HandoffPrompt.build(
            chinese,
            HandoffPrompt.Meeting(
                title = "範例：與泓昇科技的第一次通話",
                date = "2026年9月27日 上午10:19",
                context = "   ",
                speakers = "你和林經理",
                turns = listOf(HandoffPrompt.Turn("林經理", 7_665L, "旺季一天大概三百多通。")),
                questions = listOf("林經理對價格的疑慮是什麼？"),
            ),
        )

        assertEquals(
            """
            你是我的會議分析助理。以下是一場會議的完整逐字稿，請先讀完，再回答：
            1. 林經理對價格的疑慮是什麼？
            回答時引用逐字稿原句並標時間。

            會議：範例：與泓昇科技的第一次通話（2026年9月27日 上午10:19）
            背景：未填
            說話者：你和林經理

            --- 逐字稿 ---
            [0:07] 林經理：旺季一天大概三百多通。
            """.trimIndent(),
            prompt,
        )
    }

    @Test
    fun `a percent sign in the transcript is text, not a format directive`() {
        val prompt = HandoffPrompt.build(
            english,
            HandoffPrompt.Meeting(
                title = "100% renewal",
                date = "today",
                context = "",
                speakers = "A",
                turns = listOf(HandoffPrompt.Turn("A", 0L, "Sixty %d percent")),
                questions = emptyList(),
            ),
        )

        assertTrue(prompt.contains("Meeting: 100% renewal (today)"))
        assertTrue(prompt.endsWith("[0:00] A: Sixty %d percent"))
    }

    @Test
    fun `speakers are listed once each, in order of first appearance`() {
        val turns = listOf("B", "A", "B", "C", "A")
        assertEquals(listOf("B", "A", "C"), HandoffPrompt.distinctSpeakers(turns) { it })
    }

    @Test
    fun `the clock matches the transcript rows`() {
        assertEquals("0:00", HandoffPrompt.clock(999L))
        assertEquals("1:05", HandoffPrompt.clock(65_000L))
        assertEquals("72:03", HandoffPrompt.clock(4_323_000L))
        assertEquals("0:00", HandoffPrompt.clock(-5L))
    }
}
