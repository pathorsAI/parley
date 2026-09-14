package com.pathors.parley.upload

import com.pathors.parley.cloud.RecordingSummary
import com.pathors.parley.cloud.TranscriptSegmentDto
import java.io.File
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The durability rules the backfill queue inherits from [PendingUploadQueue],
 * plus the one it does not: a manual request **copies** its audio, because the
 * file it is handed is the one the player on screen is reading from.
 */
class PendingBackfillQueueTest {

    @get:Rule
    val temporary = TemporaryFolder()

    private fun queue(name: String = "PendingBackfills") =
        PendingBackfillQueue(temporary.newFolder(name))

    private fun request(
        id: String,
        startedAtMs: Long = 1_700_000_000_000,
        manualRetries: Int = 0,
    ) = BackfillRequest(
        pending = PendingUpload(
            id = id,
            title = "Renewal terms",
            startedAtMs = startedAtMs,
            durationMs = 2_953_000.0,
            segments = listOf(
                TranscriptSegmentDto(id = "mix-0", text = "hello", startMs = 0, endMs = 60_000),
            ),
        ),
        manualRetries = manualRetries,
    )

    private fun audio(name: String, bytes: Int = 512): File =
        temporary.newFile(name).apply { writeBytes(ByteArray(bytes) { it.toByte() }) }

    @Test
    fun `the automatic path moves the audio, so only one queue ever owns it`() {
        // Two copies of an hour of meeting is the failure this prevents;
        // whichever of them was forgotten would be the one nothing cleans up.
        val queue = queue()
        val source = audio("incoming.ogg")

        queue.enqueueMoving(request("rec-1"), source)

        assertFalse("the source must not survive a move", source.exists())
        assertEquals(512L, queue.audioFile("rec-1").length())
        assertTrue(queue.has("rec-1"))
    }

    @Test
    fun `a hand-triggered request copies, because the player is reading that file`() {
        val queue = queue()
        val stored = audio("local-store.ogg")

        queue.enqueueCopying(request("rec-1", manualRetries = 1), stored)

        assertTrue("moving it would stop playback mid-sentence", stored.isFile)
        assertEquals(512L, stored.length())
        assertEquals(512L, queue.audioFile("rec-1").length())
    }

    @Test
    fun `a request round-trips everything the re-push needs`() {
        val queue = queue()
        val summary = RecordingSummary(
            id = "rec-1",
            title = "Pricing call",
            source = "live",
            createdAt = 1_700_000_000_000.0,
            durationMs = 600_000.0,
            findingsCount = 4,
            hasAudio = true,
        )
        val original = request("rec-1", manualRetries = 2).copy(
            folderId = "folder-9",
            existingMeta = buildJsonObject {
                put("id", "rec-1")
                put("brief", "only the desktop writes this")
            },
            existingSummary = summary,
        )

        queue.enqueueCopying(original, audio("a.ogg"))
        val read = queue.request("rec-1")

        assertEquals(original, read)
        assertEquals(4, read?.existingSummary?.findingsCount)
        assertEquals("rec-1", read?.existingRecordingMeta()?.id)
        assertTrue(read!!.isManual)
    }

    @Test
    fun `a second request for the same recording replaces the first`() {
        // There is one audio file and one manifest per id, so an automatic
        // backfill and a re-run somebody asked for cannot race each other.
        val queue = queue()
        queue.enqueueMoving(request("rec-1"), audio("first.ogg"))

        queue.enqueueCopying(request("rec-1", manualRetries = 1), audio("second.ogg", bytes = 64))

        assertEquals(1, queue.count())
        assertEquals(1, queue.request("rec-1")?.manualRetries)
        assertEquals(64L, queue.audioFile("rec-1").length())
    }

    @Test
    fun `the queue runs oldest first`() {
        val queue = queue()
        queue.enqueueMoving(request("newer", startedAtMs = 2_000), audio("b.ogg"))
        queue.enqueueMoving(request("older", startedAtMs = 1_000), audio("a.ogg"))

        assertEquals(listOf("older", "newer"), queue.list().map { it.id })
    }

    @Test
    fun `a manifest that will not parse is skipped rather than thrown`() {
        // A truncated write, or a format from a build that has since been rolled
        // back. One unreadable entry must not hide the rest of the queue.
        val queue = queue()
        queue.enqueueMoving(request("good"), audio("good.ogg"))
        queue.manifestFile("broken").writeText("{ this is not json")

        assertEquals(listOf("good"), queue.list().map { it.id })
        assertNull(queue.request("broken"))
    }

    @Test
    fun `removing the manifest leaves the audio for the caller to retire`() {
        // A finished run decides what happens to the Ogg on the same terms as
        // any upload's — keep it on the phone, or delete it — so the queue must
        // not make that decision for it.
        val queue = queue()
        queue.enqueueMoving(request("rec-1"), audio("a.ogg"))

        queue.removeManifest("rec-1")

        assertFalse(queue.has("rec-1"))
        assertTrue(queue.audioFile("rec-1").isFile)
    }

    @Test
    fun `removing a recording takes its audio with it`() {
        val queue = queue()
        queue.enqueueMoving(request("rec-1"), audio("a.ogg"))

        queue.remove("rec-1")

        assertEquals(0, queue.count())
        assertFalse(queue.audioFile("rec-1").exists())
        assertEquals(0L, queue.bytesOnDisk())
    }

    @Test
    fun `clearing drops everything, because account deletion promised it would`() {
        val queue = queue()
        queue.enqueueMoving(request("rec-1"), audio("a.ogg"))
        queue.enqueueMoving(request("rec-2"), audio("b.ogg"))

        queue.clear()

        assertEquals(0, queue.count())
        assertEquals(0L, queue.bytesOnDisk())
    }

    @Test
    fun `an empty queue answers without a directory existing`() {
        // Nothing creates the directory until the first enqueue, and every
        // reader runs before that on a fresh install.
        val queue = PendingBackfillQueue(File(temporary.root, "never-created"))

        assertEquals(0, queue.count())
        assertEquals(emptyList<BackfillRequest>(), queue.list())
        assertEquals(0L, queue.bytesOnDisk())
        assertFalse(queue.has("rec-1"))
    }

    @Test
    fun `a manifest that cannot be written gives the audio back`() {
        // The one way this queue could leak an hour of audio: the move succeeds,
        // the manifest write fails, and the Ogg is left where `list()` cannot
        // see it and nothing will ever clean it up. A file where the directory
        // should be is the closest a unit test gets to a full disk.
        val blocked = File(temporary.root, "blocked").apply { writeText("not a directory") }
        val queue = PendingBackfillQueue(blocked)
        val source = audio("incoming.ogg")

        val thrown = runCatching { queue.enqueueMoving(request("rec-1"), source) }.exceptionOrNull()

        assertTrue("$thrown", thrown != null)
        assertEquals(0, queue.count())
        assertFalse(queue.audioFile("rec-1").exists())
    }

    @Test
    fun `no temp file survives a manifest write`() {
        // The write is temp-file-plus-rename; a leftover `.json.tmp` would be
        // counted by bytesOnDisk forever and read by nothing.
        val queue = queue()
        queue.enqueueMoving(request("rec-1"), audio("a.ogg"))
        queue.writeManifest(request("rec-1", manualRetries = 1))

        val names = queue.manifestFile("rec-1").parentFile!!.list()!!.toList()
        assertEquals(listOf("rec-1.json", "rec-1.ogg"), names.sorted())
    }
}
