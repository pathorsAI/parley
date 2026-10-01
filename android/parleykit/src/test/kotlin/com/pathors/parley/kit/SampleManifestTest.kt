package com.pathors.parley.kit

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SampleManifestTest {

    private val json = """
        {
          "id": "sample-hongsheng-en-v1",
          "lang": "en",
          "title": "Sample: first call",
          "audio": "sample-en.ogg",
          "durationMs": 20000,
          "meetingKind": "sales",
          "context": "First discovery call.",
          "speakers": { "me": "You", "them": "Mr. Lin" },
          "voices": { "me": "Samantha", "them": "Daniel" },
          "segments": [
            { "speaker": "me", "startMs": 300, "endMs": 7015, "text": "Good afternoon." },
            { "speaker": "them", "startMs": 7665, "endMs": 18608, "text": "Afternoon." }
          ],
          "questions": ["What was the price objection?"],
          "mcpQuestions": ["Find the call."],
          "suggestion": {
            "title": "$SUGGESTED_TITLE",
            "folders": [{ "name": "$CUSTOMER", "reason": "The customer's name" }]
          }
        }
    """.trimIndent()

    @Test
    fun `decodes and ignores fields the phone does not use`() {
        val manifest = SampleManifest.decode(json)

        assertEquals("sample-hongsheng-en-v1", manifest.id)
        assertEquals("Mr. Lin", manifest.speakers.them)
        assertEquals(2, manifest.segments.size)
        assertEquals(listOf("What was the price objection?"), manifest.questions)
        assertTrue(SampleManifest.isSample(manifest.id))
        assertFalse(SampleManifest.isSample("rec-1"))
    }

    @Test
    fun `segments read like a synced recording's, one index per side`() {
        val manifest = SampleManifest.decode(json)
        val segments = manifest.transcriptSegments

        assertEquals(listOf(300L, 7665L), segments.map { it.startMs })
        assertEquals(listOf("me-0", "them-1"), segments.map { it.id })
        assertEquals(2, segments.map { "${it.source}-${it.speaker}" }.toSet().size)
        assertEquals(
            listOf("You", "Mr. Lin"),
            segments.map { manifest.speakerNames.getValue("${it.source}-${it.speaker}") },
        )
    }

    // ── the prewritten filing suggestion ────────────────────────────────────

    @Test
    fun `decodes the suggestion, and a manifest without one has none`() {
        val manifest = SampleManifest.decode(json)
        assertEquals(SUGGESTED_TITLE, manifest.suggestion?.title)
        assertEquals(listOf(CUSTOMER), manifest.suggestion?.folders?.map { it.name })

        val bare = SampleManifest.decode(json.substringBefore(",\n  \"suggestion\"") + "\n}")
        assertNull(bare.suggestion)
        assertNull(bare.filingSuggestion(emptyList()))
    }

    @Test
    fun `with no folders the card offers the new customer folder alone`() {
        val suggestion = SampleManifest.decode(json).filingSuggestion(emptyList())

        assertEquals(SUGGESTED_TITLE, suggestion?.title)
        assertEquals(listOf(FilingFolderSuggestion(null, CUSTOMER, "The customer's name")), suggestion?.folders)
    }

    @Test
    fun `two recent personal folders follow, newest first, never an organization's`() {
        val folders = listOf(
            FilingFolder(id = "old", name = "Old", lastUsedAtMs = 1.0),
            FilingFolder(id = "team", name = "Team", orgId = "org-1", lastUsedAtMs = 9.0),
            FilingFolder(id = "new", name = "New", lastUsedAtMs = 5.0),
            FilingFolder(id = "never", name = "Never"),
            FilingFolder(id = "mid", name = "Mid", lastUsedAtMs = 3.0),
        )
        val chips = SampleManifest.decode(json).filingSuggestion(folders)?.folders.orEmpty()

        assertEquals(listOf(null, "new", "mid"), chips.map { it.folderId })
        assertEquals(3, chips.size)
    }

    @Test
    fun `a customer folder the user already has is pointed at, not proposed twice`() {
        val folders = listOf(
            FilingFolder(id = "mine", name = CUSTOMER.lowercase(), lastUsedAtMs = 1.0),
            FilingFolder(id = "other", name = "Other", lastUsedAtMs = 2.0),
        )
        val chips = SampleManifest.decode(json).filingSuggestion(folders)?.folders.orEmpty()

        assertEquals(listOf("mine", "other"), chips.map { it.folderId })
    }

    @Test
    fun `a Chinese phone gets the zh-TW sample and everything else the English one`() {
        assertEquals("zh-TW", SampleManifest.langFor("zh"))
        assertEquals("en", SampleManifest.langFor("en"))
        assertEquals("en", SampleManifest.langFor("ja"))
    }

    /**
     * The files that actually ship: `public/sample`, shared with the desktop and
     * iOS and copied into the APK at build time. Both have to decode, carry the
     * sample prefix, and name an audio file that is really there.
     */
    @Test
    fun `the shipped manifests decode`() {
        val directory = File("../../public/sample")
        assertTrue("not found from ${File("").absolutePath}: $directory", directory.isDirectory)
        for (lang in listOf("en", "zh-TW")) {
            val manifest = SampleManifest.decode(File(directory, "sample.$lang.json").readText())
            assertEquals(lang, manifest.lang)
            assertTrue(SampleManifest.isSample(manifest.id))
            assertTrue(manifest.segments.isNotEmpty())
            assertEquals(3, manifest.questions.size)
            assertTrue(File(directory, manifest.audio).isFile)
            assertTrue(manifest.suggestion?.title.orEmpty().isNotBlank())
            assertEquals(1, manifest.suggestion?.folders?.size)
        }
    }

    private companion object {
        const val SUGGESTED_TITLE = "Hongsheng · discovery call"
        const val CUSTOMER = "Hongsheng Technology"
    }
}
