package com.pathors.parley.screenshot

import com.pathors.parley.ui.RecordingDetailViewModel
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The fixtures are the product in a screenshot, so they are worth testing: both
 * languages have to be complete (a half-translated set ships a half-translated
 * store listing), and the content has to be the shape the detail screen reads.
 *
 * The deep-link routing itself needs `android.net.Uri` and `BuildConfig`, so it
 * is covered on-device rather than here.
 */
class DemoModeTest {

    private val en = Locale.ENGLISH
    private val zh = Locale.TRADITIONAL_CHINESE

    @Test
    fun `library is populated in both languages`() {
        listOf(en, zh).forEach { locale ->
            val recordings = DemoMode.recordings(locale)
            assertEquals(3, recordings.size)
            recordings.forEach { recording ->
                assertTrue(recording.title.isNotBlank())
                assertTrue(recording.snippet.orEmpty().isNotBlank())
                assertTrue(recording.durationMs > 0)
                assertTrue(recording.createdAt > 0)
            }
        }
    }

    @Test
    fun `every language differs, so nothing is left untranslated`() {
        val english = DemoMode.recordings(en)
        val chinese = DemoMode.recordings(zh)
        english.zip(chinese).forEach { (a, b) ->
            assertEquals(a.id, b.id)
            assertNotEquals(a.title, b.title)
            assertNotEquals(a.snippet, b.snippet)
        }
        assertNotEquals(DemoMode.user(en).name, DemoMode.user(zh).name)
    }

    @Test
    fun `the featured recording carries transcript, findings and action items`() {
        listOf(en, zh).forEach { locale ->
            val meta = DemoMode.meta(DemoMode.FEATURED_ID, locale)
            assertNotNull(meta)
            requireNotNull(meta)
            assertEquals(6, meta.segments.size)
            assertTrue(meta.analyzed)
            assertTrue(meta.segments.all { it.text.isNotBlank() && it.isFinal })
            // Two speakers, both named — the point of the transcript screenshot.
            assertEquals(2, meta.segments.map { meta.speakerKey(it) }.toSet().size)
            assertTrue(meta.segments.all { meta.speakerName(it) != null })

            val findings = RecordingDetailViewModel.readFindings(meta)
            val actions = RecordingDetailViewModel.readActionItems(meta)
            assertEquals(3, findings.size)
            assertEquals(2, actions.size)
            assertTrue(findings.all { it.title.isNotBlank() && it.detail.isNotBlank() })
            assertTrue(findings.all { it.atMs != null })
            assertTrue(actions.all { it.text.isNotBlank() && !it.done })
        }
    }

    @Test
    fun `every listed recording opens`() {
        DemoMode.recordings(en).forEach { summary ->
            val meta = DemoMode.meta(summary.id, en)
            assertNotNull(meta)
            requireNotNull(meta)
            assertEquals(summary.id, meta.id)
            assertEquals(summary.title, meta.title)
            assertEquals(summary.durationMs, meta.durationMs, 0.0)
            // The summary's counts have to be the truth about the meta, or a
            // future card that renders them would be lying in a screenshot.
            assertEquals(
                summary.findingsCount ?: 0,
                RecordingDetailViewModel.readFindings(meta).size,
            )
            assertEquals(
                summary.actionItemsCount ?: 0,
                RecordingDetailViewModel.readActionItems(meta).size,
            )
        }
    }

    @Test
    fun `an unknown id has no fixture`() {
        assertNull(DemoMode.meta("not-a-demo-recording", en))
    }

    @Test
    fun `the live script starts mid-conversation and ends unfinished`() {
        listOf(en, zh).forEach { locale ->
            val script = DemoMode.liveScript(locale)
            assertEquals(6, script.size)
            assertTrue(script.all { it.isFinal && it.source == "mix" })
            // Ids are what the UI upserts on; duplicates would collapse rows.
            assertEquals(script.size, script.map { it.id }.toSet().size)

            val tail = DemoMode.liveTail(locale)
            assertFalse(tail.isFinal)
            assertTrue(tail.id.endsWith("-tail"))
            assertTrue(tail.startMs > script.last().startMs)
        }
    }

    @Test
    fun `nothing points at a real person, company or address`() {
        val text = listOf(en, zh).flatMap { locale ->
            DemoMode.recordings(locale).flatMap { listOf(it.title, it.snippet.orEmpty()) } +
                DemoMode.recordings(locale).mapNotNull { DemoMode.meta(it.id, locale) }
                    .flatMap { meta -> meta.segments.map { it.text } } +
                listOf(DemoMode.user(locale).email)
        }.joinToString(" ")
        assertTrue(DemoMode.user(en).email.endsWith("@example.com"))
        assertFalse(text.contains("pathors", ignoreCase = true))
        assertFalse(text.contains("parley.tw", ignoreCase = true))
    }

    private fun assertNotEquals(a: Any?, b: Any?) {
        assertFalse("expected $a and $b to differ", a == b)
    }
}
