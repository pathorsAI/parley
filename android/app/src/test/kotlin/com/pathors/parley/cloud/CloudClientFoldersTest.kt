package com.pathors.parley.cloud

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Folders, organizations and the two ways a recording changes hands, on the
 * wire. These are the shapes iOS `CloudClient` and the desktop already send;
 * a drift here is a recording filed on the phone that the Mac never sees.
 */
class CloudClientFoldersTest {
    private val server = MockWebServer()

    private fun client() = CloudClient(
        baseUrl = server.url("/").toString(),
        tokenProvider = { "session-token" },
    )

    private fun ok(body: String = "{}") =
        server.enqueue(MockResponse().setResponseCode(200).setBody(body))

    private fun bodyOf(request: okhttp3.mockwebserver.RecordedRequest): JsonObject =
        CloudJson.parseToJsonElement(request.body.readUtf8()).jsonObject

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `lists personal folders`() = runBlocking {
        ok("""{"folders":[{"id":"f1","name":"Renewals","orgId":null,"createdAt":1700000000000}]}""")

        val folders = client().listFolders()

        assertEquals("/folders", server.takeRequest().path)
        assertEquals(listOf("f1"), folders.map { it.id })
        assertNull(folders.single().orgId)
    }

    @Test
    fun `creating a folder sends the client-minted id`() = runBlocking {
        ok("""{"ok":true}""")

        val folder = client().createFolder("Northwind", id = "fixed-id", createdAtMs = 1_700_000_000_000)

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/folders", request.path)
        val body = bodyOf(request)
        assertEquals("fixed-id", body["id"]!!.jsonPrimitive.content)
        assertEquals("Northwind", body["name"]!!.jsonPrimitive.content)
        assertEquals("1700000000000", body["createdAt"]!!.jsonPrimitive.content)
        // No envelope came back, so the folder is the one that was asked for.
        assertEquals("fixed-id", folder.id)
        assertEquals("Northwind", folder.name)
    }

    @Test
    fun `a folder envelope in the response wins`() = runBlocking {
        ok("""{"folder":{"id":"fixed-id","name":"Northwind Ltd"}}""")

        val folder = client().createFolder("Northwind", id = "fixed-id")

        assertEquals("Northwind Ltd", folder.name)
    }

    @Test
    fun `orgs mine is a bare array with roles`() = runBlocking {
        ok("""[{"id":"o1","name":"Sales","slug":"sales","role":"admin"},{"id":"o2","name":"Ops"}]""")

        val orgs = client().myOrgs()

        assertEquals("/orgs/mine", server.takeRequest().path)
        assertEquals(listOf("o1", "o2"), orgs.map { it.id })
        assertEquals(OrgRole.ADMIN, orgs[0].role)
        assertNull(orgs[1].role)
    }

    @Test
    fun `an orgs response that is not an array reads as none`() = runBlocking {
        ok("""{"error":"weird"}""")

        assertTrue(client().myOrgs().isEmpty())
    }

    @Test
    fun `org library, meta and folders use the org paths`() = runBlocking {
        ok("""{"recordings":[{"id":"r1","title":"T","source":"live","createdAt":1,"durationMs":2,"hasAudio":true,"folderId":"of1"}]}""")
        ok("""{"id":"r1","title":"T"}""")
        ok("""{"folders":[{"id":"of1","name":"Pipeline","orgId":"o1"}]}""")
        val cloud = client()

        val recordings = cloud.orgRecordings("o1")
        val meta = cloud.orgRecordingMeta("o1", "r1")
        val folders = cloud.orgFolders("o1")

        assertEquals("/orgs/o1/recordings", server.takeRequest().path)
        assertEquals("/orgs/o1/recordings/r1/meta", server.takeRequest().path)
        assertEquals("/orgs/o1/folders", server.takeRequest().path)
        assertEquals("of1", recordings.single().folderId)
        assertEquals("r1", meta.id)
        assertEquals("o1", folders.single().orgId)
    }

    @Test
    fun `an org folder move is a PATCH, and the root is an explicit null`() = runBlocking {
        ok()
        ok()
        val cloud = client()

        cloud.moveOrgRecordingToFolder("o1", "r1", "of1")
        cloud.moveOrgRecordingToFolder("o1", "r1", null)

        val into = server.takeRequest()
        assertEquals("PATCH", into.method)
        assertEquals("/orgs/o1/recordings/r1/folder", into.path)
        assertEquals(JsonPrimitive("of1"), bodyOf(into)["folderId"])
        val out = bodyOf(server.takeRequest())
        assertTrue("folderId must be present", out.containsKey("folderId"))
        assertEquals(JsonNull, out["folderId"])
    }

    @Test
    fun `sharing posts the org and, only when given, the folder`() = runBlocking {
        ok()
        ok()
        val cloud = client()

        cloud.shareRecording("r1", "o1", "of1")
        cloud.shareRecording("r1", "o1")

        val withFolder = server.takeRequest()
        assertEquals("POST", withFolder.method)
        assertEquals("/recordings/r1/share", withFolder.path)
        val body = bodyOf(withFolder)
        assertEquals("o1", body["orgId"]!!.jsonPrimitive.content)
        assertEquals("of1", body["folderId"]!!.jsonPrimitive.content)
        assertFalse(bodyOf(server.takeRequest()).containsKey("folderId"))
    }

    @Test
    fun `deleting an org recording someone else uploaded is a 403, not a sign-out`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(403).setBody("""{"error":"forbidden"}"""))

        val error = runCatching { client().deleteOrgRecording("o1", "r1") }.exceptionOrNull()

        val request = server.takeRequest()
        assertEquals("DELETE", request.method)
        assertEquals("/orgs/o1/recordings/r1", request.path)
        assertTrue((error as CloudException).isForbidden)
    }

    /**
     * A personal move re-reads the meta and re-pushes it whole: every field the
     * desktop wrote has to survive, and the folder has to change in both halves.
     */
    @Test
    fun `refiling re-pushes the fresh meta with the new folder`() = runBlocking {
        ok("""{"id":"r1","title":"Renewal","source":"live","createdAt":1,"durationMs":2000,"brief":"keep me","folderId":"old"}""")
        ok("""{"ok":true,"updatedAt":5}""")
        val summary = RecordingSummary(
            id = "r1", title = "Renewal", source = "live", createdAt = 1.0, durationMs = 2000.0,
            hasAudio = true, folderId = "old", updatedAt = 4.0,
        )

        client().refileRecording("r1", "new", summary)

        assertEquals("/recordings/r1/meta", server.takeRequest().path)
        val push = server.takeRequest()
        assertEquals("POST", push.method)
        assertEquals("/recordings/r1", push.path)
        val body = bodyOf(push)
        val meta = body["meta"]!!.jsonObject
        val card = body["summary"]!!.jsonObject
        assertEquals("new", meta["folderId"]!!.jsonPrimitive.content)
        assertEquals("keep me", meta["brief"]!!.jsonPrimitive.content)
        assertEquals("new", card["folderId"]!!.jsonPrimitive.content)
        assertFalse("the server's write clock is not echoed back", card.containsKey("updatedAt"))
    }

    @Test
    fun `un-filing says null out loud in both halves`() = runBlocking {
        ok("""{"id":"r1","title":"Renewal","source":"live","createdAt":1,"durationMs":2000,"folderId":"old"}""")
        ok("""{"ok":true}""")

        client().refileRecording("r1", null)

        server.takeRequest()
        val body = bodyOf(server.takeRequest())
        assertEquals(JsonNull, body["meta"]!!.jsonObject["folderId"])
        assertEquals(JsonNull, body["summary"]!!.jsonObject["folderId"])
    }
}
