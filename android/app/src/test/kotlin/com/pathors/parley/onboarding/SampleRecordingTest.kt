package com.pathors.parley.onboarding

import com.pathors.parley.cloud.CloudOrg
import com.pathors.parley.cloud.RecordingSource
import com.pathors.parley.cloud.RecordingSummary
import com.pathors.parley.kit.GettingStartedStep
import com.pathors.parley.kit.SampleManifest
import com.pathors.parley.ui.HomeViewModel
import com.pathors.parley.ui.LibraryRules
import com.pathors.parley.ui.OpenFor
import com.pathors.parley.ui.RecordingDetailViewModel
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The sample as the library and the detail screen read it, from the manifests
 * that actually ship (`public/sample`, copied into the APK at build time).
 */
class SampleRecordingTest {

    private fun manifest(lang: String): SampleManifest {
        val file = File("../../public/sample/sample.$lang.json")
        assertTrue("not found from ${File("").absolutePath}: $file", file.isFile)
        return SampleManifest.decode(file.readText())
    }

    private val entry = SampleRecordingStore.Entry(lang = "en", addedAtMs = 5_000.0, folderId = "f-1")

    @Test
    fun `the meta reads like a synced recording`() {
        val manifest = manifest("en")
        val meta = SampleRecordingStore.metaOf(manifest, entry)

        assertEquals(manifest.id, meta.id)
        assertEquals("f-1", meta.folderId)
        assertEquals(manifest.segments.size, meta.segments.size)
        assertEquals(listOf("You", "Mr. Lin"), meta.segments.take(2).map { meta.speakerName(it) })
        assertEquals(2, meta.segments.map { meta.speakerKey(it) }.toSet().size)
        assertTrue("the bundled audio makes it playable", meta.hasAudio)
        // The prewritten analysis comes along, so the detail screen has findings to show.
        assertEquals(manifest.findings?.size, RecordingDetailViewModel.readFindings(meta).size)
        assertEquals(manifest.actionItems?.size, RecordingDetailViewModel.readActionItems(meta).size)
    }

    @Test
    fun `the sample's action items are ticked by position and kept`() {
        val manifest = manifest("en")
        val ticked = SampleRecordingStore.actionItemId(1)
        val meta = SampleRecordingStore.metaOf(manifest, entry.copy(doneActionItems = listOf(ticked)))
        val items = RecordingDetailViewModel.readActionItems(meta)

        assertEquals(manifest.actionItems?.indices?.map { SampleRecordingStore.actionItemId(it) }, items.map { it.id })
        assertEquals(items.map { it.id == ticked }, items.map { it.done })
        // Where each came from is passed through, so its timestamp can jump.
        assertTrue(items.all { it.atMs != null })
        // Analysis to open the summary page on.
        assertTrue(RecordingDetailViewModel.fromMeta(meta).hasAnalysis)
    }

    @Test
    fun `an entry saved before ticks existed still decodes`() {
        val json = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }
        val old = json.decodeFromString(
            SampleRecordingStore.Entry.serializer(),
            """{ "lang": "en", "addedAtMs": 1.0, "folderId": null }""",
        )
        assertTrue(old.doneActionItems.isEmpty())
    }

    @Test
    fun `unfiled is a null folder`() {
        val meta = SampleRecordingStore.metaOf(manifest("zh-TW"), entry.copy(folderId = null))
        assertNull(meta.folderId)
    }

    @Test
    fun `the row carries the folder and says it has audio`() {
        val manifest = manifest("zh-TW")
        val row = SampleRecordingStore.summaryOf(manifest, entry)

        assertEquals(manifest.id, row.id)
        assertEquals("f-1", row.folderId)
        assertEquals(5_000.0, row.createdAt, 0.0)
        assertTrue(row.hasAudio)
        assertEquals(manifest.segments.first().text, row.snippet)
    }

    // ── in the library ───────────────────────────────────────────────────────

    private fun row(id: String, createdAt: Double) = RecordingSummary(
        id = id,
        title = id,
        source = RecordingSource.LIVE,
        createdAt = createdAt,
        durationMs = 1_000.0,
        hasAudio = true,
    )

    @Test
    fun `the sample slots into the personal list by date`() {
        val newer = row("b", 9_000.0)
        val older = row("a", 1_000.0)
        val sample = row(SAMPLE_ID, 5_000.0)

        assertEquals(
            listOf("b", SAMPLE_ID, "a"),
            HomeViewModel.withSample(listOf(newer, older), sample, isPersonal = true).map { it.id },
        )
        assertEquals(
            listOf(SAMPLE_ID),
            HomeViewModel.withSample(emptyList(), sample, isPersonal = true).map { it.id },
        )
    }

    @Test
    fun `an organization's library never shows the sample`() {
        val list = listOf(row("a", 1.0))
        assertSame(list, HomeViewModel.withSample(list, row(SAMPLE_ID, 5.0), isPersonal = false))
    }

    @Test
    fun `the checklist opens the newest recording, the sample included`() {
        val library = listOf(row("a", 1.0), row(SAMPLE_ID, 5.0), row("b", 3.0))
        assertEquals(SAMPLE_ID, HomeViewModel.latestRecording(library)?.id)
        assertNull(HomeViewModel.latestRecording(emptyList()))
    }

    @Test
    fun `the sample is never offered for sharing to an organization`() {
        val state = HomeViewModel.UiState(orgs = listOf(CloudOrg(id = "o", name = "Team", role = "member")))

        assertTrue(LibraryRules.recordingRow(state, row(SAMPLE_ID, 1.0)).shareTargets.isEmpty())
        assertEquals(1, LibraryRules.recordingRow(state, row("a", 1.0)).shareTargets.size)
    }

    // ── the intent a checklist row opens with ────────────────────────────────

    @Test
    fun `each checklist row opens the recording for what finishes it`() {
        assertEquals(OpenFor.FILE, OpenFor.of(GettingStartedStep.FILED))
        assertEquals(OpenFor.SHARE, OpenFor.of(GettingStartedStep.SHARED_TO_AI))
        assertEquals(OpenFor.READ, OpenFor.of(GettingStartedStep.REPLAYED))
        assertEquals(OpenFor.SHARE, OpenFor.parse("SHARE"))
        assertEquals(OpenFor.READ, OpenFor.parse(null))
        assertEquals(OpenFor.READ, OpenFor.parse("something-newer"))
    }

    private companion object {
        const val SAMPLE_ID = "sample-x"
    }
}
