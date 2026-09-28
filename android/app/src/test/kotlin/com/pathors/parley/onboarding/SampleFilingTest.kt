package com.pathors.parley.onboarding

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import com.pathors.parley.cloud.CloudClient
import com.pathors.parley.cloud.CloudFolder
import com.pathors.parley.filing.FilingCardController
import com.pathors.parley.filing.FilingSuggestionModel
import com.pathors.parley.filing.FilingTarget
import com.pathors.parley.filing.FolderTarget
import com.pathors.parley.filing.PendingFiling
import com.pathors.parley.kit.FilingSuggestion
import com.pathors.parley.kit.SampleManifest
import com.pathors.parley.screenshot.DemoMode
import java.io.File
import java.io.FileInputStream
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The sample's store as the recording page's filing card drives it
 * ([com.pathors.parley.filing.SampleFilingTarget]): the manifest's suggestion
 * is on offer once the sample is loaded, Accept and a chip rename and file the
 * local entry, and Skip — or both halves answered — retires the offer for good.
 * Nothing here reaches the cloud; the client points nowhere.
 */
class SampleFilingTest {

    @get:Rule
    val temporary = TemporaryFolder()

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private lateinit var sample: SampleRecordingStore
    private lateinit var manifest: SampleManifest

    @Before
    fun setUp() {
        DemoMode.disable()
        val preferences = PreferenceDataStoreFactory.create(
            scope = scope,
            produceFile = { File(temporary.root, "onboarding.preferences_pb") },
        )
        val gettingStarted = GettingStartedStore(
            store = preferences,
            scope = scope,
            hadStoredSession = { false },
        )
        sample = SampleRecordingStore(
            bundle = { path -> FileInputStream(File(REPOSITORY_PUBLIC, path)) },
            cacheDir = temporary.newFolder("cache"),
            store = preferences,
            scope = scope,
            gettingStarted = gettingStarted,
        )
        runBlocking { assertNotNull("the sample loads from public/sample", sample.load(EN)) }
        manifest = requireNotNull(sample.manifest(EN))
    }

    @After
    fun tearDown() {
        scope.cancel()
    }

    private fun entry(): SampleRecordingStore.Entry = runBlocking { requireNotNull(sample.currentEntry()) }

    private fun pending(folders: List<CloudFolder> = emptyList()): FilingSuggestion? =
        runBlocking { sample.pendingFilingSuggestion(folders) }

    /** The card, presented on the sample as the recording page presents it. */
    private fun card(folders: List<CloudFolder>): FilingSuggestionModel {
        val model = FilingSuggestionModel(
            cloud = CloudClient(baseUrl = NOWHERE, tokenProvider = { null }),
            speakerLabel = { "" },
        )
        val offer = PendingFiling(
            suggestion = requireNotNull(pending(folders)),
            currentTitle = manifest.title,
            currentFolderId = null,
            folders = folders,
        )
        assertTrue(model.present(offer, FilingTarget.Sample(sample)))
        return model
    }

    @Test
    fun `a freshly loaded sample offers the manifest's title and customer folder`() {
        val suggestion = pending()

        assertEquals(manifest.suggestion?.title, suggestion?.title)
        assertEquals(CUSTOMER, suggestion?.folders?.first()?.name)
        assertNull("not created until it is chosen", suggestion?.folders?.first()?.folderId)
    }

    @Test
    fun `the customer's folder is pointed at when the user already has one`() {
        val suggestion = pending(listOf(CloudFolder(id = CUSTOMER_ID, name = CUSTOMER)))
        assertEquals(CUSTOMER_ID, suggestion?.folders?.first()?.folderId)
    }

    @Test
    fun `accept renames and files the local entry, and the offer is over`() {
        val folders = listOf(CloudFolder(id = CUSTOMER_ID, name = CUSTOMER))
        val model = card(folders)
        runBlocking { FilingCardController(model, this, this).accept(null) }

        val stored = entry()
        assertEquals(CUSTOMER_ID, stored.folderId)
        assertEquals(manifest.suggestion?.title, SampleRecordingStore.summaryOf(manifest, stored).title)
        assertFalse(stored.isSuggestionPending)
        assertNull("never offered again", pending(folders))
    }

    @Test
    fun `a chip files without renaming, and the name stays on offer`() {
        val folders = listOf(CloudFolder(id = CUSTOMER_ID, name = CUSTOMER))
        val model = card(folders)
        runBlocking { FilingCardController(model, this, this).file(model.state.value.proposedFolders.first()) }

        val stored = entry()
        assertEquals(CUSTOMER_ID, stored.folderId)
        assertNull("not renamed", stored.title)
        assertTrue(stored.isSuggestionPending)

        // The other half answered: now it is over.
        runBlocking { model.apply(RENAMED, null) }
        assertEquals(RENAMED, entry().title)
        assertFalse(entry().isSuggestionPending)
    }

    @Test
    fun `skip answers the suggestion and changes nothing else`() {
        val model = card(emptyList())
        runBlocking { model.markAnswered(requireNotNull(model.forget())) }

        val stored = entry()
        assertFalse(stored.isSuggestionPending)
        assertNull(stored.folderId)
        assertNull(stored.title)
        assertNull(pending())
    }

    @Test
    fun `a move from the picker files the entry locally`() {
        val model = card(emptyList())
        runBlocking { model.apply(null, FolderTarget.Existing(OTHER_ID)) }
        assertEquals(OTHER_ID, entry().folderId)
    }

    private companion object {
        /** `public/`, from the app module's directory — where Gradle runs the tests. */
        val REPOSITORY_PUBLIC = File("../../public")
        const val EN = "en"
        const val NOWHERE = "https://cloud.invalid/"
        const val CUSTOMER = "Hongsheng Technology"
        const val CUSTOMER_ID = "f-hongsheng"
        const val OTHER_ID = "f-other"
        const val RENAMED = "Hongsheng kickoff"
    }
}
