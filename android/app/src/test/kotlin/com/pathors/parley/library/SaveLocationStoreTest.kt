package com.pathors.parley.library

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The "Default save location" setting: its stored form, which is the one the
 * desktop and iOS pickers use as their tag, and that it survives a restart of
 * the store the way a setting has to.
 */
class SaveLocationStoreTest {

    @get:Rule
    val temporary = TemporaryFolder()

    private val scopes = mutableListOf<CoroutineScope>()

    @After
    fun tearDown() {
        scopes.forEach { it.cancel() }
    }

    /** A store backed by [file]. A second store on the same file is a relaunch. */
    private fun store(file: File): SaveLocationStore {
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob()).also { scopes += it }
        return SaveLocationStore(
            PreferenceDataStoreFactory.create(scope = scope, produceFile = { file }),
        )
    }

    @Test
    fun `encodes the four shapes the desktop picker uses`() {
        assertEquals("personal", SaveDestination.PERSONAL_ROOT.encode())
        assertEquals("personal:f1", SaveDestination(folderId = "f1").encode())
        assertEquals("org:o1", SaveDestination(orgId = "o1").encode())
        assertEquals("org:o1:of1", SaveDestination(orgId = "o1", folderId = "of1").encode())
    }

    @Test
    fun `decodes what it encodes`() {
        listOf(
            SaveDestination.PERSONAL_ROOT,
            SaveDestination(folderId = "f1"),
            SaveDestination(orgId = "o1"),
            SaveDestination(orgId = "o1", folderId = "of1"),
        ).forEach { destination ->
            assertEquals(destination, SaveDestination.decode(destination.encode()))
        }
    }

    /** No choice yet, or a value from some future version, is the personal root. */
    @Test
    fun `anything unreadable is the personal root`() {
        listOf(null, "", "   ", "team:x", "org:", "org").forEach { raw ->
            assertEquals(raw.toString(), SaveDestination.PERSONAL_ROOT, SaveDestination.decode(raw))
        }
    }

    /** The folder means a personal folder or an org folder, never both. */
    @Test
    fun `an org destination files nothing personally`() {
        val org = SaveDestination(orgId = "o1", folderId = "of1")
        assertTrue(org.isOrg)
        assertNull(org.personalFolderId)
        assertEquals("of1", org.orgFolderId)

        val personal = SaveDestination(folderId = "f1")
        assertFalse(personal.isOrg)
        assertEquals("f1", personal.personalFolderId)
        assertNull(personal.orgFolderId)
    }

    @Test
    fun `defaults to the personal root`() = runBlocking {
        assertEquals(SaveDestination.PERSONAL_ROOT, store(File(temporary.root, "a.preferences_pb")).current())
    }

    @Test
    fun `a choice survives a relaunch`() = runBlocking {
        val file = File(temporary.root, "b.preferences_pb")
        store(file).set(SaveDestination(orgId = "o1", folderId = "of1"))
        scopes.forEach { it.cancel() }
        scopes.clear()

        assertEquals(SaveDestination(orgId = "o1", folderId = "of1"), store(file).current())
    }

    @Test
    fun `going back to personal clears the choice`() = runBlocking {
        val store = store(File(temporary.root, "c.preferences_pb"))
        store.set(SaveDestination(folderId = "f1"))
        store.set(SaveDestination.PERSONAL_ROOT)

        assertEquals(SaveDestination.PERSONAL_ROOT, store.current())
    }
}
