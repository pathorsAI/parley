package com.pathors.parley.upload

import com.pathors.parley.cloud.CloudJson
import com.pathors.parley.cloud.RecordingMeta
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The name and folder chosen on the record screen ride the upload, so the
 * filing pass never proposes over a typed name or second-guesses a picked
 * folder — iOS `MeetingUploader.PendingUpload.namedByUser` / `filedByUser`.
 */
class MeetingUploaderChoicesTest {

    private fun pending(named: Boolean, filed: Boolean) = PendingUpload(
        id = "rec-1",
        title = "Acme QBR",
        startedAtMs = 1_700_000_000_000,
        durationMs = 60_000.0,
        folderId = "f-acme".takeIf { filed },
        namedByUser = named,
        filedByUser = filed,
    )

    private fun flag(meta: RecordingMeta) = meta.raw["filingSuggested"]

    @Test
    fun `named and filed marks the pass spent, so no device runs one`() {
        val meta = MeetingUploader.buildMeta(pending(named = true, filed = true))
        assertEquals(JsonPrimitive(true), flag(meta))
        assertTrue(meta.filingSuggested)
    }

    @Test
    fun `one half answered still leaves the other half to ask`() {
        assertNull(flag(MeetingUploader.buildMeta(pending(named = true, filed = false))))
        assertNull(flag(MeetingUploader.buildMeta(pending(named = false, filed = true))))
        assertNull(flag(MeetingUploader.buildMeta(pending(named = false, filed = false))))
    }

    @Test
    fun `a manifest written before the flags existed reads as neither`() {
        val old = """{"id":"rec-1","title":"Meeting","startedAtMs":1,"durationMs":2.0}"""
        val decoded = CloudJson.decodeFromString(PendingUpload.serializer(), old)
        assertFalse(decoded.namedByUser)
        assertFalse(decoded.filedByUser)
    }

    @Test
    fun `the flags survive the manifest round trip`() {
        val written = CloudJson.encodeToString(PendingUpload.serializer(), pending(named = true, filed = true))
        val read = CloudJson.decodeFromString(PendingUpload.serializer(), written)
        assertTrue(read.namedByUser)
        assertTrue(read.filedByUser)
    }

    @Test
    fun `a draft's context lands in the meta's meetingContext`() {
        val fromDraft = pending(named = true, filed = false).copy(meetingContext = "Renewal with Acme.\nThey want a discount.")
        assertEquals(
            JsonPrimitive("Renewal with Acme.\nThey want a discount."),
            MeetingUploader.buildMeta(fromDraft).raw["meetingContext"],
        )
        // Started from the record button: the key is still there, empty.
        assertEquals(JsonPrimitive(""), MeetingUploader.buildMeta(pending(named = false, filed = false)).raw["meetingContext"])
    }

    @Test
    fun `the context survives the manifest, and an old manifest reads as none`() {
        val written = CloudJson.encodeToString(
            PendingUpload.serializer(),
            pending(named = true, filed = true).copy(meetingContext = "Renewal with Acme."),
        )
        assertEquals("Renewal with Acme.", CloudJson.decodeFromString(PendingUpload.serializer(), written).meetingContext)
        val old = """{"id":"rec-1","title":"Meeting","startedAtMs":1,"durationMs":2.0}"""
        assertEquals("", CloudJson.decodeFromString(PendingUpload.serializer(), old).meetingContext)
    }
}
