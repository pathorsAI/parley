package com.pathors.parley.filing

import com.pathors.parley.cloud.CloudClient
import com.pathors.parley.cloud.CloudFolder
import com.pathors.parley.cloud.CloudJson
import com.pathors.parley.cloud.RecordingMeta
import com.pathors.parley.kit.FilingFolderSuggestion
import com.pathors.parley.kit.TranscriptSegment
import com.pathors.parley.library.SaveDestination
import com.pathors.parley.meeting.MeetingState
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The filing offer against a mock cloud: when the pass runs, what an answer
 * writes, and how an answered offer retires. Mirrors the behaviour iOS
 * `FilingSuggestionModel` pins down, including the two 1.14 fixes — a name the
 * user types is the one that stays, and a new folder is created once.
 */
class FilingSuggestionModelTest {
    private val server = MockWebServer()

    /** The recording's entry as the cloud holds it; every push replaces it. */
    @Volatile
    private var stored: JsonObject = buildJsonObject {
        put("id", RECORDING)
        put("title", CLOCK_TITLE)
        put("source", "live")
        put("createdAt", 1_700_000_000_000)
        put("durationMs", 60_000)
        put("audio", "audio.ogg")
    }

    /** What the model answers with, as the assistant's content. */
    @Volatile
    private var answer: String = SUGGESTION_JSON

    @Volatile
    private var pushFails = false

    private val pushes = CopyOnWriteArrayList<JsonObject>()
    private val paths = CopyOnWriteArrayList<String>()

    private val model by lazy {
        FilingSuggestionModel(
            cloud = CloudClient(baseUrl = server.url("/").toString(), tokenProvider = { "session-token" }),
            speakerLabel = { "Speaker ${it.speaker}" },
        )
    }

    @Before
    fun serveCloud() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                paths += "${request.method} $path"
                return when {
                    path == "/recordings/$RECORDING/meta" -> ok(stored.toString())
                    path == "/folders" && request.method == "GET" -> ok(FOLDERS_JSON)
                    path == "/folders" -> ok("{}")
                    path == "/v1/chat/completions" -> ok(chatResponse(answer))
                    path == "/recordings/$RECORDING" -> push(request)
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
    }

    private fun ok(body: String) = MockResponse().setResponseCode(200).setBody(body)

    private fun push(request: RecordedRequest): MockResponse {
        if (pushFails) return MockResponse().setResponseCode(500)
        val body = CloudJson.parseToJsonElement(request.body.readUtf8()).jsonObject
        pushes += body
        stored = body.getValue("meta").jsonObject
        return ok("""{"ok":true,"updatedAt":2}""")
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private val segments = listOf(
        TranscriptSegment("mix-0", "mix", 1, "Let's settle the Acme renewal.", true, 0, 2_000),
        TranscriptSegment("mix-tail", "mix", 1, "and then", false, 2_000, 3_000),
    )

    private fun offer() = runBlocking {
        assertTrue(model.claim(RECORDING, skip = null))
        model.run(RECORDING, FilingSuggestionModel.spoken(segments))
    }

    private val state get() = model.state.value

    private fun lastMeta() = RecordingMeta(pushes.last().getValue("meta").jsonObject)

    private fun lastSummary() = pushes.last().getValue("summary").jsonObject

    private fun count(request: String) = paths.count { it == request }

    // ── when the pass runs ───────────────────────────────────────────────────

    private fun finished(id: String? = RECORDING, pending: Boolean = false, dropped: Boolean = false) =
        MeetingState.Finished(recordingId = id, pendingUpload = pending, dropped = dropped)

    private val spoken = FilingSuggestionModel.spoken(segments)
    private val personal = SaveDestination.PERSONAL_ROOT

    @Test
    fun `the pass runs for an uploaded personal recording with something said`() {
        assertNull(FilingSuggestionModel.skipReason(finished(), personal, spoken, demo = false))
        assertNull(
            "a personal folder is still personal",
            FilingSuggestionModel.skipReason(finished(), SaveDestination(folderId = "f-1"), spoken, demo = false),
        )
    }

    @Test
    fun `the skip rules match iOS`() {
        fun skip(f: MeetingState.Finished, d: SaveDestination = personal, s: List<TranscriptSegment> = spoken, demo: Boolean = false) =
            FilingSuggestionModel.skipReason(f, d, s, demo)

        assertEquals(FilingSkip.ORG_DEFAULT, skip(finished(), d = SaveDestination(orgId = "org-1")))
        assertEquals(FilingSkip.NO_TRANSCRIPT, skip(finished(), s = emptyList()))
        assertEquals(FilingSkip.DEMO, skip(finished(), demo = true))
        assertEquals(FilingSkip.NOT_UPLOADED, skip(finished(pending = true)))
        assertEquals(FilingSkip.NOT_UPLOADED, skip(finished(dropped = true)))
        assertEquals(FilingSkip.NOT_UPLOADED, skip(finished(id = null)))
    }

    @Test
    fun `only final words count as something said`() {
        assertEquals(listOf("mix-0"), spoken.map { it.id })
        val silence = listOf(TranscriptSegment("mix-1", "mix", 1, "   ", true, 0, 1))
        assertTrue(FilingSuggestionModel.spoken(silence).isEmpty())
    }

    @Test
    fun `a skipped recording settles at once and is never claimed twice`() {
        assertFalse(model.claim(RECORDING, FilingSkip.ORG_DEFAULT))
        assertEquals(FilingPhase.SETTLED, state.phase)
        assertFalse(state.holdsScreen)
        assertFalse("already considered", model.claim(RECORDING, skip = null))
    }

    @Test
    fun `the pass holds the screen while it thinks, then offers`() {
        assertTrue(model.claim(RECORDING, skip = null))
        assertTrue(state.holdsScreen)
        runBlocking { model.run(RECORDING, spoken) }

        assertEquals(FilingPhase.OFFERING, state.phase)
        assertEquals(RENEWAL, state.proposedTitle)
        assertEquals(FilingFolderSuggestion(ACME_ID, ACME, "customer"), state.proposedFolder)
        assertEquals(CLOCK_TITLE, state.currentTitle)
        assertEquals(listOf(ACME_ID), state.existingFolders.map { it.id })
        assertTrue(state.holdsScreen)
        assertEquals(1, count(CHAT))
    }

    @Test
    fun `a recording another device already filed is not asked about again`() {
        stored = RecordingMeta(stored).withFilingSuggested().raw
        offer()
        assertEquals(FilingPhase.SETTLED, state.phase)
        assertEquals("no model call spent on it", 0, count(CHAT))
    }

    @Test
    fun `a failed pass is silence, not an error`() {
        answer = "I cannot help with that."
        offer()
        assertEquals(FilingPhase.SETTLED, state.phase)
        assertFalse(state.writeFailed)
        assertFalse(state.holdsScreen)
    }

    // ── answering ────────────────────────────────────────────────────────────

    @Test
    fun `save as suggested writes the name, the folder and the flag in one push`() {
        offer()
        assertTrue(runBlocking { model.acceptSuggested() })

        assertEquals(1, pushes.size)
        val meta = lastMeta()
        assertEquals(RENEWAL, meta.title)
        assertEquals(ACME_ID, meta.folderId)
        assertTrue(meta.filingSuggested)
        assertEquals("live", meta.source)
        assertEquals("the library row agrees", RENEWAL, lastSummary().getValue("title").jsonPrimitive.content)
        assertEquals(ACME_ID, lastSummary().getValue(FOLDER_ID).jsonPrimitive.content)
        assertFalse("answered, so the screen can go", state.holdsScreen)
        assertNull(state.proposedTitle)
    }

    /** iOS 1.14: accepting the same new folder twice used to create it twice. */
    @Test
    fun `a new folder is created on accept, once`() {
        answer = """{"title":"","folders":[{"name":"Globex","isNew":true,"reason":"new customer"}]}"""
        offer()
        assertEquals(null, state.proposedFolder?.folderId)

        assertTrue(runBlocking { model.acceptSuggested() })
        assertFalse("nothing left to accept", runBlocking { model.acceptSuggested() })

        assertEquals(1, count("POST /folders"))
        assertEquals(1, pushes.size)
        val created = state.existingFolders.single { it.name == "Globex" }
        assertEquals(created.id, lastMeta().folderId)
        assertTrue(state.proposedFolders.isEmpty())
    }

    /** iOS 1.14: a name the user types is the name that gets saved — and stays. */
    @Test
    fun `a typed name retires the name half instead of being written over`() {
        offer()
        assertTrue(runBlocking { model.apply(TYPED, null) })
        assertEquals(TYPED, lastMeta().title)
        assertNull(state.proposedTitle)

        // The folder half is still open; taking it must not bring the model's
        // name back over the one just typed.
        assertTrue(runBlocking { model.acceptSuggested() })
        assertEquals(TYPED, lastMeta().title)
        assertEquals(ACME_ID, lastMeta().folderId)
        assertFalse(state.holdsScreen)
    }

    @Test
    fun `moving to the root is said out loud in both halves`() {
        stored = RecordingMeta(stored).withFolderId(ACME_ID).raw
        offer()
        assertTrue(runBlocking { model.apply(null, FolderTarget.Root) })

        assertEquals(JsonNull, lastMeta().raw[FOLDER_ID])
        assertEquals(JsonNull, lastSummary()[FOLDER_ID])
        assertEquals(CLOCK_TITLE, lastMeta().title)
    }

    @Test
    fun `a save with nothing to change pushes nothing`() {
        offer()
        assertFalse(runBlocking { model.apply("  $CLOCK_TITLE ", null) })
        assertTrue(pushes.isEmpty())
    }

    @Test
    fun `a failed push keeps the offer open`() {
        offer()
        pushFails = true
        assertFalse(runBlocking { model.acceptSuggested() })

        assertTrue(state.writeFailed)
        assertEquals(RENEWAL, state.proposedTitle)
        assertTrue("still worth taking", state.holdsScreen)
        assertFalse(state.isWriting)
    }

    @Test
    fun `skip retires the offer at once and still writes the flag`() {
        offer()
        val target = model.forget()
        assertEquals(FilingTarget.Cloud(RECORDING), target)
        assertEquals(FilingPhase.SETTLED, state.phase)
        assertFalse(state.holdsScreen)

        runBlocking { model.markAnswered(target!!) }
        assertTrue(lastMeta().filingSuggested)
        assertEquals(JsonNull, lastMeta().raw[PENDING])
        assertEquals("nothing else changes", CLOCK_TITLE, lastMeta().title)
        assertNull(lastMeta().folderId)
    }

    @Test
    fun `the demo offer writes nothing`() {
        model.seedDemo(RECORDING, SUGGESTION, CLOCK_TITLE, emptyList())
        assertFalse("the screen's own consider does not settle it", model.claim(RECORDING, FilingSkip.DEMO))
        assertTrue(state.holdsScreen)
        assertFalse(runBlocking { model.acceptSuggested() })
        assertTrue(paths.isEmpty())
    }

    // ── a suggestion already pending on the recording (the recording page) ───

    private fun pending(folderId: String? = null) = PendingFiling(
        suggestion = SUGGESTION,
        currentTitle = CLOCK_TITLE,
        currentFolderId = folderId,
        folders = listOf(CloudFolder(id = ACME_ID, name = ACME)),
    )

    @Test
    fun `the meta's pending suggestion is read as the desktop writes it`() {
        stored = buildJsonObject {
            put("id", RECORDING)
            put("title", CLOCK_TITLE)
            put(PENDING, CloudJson.parseToJsonElement(PENDING_JSON))
        }
        assertEquals(SUGGESTION, RecordingMeta(stored).filingSuggestion)
        assertNull("a cleared one is none", RecordingMeta(stored).withFilingAnswered().filingSuggestion)
    }

    @Test
    fun `a pending suggestion is offered without a pass`() {
        assertTrue(model.present(pending(), FilingTarget.Cloud(RECORDING)))

        assertEquals(FilingPhase.OFFERING, state.phase)
        assertEquals(RENEWAL, state.editableTitle)
        assertEquals(ACME_ID, state.proposedFolder?.folderId)
        assertEquals("no model call spent on it", 0, count(CHAT))
    }

    @Test
    fun `accepting a pending suggestion clears it for the desktop`() {
        model.present(pending(), FilingTarget.Cloud(RECORDING))
        assertTrue(runBlocking { model.acceptSuggested() })

        assertEquals(RENEWAL, lastMeta().title)
        assertEquals(ACME_ID, lastMeta().folderId)
        assertTrue(lastMeta().filingSuggested)
        assertEquals("answered, so the Mac does not ask again", JsonNull, lastMeta().raw[PENDING])
        assertFalse(state.hasSomethingToOffer)
    }

    @Test
    fun `a rename alone says renamed and keeps the folders on offer`() {
        model.present(pending(), FilingTarget.Cloud(RECORDING))
        assertTrue(runBlocking { model.apply(TYPED, null) })

        assertTrue(state.showsRenamed)
        assertNull(state.proposedTitle)
        assertEquals(TYPED, state.editableTitle)
        assertTrue(state.hasSomethingToOffer)
    }

    @Test
    fun `a said-no offer is not presented again`() {
        model.present(pending(), FilingTarget.Cloud(RECORDING))
        model.forget()
        assertFalse("a reload racing Skip's write", model.present(pending(), FilingTarget.Cloud(RECORDING)))
        assertFalse(state.hasSomethingToOffer)
    }

    @Test
    fun `an offer being answered is not replaced by a fuller folder list`() {
        model.present(pending(), FilingTarget.Cloud(RECORDING))
        runBlocking { model.apply(TYPED, null) }
        assertFalse(model.present(pending(), FilingTarget.Cloud(RECORDING)))
        assertEquals(TYPED, state.currentTitle)
    }

    @Test
    fun `the sample is renamed and filed on the phone, and answered once both halves are`() {
        val sample = FakeSample()
        model.present(pending(), FilingTarget.Sample(sample))

        assertTrue(runBlocking { model.apply(TYPED, null) })
        assertEquals(listOf(TYPED), sample.titles)
        assertEquals("the folder half is still open", 0, sample.answered)

        assertTrue(runBlocking { model.apply(null, FolderTarget.Existing(ACME_ID)) })
        assertEquals(listOf<String?>(ACME_ID), sample.folders)
        assertEquals(1, sample.answered)
        assertTrue("nothing pushed to the cloud for a local recording", pushes.isEmpty())
    }

    @Test
    fun `a new folder for the sample is a real folder in the cloud`() {
        val sample = FakeSample()
        model.present(pending(), FilingTarget.Sample(sample))
        assertTrue(runBlocking { model.apply(null, FolderTarget.New("Globex")) })

        assertEquals(1, count("POST /folders"))
        assertEquals(1, sample.folders.size)
    }

    @Test
    fun `skipping the sample answers it without touching the cloud`() {
        val sample = FakeSample()
        model.present(pending(), FilingTarget.Sample(sample))
        runBlocking { model.markAnswered(model.forget()!!) }

        assertEquals(1, sample.answered)
        assertTrue(paths.isEmpty())
    }

    // ── the card's actions ───────────────────────────────────────────────────

    @Test
    fun `accept takes the name as the field shows it and the first chip`() {
        model.present(pending(), FilingTarget.Cloud(RECORDING))
        runBlocking {
            FilingCardController(model, this, this).accept(" $TYPED ")
        }
        assertEquals(1, pushes.size)
        assertEquals(TYPED, lastMeta().title)
        assertEquals(ACME_ID, lastMeta().folderId)
    }

    @Test
    fun `a chip files without renaming, and tells the screen`() {
        model.present(pending(), FilingTarget.Cloud(RECORDING))
        var written = 0
        runBlocking {
            FilingCardController(model, this, this, onWritten = { written++ }).file(SUGGESTION.folders.first())
        }
        assertEquals(CLOCK_TITLE, lastMeta().title)
        assertEquals(ACME_ID, lastMeta().folderId)
        assertEquals(1, written)
        assertEquals("the name is still on offer", RENEWAL, state.proposedTitle)
    }

    @Test
    fun `skip closes the picker and writes the answer behind the card`() {
        model.present(pending(), FilingTarget.Cloud(RECORDING))
        runBlocking {
            val card = FilingCardController(model, this, this)
            card.openPicker()
            card.skip()
            assertFalse(card.cues.choosing.value)
        }
        assertEquals(FilingPhase.SETTLED, state.phase)
        assertTrue(lastMeta().filingSuggested)
    }

    @Test
    fun `a wash lasts as long as it was asked for`() = runBlocking {
        val cues = FilingCardCues(this)
        cues.wash(durationMs = 10)
        assertTrue(cues.washed.value)
        delay(50)
        assertFalse(cues.washed.value)
    }

    /** The sample's store, as far as filing is concerned. */
    private class FakeSample : SampleFilingTarget {
        val titles = mutableListOf<String>()
        val folders = mutableListOf<String?>()
        var answered = 0

        override suspend fun pendingFilingSuggestion(folders: List<CloudFolder>) = if (answered == 0) SUGGESTION else null

        override suspend fun setTitle(title: String) {
            titles += title
        }

        override suspend fun setFolder(folderId: String?) {
            folders += folderId
        }

        override suspend fun answerSuggestion() {
            answered++
        }
    }

    private companion object {
        const val PENDING = "filingSuggestion"
        const val PENDING_JSON = """{"title":"Acme renewal terms","folders":[""" +
            """{"folderId":"f-acme","name":"Acme Corp","reason":"customer"},""" +
            """{"folderId":null,"name":"","reason":"no name"}]}"""
        const val RECORDING = "rec-1"
        const val CLOCK_TITLE = "Meeting Sep 18, 2025, 3:20 PM"
        const val RENEWAL = "Acme renewal terms"
        const val TYPED = "Acme — my own name"
        const val ACME = "Acme Corp"
        const val ACME_ID = "f-acme"
        const val FOLDER_ID = "folderId"
        const val CHAT = "POST /v1/chat/completions"
        const val FOLDERS_JSON = """{"folders":[{"id":"f-acme","name":"Acme Corp"},{"id":"f-shared","name":"Sales","orgId":"org-1"}]}"""
        const val SUGGESTION_JSON =
            """{"title":"Acme renewal terms","folders":[{"name":"Acme Corp","isNew":false,"reason":"customer"}]}"""
        val SUGGESTION = com.pathors.parley.kit.FilingSuggestion(
            RENEWAL,
            listOf(FilingFolderSuggestion(ACME_ID, ACME, "customer")),
        )

        fun chatResponse(content: String): String =
            """{"choices":[{"message":{"role":"assistant","content":${CloudJson.encodeToString(String.serializer(), content)}}}]}"""
    }
}
