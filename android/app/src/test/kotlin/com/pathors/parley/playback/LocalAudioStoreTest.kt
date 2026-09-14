package com.pathors.parley.playback

import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The store is a directory with rules, and all three of them are the kind that
 * only bite in production: an id that is really a path, a peaks cache that
 * outlives the audio it describes, and a "move" that quietly copied instead.
 */
class LocalAudioStoreTest {

    @get:Rule
    val temporary = TemporaryFolder()

    private fun store(): LocalAudioStore = LocalAudioStore(temporary.newFolder("Audio"))

    private fun source(name: String, bytes: Int = 64): File =
        temporary.newFile(name).apply { writeBytes(ByteArray(bytes) { it.toByte() }) }

    @Test
    fun `put moves the file rather than copying it`() {
        val store = store()
        val incoming = source("incoming.ogg")

        assertTrue(store.put("rec-1", incoming))

        assertTrue(store.has("rec-1"))
        assertFalse("the source should be gone — two copies is the bug", incoming.exists())
        assertEquals(64L, store.audioFile("rec-1").length())
    }

    @Test
    fun `put over an existing recording replaces it`() {
        val store = store()
        store.put("rec-1", source("first.ogg", bytes = 10))
        store.put("rec-1", source("second.ogg", bytes = 99))

        assertEquals(99L, store.audioFile("rec-1").length())
        assertEquals(1, store.count())
    }

    @Test
    fun `putting a file that is not there fails rather than creating an empty one`() {
        val store = store()
        assertFalse(store.put("rec-1", File(temporary.root, "never-existed.ogg")))
        assertFalse(store.has("rec-1"))
    }

    @Test
    fun `a file already in its final place is left alone`() {
        val store = store()
        store.put("rec-1", source("incoming.ogg"))
        val destination = store.audioFile("rec-1")

        assertTrue(store.put("rec-1", destination))
        assertTrue(destination.isFile)
        assertEquals(64L, destination.length())
    }

    @Test
    fun `an id that is a path stays inside the store`() {
        val store = store()
        store.put("../escaped", source("incoming.ogg"))

        assertFalse(File(temporary.root, "escaped.ogg").exists())
        assertEquals(1, store.count())
        assertTrue(store.has("../escaped"))
    }

    @Test
    fun `peaks round trip through the cache file`() {
        val store = store()
        val overview = AudioPeaks.Overview(FloatArray(400) { it / 400f }, 61.5)

        store.putPeaks(overview, "rec-1")
        val read = store.peaks("rec-1")

        assertArrayEquals(overview.peaks, read!!.peaks, 0f)
    }

    @Test
    fun `a corrupt peaks cache reads as no cache`() {
        val store = store()
        store.putPeaks(AudioPeaks.Overview(FloatArray(4), 1.0), "rec-1")
        store.peaksFile("rec-1").writeText("garbage")

        assertNull(store.peaks("rec-1"))
    }

    @Test
    fun `removing a recording takes its waveform with it`() {
        val store = store()
        store.put("rec-1", source("incoming.ogg"))
        store.putPeaks(AudioPeaks.Overview(FloatArray(4) { 0.5f }, 1.0), "rec-1")

        store.remove("rec-1")

        assertFalse(store.has("rec-1"))
        assertFalse(
            "a stale waveform would be drawn over the next file to reuse this id",
            store.peaksFile("rec-1").exists(),
        )
    }

    @Test
    fun `the usage readout counts recordings and every byte on disk`() {
        val store = store()
        store.put("rec-1", source("a.ogg", bytes = 100))
        store.put("rec-2", source("b.ogg", bytes = 250))
        store.putPeaks(AudioPeaks.Overview(FloatArray(400), 10.0), "rec-1")

        assertEquals(2, store.count())
        // The peaks cache is on the phone too, so it is in the total.
        assertEquals(100L + 250L + 16L + 400 * 4L, store.totalBytes())
    }

    @Test
    fun `remove all leaves nothing behind, not even the directory`() {
        val store = store()
        store.put("rec-1", source("a.ogg"))
        store.putPeaks(AudioPeaks.Overview(FloatArray(4), 1.0), "rec-1")

        store.removeAll()

        assertEquals(0, store.count())
        assertEquals(0L, store.totalBytes())
        assertFalse(store.has("rec-1"))
    }

    @Test
    fun `a store can be written to again after being emptied`() {
        val store = store()
        store.put("rec-1", source("a.ogg"))
        store.removeAll()

        assertTrue(store.put("rec-2", source("b.ogg")))
        assertTrue(store.has("rec-2"))
    }

    @Test
    fun `an empty store answers everything without a directory on disk`() {
        val store = LocalAudioStore(File(temporary.root, "never-created"))

        assertFalse(store.has("rec-1"))
        assertNull(store.peaks("rec-1"))
        assertEquals(0, store.count())
        assertEquals(0L, store.totalBytes())
    }

    // ------------------------------------------------------------ the naming

    @Test
    fun `an id that is a path cannot name a file outside the store`() {
        assertEquals("a-b-c", LocalAudioStore.fileName("a/b/c"))
        assertEquals("------etc-passwd", LocalAudioStore.fileName("../../etc/passwd"))
        assertEquals("-hidden", LocalAudioStore.fileName(".hidden"))
        assertEquals("unnamed", LocalAudioStore.fileName(""))
    }

    @Test
    fun `a real recording id passes through untouched`() {
        val id = "3f2b1c7e-9a04-4b6d-8f21-0c5e7d9a1b33"
        assertEquals(id, LocalAudioStore.fileName(id))
    }
}
