package com.pathors.parley.ui

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

/**
 * The hand-off prompt and the checklist say exactly what iOS says, in both
 * languages.
 *
 * The prompt is pasted into somebody's AI; the same meeting handed off from an
 * iPhone and an Android phone should read the same, word for word, and the
 * checklist is one product's first five minutes on two platforms. So instead of
 * trusting a translation to stay in step, this reads the iOS catalogue
 * (`ios/App/Parley/Localizable.xcstrings`) and compares — with the one
 * mechanical difference, `%@` spelled `%s`.
 */
class HandoffStringsParityTest {

    /**
     * Android key → the iOS catalogue key (which is also the English text).
     *
     * Three checklist strings are not here: "Load sample", "or load the sample
     * recording" and "ChatGPT and Claude are in the share sheet" left the iOS
     * catalogue when iOS moved to the guided lap (#450). Android ports the
     * checklist as it shipped in #435 and keeps that wording.
     */
    private val shared = mapOf(
        "handoff_preamble" to "You are my meeting analyst. Below is the full transcript of a meeting. " +
            "Read all of it first, then answer:",
        "handoff_question_summary" to
            "What was this meeting about and what was concluded? Five sentences or fewer.",
        "handoff_question_commitments" to "What did each side commit to? Include owner and timing.",
        "handoff_question_missed" to "What did I fail to ask, or should follow up on next time?",
        "handoff_closing" to "Quote the transcript's own words and give the timestamp when you answer.",
        "handoff_meeting" to "Meeting: %1\$@ (%2\$@)",
        "handoff_context" to "Context: %@",
        "handoff_context_missing" to "not provided",
        "handoff_speakers" to "Speakers: %@",
        "handoff_transcript_header" to "--- Transcript ---",
        "handoff_line" to "%1\$@: %2\$@",
        "transcript_share_to_ai" to "Share to AI (with analysis prompt)",
        "transcript_copy_with_prompt" to "Copy with analysis prompt",
        "getting_started_title" to "Do one lap, five minutes",
        "getting_started_not_now" to "Not now",
        "getting_started_recorded" to "Record your first meeting",
        "getting_started_filed" to "Put it in a folder",
        "getting_started_filed_detail" to "One customer, one folder",
        "getting_started_replayed" to "Replay: tap a line to jump",
        "getting_started_shared" to "Share it with your AI",
        "getting_started_show_again" to "Show the getting-started list again",
        "recording_source_sample" to "SAMPLE",
        "sample_missing" to "The sample recording is no longer in the library.",
        // The account sheet, sign-in and What's New, ported from iOS Settings
        // and #478: the same sentences, not a second translation of them.
        "account_about_detail" to "Live coaching and deep analysis live in the desktop app; the phone " +
            "handles recording, transcribing, and reading back in-person meetings. On the Mac, Claude Code " +
            "can also read your whole recording library over MCP.",
        "org_role_owner" to "Owner",
        "org_role_admin" to "Admin",
        "org_role_member" to "Member",
        "action_refresh" to "Refresh",
        "sign_in_didnt_finish" to "Sign-in didn't finish. Please try again.",
        "whats_new_also" to "Also",
    )

    private val catalogue: JsonObject by lazy {
        val file = File("../../ios/App/Parley/Localizable.xcstrings")
        assertTrue("not found from ${File("").absolutePath}: $file", file.isFile)
        Json.parseToJsonElement(file.readText()).jsonObject.getValue("strings").jsonObject
    }

    @Test
    fun `english matches the iOS catalogue`() {
        val android = stringsOf("values")
        val mismatched = shared.mapNotNull { (key, ios) ->
            val expected = android(ios(ios, "en") ?: ios)
            (key to android[key]).takeIf { android[key] != expected }
        }
        assertEquals(emptyList<Pair<String, String?>>(), mismatched)
    }

    @Test
    fun `traditional chinese matches the iOS catalogue`() {
        val android = stringsOf("values-zh-rTW")
        val mismatched = shared.mapNotNull { (key, ios) ->
            val translated = ios(ios, "zh-Hant")
            assertTrue("iOS has no zh-Hant for \"$ios\"", translated != null)
            val expected = android(translated!!)
            (key to android[key]).takeIf { android[key] != expected }
        }
        assertEquals(emptyList<Pair<String, String?>>(), mismatched)
    }

    /** The iOS value for [key] in [language], or null when the catalogue has none. */
    private fun ios(key: String, language: String): String? =
        (catalogue[key] as? JsonObject)
            ?.get("localizations")?.jsonObject
            ?.get(language)?.jsonObject
            ?.get("stringUnit")?.jsonObject
            ?.get("value")?.jsonPrimitive?.content

    /** iOS placeholders in Android's spelling: `%@` → `%1$s`, `%1$@` → `%1$s`. */
    private fun android(ios: String): String =
        ios.replace("%@", "%1\$s").replace(Regex("""%(\d)\$@"""), "%$1\\\$s")

    /** `name` → text as Android will hand it to the app (escapes resolved). */
    private fun stringsOf(qualifier: String): Map<String, String> {
        val file = File("src/main/res/$qualifier/strings.xml")
        val document = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file)
        val nodes = document.getElementsByTagName("string")
        return (0 until nodes.length)
            .map { nodes.item(it) as Element }
            .associate { it.getAttribute("name") to it.textContent.replace("\\'", "'") }
    }
}
