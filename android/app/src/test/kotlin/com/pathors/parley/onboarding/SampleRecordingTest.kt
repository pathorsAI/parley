package com.pathors.parley.onboarding

import com.pathors.parley.cloud.CloudFolder
import com.pathors.parley.cloud.CloudOrg
import com.pathors.parley.cloud.RecordingSource
import com.pathors.parley.cloud.RecordingSummary
import com.pathors.parley.kit.GettingStartedState
import com.pathors.parley.kit.SampleManifest
import com.pathors.parley.ui.ChecklistAction
import com.pathors.parley.ui.HomeViewModel
import com.pathors.parley.ui.IntroFilm
import com.pathors.parley.ui.LapRules
import com.pathors.parley.ui.LibraryRules
import com.pathors.parley.ui.OpenFor
import com.pathors.parley.ui.RecordingDetailViewModel
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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

    private val entry = SampleRecordingStore.Entry(lang = EN, addedAtMs = 5_000.0, folderId = "f-1")

    @Test
    fun `the meta reads like a synced recording`() {
        val manifest = manifest(EN)
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
        val manifest = manifest(EN)
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
        val meta = SampleRecordingStore.metaOf(manifest(ZH), entry.copy(folderId = null))
        assertNull(meta.folderId)
    }

    @Test
    fun `the row carries the folder and says it has audio`() {
        val manifest = manifest(ZH)
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
    fun `the sample is never offered for sharing to an organization`() {
        val state = HomeViewModel.UiState(orgs = listOf(CloudOrg(id = "o", name = "Team", role = "member")))

        assertTrue(LibraryRules.recordingRow(state, row(SAMPLE_ID, 1.0)).shareTargets.isEmpty())
        assertEquals(1, LibraryRules.recordingRow(state, row("a", 1.0)).shareTargets.size)
    }

    // ── rename and the prewritten suggestion ─────────────────────────────────

    @Test
    fun `a rename shows on the row and the recording, and never touches the manifest`() {
        val manifest = manifest(EN)
        val renamed = entry.copy(title = RENAMED)

        assertEquals(RENAMED, SampleRecordingStore.summaryOf(manifest, renamed).title)
        assertEquals(RENAMED, SampleRecordingStore.metaOf(manifest, renamed).title)
        assertEquals(manifest.title, SampleRecordingStore.summaryOf(manifest, entry).title)
    }

    @Test
    fun `a blank rename, or the manifest's own title, puts the manifest's title back`() {
        assertNull(SampleRecordingStore.storedTitle("  ", MANIFEST_TITLE))
        assertNull(SampleRecordingStore.storedTitle(" $MANIFEST_TITLE ", MANIFEST_TITLE))
        assertEquals(RENAMED, SampleRecordingStore.storedTitle(" $RENAMED ", MANIFEST_TITLE))
    }

    @Test
    fun `the suggestion is pending until answered, and an old entry reads pending while untouched`() {
        assertTrue(SampleRecordingStore.Entry(lang = EN, addedAtMs = 1.0).isSuggestionPending)
        assertTrue(entry.copy(folderId = null, suggestionPending = true).isSuggestionPending)
        assertFalse("filed before the flag existed", entry.isSuggestionPending)
        assertFalse(entry.copy(folderId = null, title = RENAMED).isSuggestionPending)
        assertFalse(entry.copy(suggestionPending = false).isSuggestionPending)
    }

    @Test
    fun `the card offers the manifest's title and customer folder, then two recent folders`() {
        val manifest = manifest(ZH)
        val folders = listOf(
            CloudFolder(id = "old", name = "Old", createdAt = 1.0),
            CloudFolder(id = "team", name = "Team", orgId = ORG_ID, updatedAt = 99.0),
            CloudFolder(id = "new", name = "New", createdAt = 2.0, updatedAt = 50.0),
            CloudFolder(id = "mid", name = "Mid", createdAt = 10.0),
        )
        val pending = entry.copy(folderId = null, suggestionPending = true)
        val suggestion = SampleRecordingStore.suggestionOf(manifest, pending, folders)

        assertEquals(manifest.suggestion?.title, suggestion?.title)
        assertEquals(listOf(null, "new", "mid"), suggestion?.folders?.map { it.folderId })
        assertEquals(manifest.suggestion?.folders?.first()?.name, suggestion?.folders?.first()?.name)
        assertNull(
            "answered, there is nothing to offer",
            SampleRecordingStore.suggestionOf(manifest, pending.copy(suggestionPending = false), folders),
        )
    }

    @Test
    fun `the sample says its suggestion is prewritten, so no filing pass runs on it`() {
        assertTrue(SampleRecordingStore.metaOf(manifest(EN), entry).filingSuggested)
    }

    // ── the guided lap's recording ───────────────────────────────────────────

    @Test
    fun `continue reopens the sample, else the newest recording`() {
        val sample = row(SAMPLE_ID, 5.0)
        val recordings = listOf(row(FIRST, 1.0), row(SECOND, 3.0))

        assertEquals(SAMPLE_ID, LapRules.lapRecording(recordings, sample)?.id)
        assertEquals(SECOND, LapRules.lapRecording(recordings, null)?.id)
        assertNull(LapRules.lapRecording(emptyList(), null))
    }

    @Test
    fun `the lap recording is the sample or the only recording, and never an organization's`() {
        val only = listOf(row(FIRST, 1.0))
        val two = only + row(SECOND, 2.0)

        assertTrue(LapRules.isLapRecording(SAMPLE_ID, null, two))
        assertTrue(LapRules.isLapRecording(FIRST, null, only))
        assertFalse("on the second recording the lap would be noise", LapRules.isLapRecording(FIRST, null, two))
        assertFalse(LapRules.isLapRecording(FIRST, ORG_ID, only))
        assertFalse(LapRules.isLapRecording(SAMPLE_ID, ORG_ID, only))
    }

    @Test
    fun `the header walks through the sample until something is recorded`() {
        val fresh = GettingStartedState()
        val recorded = GettingStartedState(recorded = true)
        val lap = row(SAMPLE_ID, 5.0)

        assertEquals(ChecklistAction.WALK_THROUGH, LapRules.checklistAction(fresh, lap, sampleBundled = true))
        assertEquals(ChecklistAction.CONTINUE_LAP, LapRules.checklistAction(recorded, lap, sampleBundled = true))
        assertEquals(
            "recorded, but nothing left to continue on",
            ChecklistAction.WALK_THROUGH,
            LapRules.checklistAction(recorded, null, sampleBundled = true),
        )
        assertEquals(ChecklistAction.NONE, LapRules.checklistAction(fresh, null, sampleBundled = false))
    }

    @Test
    fun `an unknown route intent is a plain read`() {
        assertEquals(OpenFor.SHARE, OpenFor.parse("SHARE"))
        assertEquals(OpenFor.READ, OpenFor.parse(null))
        assertEquals(OpenFor.READ, OpenFor.parse("something-newer"))
    }

    // ── the sign-in film ─────────────────────────────────────────────────────

    @Test
    fun `the film casts the sample's first three lines, its folder and its title`() {
        for (lang in listOf(EN, ZH)) {
            val manifest = manifest(lang)
            val film = IntroFilm.of(manifest)

            assertEquals(3, film.lines.size)
            assertEquals(listOf(true, false, true), film.lines.map { it.isMe })
            assertEquals(manifest.speakers.me, film.lines.first().speaker)
            assertTrue(film.lines.all { it.text.length <= CLIP_WITH_ELLIPSIS })
            assertEquals(manifest.suggestion?.folders?.first()?.name, film.folderName)
            assertEquals(manifest.suggestion?.title, film.cardTitle)
            assertEquals(film.lines.size, film.schedule.lines.size)
        }
    }

    private companion object {
        const val SAMPLE_ID = "sample-x"
        const val EN = "en"
        const val ZH = "zh-TW"
        const val ORG_ID = "org-1"
        const val FIRST = "rec-first"
        const val SECOND = "rec-second"
        const val RENAMED = "Hongsheng kickoff"
        const val MANIFEST_TITLE = "Sample: first call"

        /** `LapMotion.clip`'s limit plus the ellipsis. */
        const val CLIP_WITH_ELLIPSIS = 35
    }
}
