package com.pathors.parley.dictionary

import com.pathors.parley.kit.CloudDictionaryEntry
import com.pathors.parley.kit.DictionaryPullResponse
import com.pathors.parley.kit.DictionaryPushResponse
import com.pathors.parley.kit.DictionarySyncTransport
import com.pathors.parley.kit.FileDictionarySyncStorage
import com.pathors.parley.kit.LexiconStore
import java.io.File
import java.io.IOException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

private const val USER = "u1"
private const val PULL = "pull"

/**
 * When the dictionary syncs — iOS `DictionarySyncModel`'s triggers: an account
 * becoming known, a debounced local edit, a throttled foreground — and that a
 * sign-out stops it.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DictionarySyncModelTest {

    @get:Rule
    val temporary = TemporaryFolder()

    private val cloud = RecordingCloud()
    private var clock = 1_000_000L

    private fun TestScope.model(store: LexiconStore = store()): DictionarySyncModel {
        val storage = FileDictionarySyncStorage(store, File(temporary.root, FileDictionarySyncStorage.FILE_NAME))
        val model = DictionarySyncModel(
            storage = storage,
            transport = cloud,
            scope = backgroundScope,
            now = { clock },
            log = {},
        )
        store.didSave = model::localChange
        return model
    }

    private fun store() = LexiconStore(File(temporary.root, LexiconStore.FILE_NAME)) { clock }

    @Test
    fun `an account syncs once when it becomes known, and sign-out goes idle`() = runTest {
        val model = model()
        model.accountChanged(USER)
        runCurrent()
        assertEquals(listOf(PULL), cloud.calls)
        assertTrue(model.active.value)
        assertTrue(model.status.value is DictionarySyncModel.Status.Synced)

        model.accountChanged(USER)
        runCurrent()
        assertEquals("the same account again is not a new one", 1, cloud.calls.size)

        model.accountChanged(null)
        assertFalse(model.active.value)
        assertEquals(DictionarySyncModel.Status.Idle, model.status.value)
        model.syncNow()
        runCurrent()
        assertEquals("nothing runs signed out", 1, cloud.calls.size)
    }

    @Test
    fun `foregrounding is throttled`() = runTest {
        val model = model()
        model.accountChanged(USER)
        runCurrent()
        model.foregrounded()
        runCurrent()
        assertEquals(1, cloud.calls.size)

        clock += DictionarySyncModel.FOREGROUND_INTERVAL_MS
        model.foregrounded()
        runCurrent()
        assertEquals(2, cloud.calls.size)
    }

    @Test
    fun `an edit goes up after the quiet period, a burst as one push`() = runTest {
        val store = store()
        val model = model(store)
        model.accountChanged(USER)
        runCurrent()

        store.addTerm("Parley")
        store.addTerm("Cerana")
        advanceTimeBy(DictionarySyncModel.DEBOUNCE_MS - 1)
        runCurrent()
        assertEquals(listOf(PULL), cloud.calls)

        advanceTimeBy(2)
        runCurrent()
        assertEquals(listOf(PULL, PULL, "push:Cerana,Parley"), cloud.calls)
    }

    @Test
    fun `a failed run says so and keeps the last sync time`() = runTest {
        cloud.offline = true
        val model = model()
        model.accountChanged(USER)
        runCurrent()
        assertEquals(DictionarySyncModel.Status.Failed(null), model.status.value)
    }
}

private class RecordingCloud : DictionarySyncTransport {
    val calls = mutableListOf<String>()
    var offline = false

    override suspend fun pullDictionary(since: Long?): DictionaryPullResponse {
        calls += PULL
        if (offline) throw IOException("offline")
        return DictionaryPullResponse(emptyList(), now = 1)
    }

    override suspend fun pushDictionary(entries: List<CloudDictionaryEntry>): DictionaryPushResponse {
        calls += "push:" + entries.joinToString(",") { it.phrase }
        return DictionaryPushResponse(entries)
    }
}
