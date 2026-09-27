package com.pathors.parley.kit

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
          "mcpQuestions": ["Find the call."]
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
        }
    }
}
