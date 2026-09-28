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
     * The checklist and the sign-in page are onboarding v2 (#450) on both
     * phones: v1's "Load sample" and the rows' detail lines are gone from each.
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
        "getting_started_replayed" to "Replay: tap a line to jump",
        "getting_started_shared" to "Share it with your AI",
        "getting_started_show_again" to "Show the getting-started list again",
        "getting_started_done" to "Done",
        "getting_started_walk_through" to "Walk through it with the sample recording",
        "getting_started_continue" to "Continue →",
        "getting_started_transcribing" to "Transcribing…",
        // The sign-in page: the headline and the intro film (IntroStage).
        "onboarding_headline" to "Record it. Hand it to the AI you already use.",
        "onboarding_subline" to "Parley records in-person meetings, transcribes them live, and keeps them " +
            "where your Mac and phone can both find them.",
        "onboarding_sign_in_methods" to "Email and password, Google, and Apple all work. Before any recording " +
            "starts, Parley asks you to confirm everyone in the room has agreed to it.",
        "intro_recording_now" to "Recording now",
        "intro_caption_recording" to "Parley records both sides of the conversation.",
        "intro_caption_transcript" to "It turns into text as you go, with who said what.",
        "intro_caption_folder" to "Then one customer, one folder.",
        "intro_caption_share" to "And share it with ChatGPT or Claude to analyse.",
        "intro_point_record" to "Record and transcribe live, even from the lock screen",
        "intro_point_folder" to "One customer, one folder, synced with your Mac",
        "intro_point_share" to "Share to ChatGPT or Claude for analysis",
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
        // The recording page: Summary | Transcript (iOS #450).
        "detail_face_summary" to "Summary",
        "detail_transcript" to "Transcript",
        "detail_action_items" to "Action items",
        "detail_no_transcript" to "This recording has no transcript.",
        "detail_load_failed_title" to "Couldn't load",
        "recording_untitled" to "Untitled recording",
        "summary_highlights" to "Highlights %lld",
        "summary_speakers" to "Speakers",
        "summary_empty" to "No summary yet.",
        "summary_generate" to "Generate a summary with AI",
        "summary_done" to "Done",
        "summary_go_to" to "Go to %@ in the transcript",
        "transcript_highlight" to "Highlight: %@",
        "transcript_two_x_zone" to "Playback speed",
        "transcript_two_x_hint" to "Hold for 2×",
        "transcript_search" to "Search transcript",
    )

    /**
     * The speaker labels, which iOS keeps in ParleyKit's own catalogue
     * (`RecordingMeta.speakerLabel(for:)`) — the same names on both phones, and
     * in the clipboard and the hand-off text that reuse them.
     */
    private val kitShared = mapOf(
        "speaker_label" to "Speaker %@",
        "speaker_you" to "You",
        "speaker_you_numbered" to "You %lld",
        "speaker_them" to "Them",
        "speaker_remote_numbered" to "Remote %lld",
    )

    private val catalogue: JsonObject by lazy { catalogueAt("../../ios/App/Parley/Localizable.xcstrings") }

    private val kitCatalogue: JsonObject by lazy {
        catalogueAt("../../ios/ParleyKit/Sources/ParleyKit/Resources/Localizable.xcstrings")
    }

    private fun catalogueAt(path: String): JsonObject {
        val file = File(path)
        assertTrue("not found from ${File("").absolutePath}: $file", file.isFile)
        return Json.parseToJsonElement(file.readText()).jsonObject.getValue("strings").jsonObject
    }

    @Test
    fun `english matches the iOS catalogue`() {
        assertEquals(emptyList<Pair<String, String?>>(), mismatches("values", "en", shared, catalogue))
    }

    @Test
    fun `traditional chinese matches the iOS catalogue`() {
        assertEquals(emptyList<Pair<String, String?>>(), mismatches("values-zh-rTW", "zh-Hant", shared, catalogue))
    }

    @Test
    fun `speaker labels match ParleyKit's catalogue in both languages`() {
        assertEquals(emptyList<Pair<String, String?>>(), mismatches("values", "en", kitShared, kitCatalogue))
        assertEquals(
            emptyList<Pair<String, String?>>(),
            mismatches("values-zh-rTW", "zh-Hant", kitShared, kitCatalogue),
        )
    }

    /**
     * The Android keys in [keys] whose text differs from iOS's. English may fall
     * back to the key (a catalogue entry with no `en` is its own English);
     * Traditional Chinese may not.
     */
    private fun mismatches(
        qualifier: String,
        language: String,
        keys: Map<String, String>,
        catalogue: JsonObject,
    ): List<Pair<String, String?>> {
        val android = stringsOf(qualifier)
        return keys.mapNotNull { (key, ios) ->
            val translated = ios(catalogue, ios, language)
                ?: if (language == "en") ios else null
            assertTrue("iOS has no $language for \"$ios\"", translated != null)
            val expected = android(translated!!)
            (key to android[key]).takeIf { android[key] != expected }
        }
    }

    /** The iOS value for [key] in [language], or null when the catalogue has none. */
    private fun ios(catalogue: JsonObject, key: String, language: String): String? =
        (catalogue[key] as? JsonObject)
            ?.get("localizations")?.jsonObject
            ?.get(language)?.jsonObject
            ?.get("stringUnit")?.jsonObject
            ?.get("value")?.jsonPrimitive?.content

    /**
     * iOS placeholders in Android's spelling: `%@` → `%1$s`, `%1$@` → `%1$s`,
     * `%lld` → `%1$d`.
     */
    private fun android(ios: String): String =
        ios.replace("%lld", "%1\$d")
            .replace("%@", "%1\$s")
            .replace(Regex("""%(\d)\$@"""), "%$1\\\$s")

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
