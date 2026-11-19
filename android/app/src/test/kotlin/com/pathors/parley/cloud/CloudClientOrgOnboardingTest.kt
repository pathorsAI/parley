package com.pathors.parley.cloud

import java.time.Instant
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The organization calls the onboarding's organization step makes — list my
 * invitations, accept one, create an org — on the wire, plus the slug rule the
 * create call depends on. Mirrors iOS `OrgOnboardingTests` and the desktop's
 * `src/lib/cloud/orgs.ts`.
 */
class CloudClientOrgOnboardingTest {
    private val server = MockWebServer()

    private fun client() = CloudClient(
        baseUrl = server.url("/").toString(),
        tokenProvider = { "session-token" },
    )

    private fun ok(body: String = "{}") =
        server.enqueue(MockResponse().setResponseCode(200).setBody(body))

    private fun bodyOf(request: RecordedRequest): JsonObject =
        CloudJson.parseToJsonElement(request.body.readUtf8()).jsonObject

    @After
    fun tearDown() {
        server.shutdown()
    }

    // ── slug ─────────────────────────────────────────────────────────────────

    @Test
    fun `a slug joins the ASCII words and appends the suffix`() {
        assertEquals("pathors-ai-taiwan-abc123", OrgSlug.make("Pathors AI Taiwan", suffix = "abc123"))
    }

    @Test
    fun `a name with no ASCII falls back to org`() {
        assertEquals("org-abc123", OrgSlug.make("派斯科技", suffix = "abc123"))
    }

    @Test
    fun `a mixed name keeps its ASCII part`() {
        assertEquals("pathors-2026-x", OrgSlug.make("派斯 Pathors 2026", suffix = "x"))
    }

    @Test
    fun `the slug base is capped at 32 characters`() {
        assertEquals("a".repeat(32) + "-s", OrgSlug.make("a".repeat(50), suffix = "s"))
    }

    @Test
    fun `the random suffix is six lower-case characters`() {
        val suffix = OrgSlug.randomSuffix()
        assertEquals(6, suffix.length)
        assertEquals(suffix.lowercase(), suffix)
    }

    // ── create ───────────────────────────────────────────────────────────────

    @Test
    fun `creating an org posts the trimmed name and a slug`() = runBlocking {
        ok("""{"id":"o-1","name":"Pathors","slug":"pathors-abc123","createdAt":"2026-11-18T00:00:00.000Z","members":[]}""")

        val org = client().createOrg("  Pathors  ")

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/auth/organization/create", request.path)
        assertTrue(request.getHeader("Content-Type").orEmpty().startsWith("application/json"))
        assertEquals("Bearer session-token", request.getHeader("Authorization"))
        val body = bodyOf(request)
        assertEquals("Pathors", body["name"]!!.jsonPrimitive.content)
        assertTrue(body["slug"]!!.jsonPrimitive.content.startsWith("pathors-"))
        assertEquals("o-1", org.id)
        assertEquals("Pathors", org.name)
        assertNull(org.role)
    }

    @Test(expected = CloudException::class)
    fun `a refused create throws`() {
        runBlocking {
            server.enqueue(
                MockResponse().setResponseCode(400)
                    .setBody("""{"code":"ORGANIZATION_ALREADY_EXISTS","message":"Organization already exists"}"""),
            )
            client().createOrg("Pathors")
        }
    }

    // ── invitations ──────────────────────────────────────────────────────────

    @Test
    fun `invitations read a bare array and drop the dead ones`() = runBlocking {
        ok(
            """
            [
              {"id":"i-live","organizationId":"o-1","organizationName":"Acme","role":"member",
               "status":"pending","expiresAt":"2030-01-01T00:00:00.000Z"},
              {"id":"i-expired","organizationId":"o-2","status":"pending","expiresAt":"2020-01-01T00:00:00Z"},
              {"id":"i-accepted","organizationId":"o-3","status":"accepted"}
            ]
            """.trimIndent(),
        )

        val invitations = client().myInvitations(now = Instant.parse("2026-11-18T00:00:00Z"))

        assertEquals("/auth/organization/list-user-invitations", server.takeRequest().path)
        assertEquals(listOf("i-live"), invitations.map { it.id })
        assertEquals("Acme", invitations.single().organizationName)
        assertEquals(OrgRole.MEMBER, invitations.single().role)
        assertEquals(
            Instant.parse("2030-01-01T00:00:00Z").toEpochMilli().toDouble(),
            invitations.single().expiresAtMs!!,
            0.0,
        )
    }

    @Test
    fun `invitations read the wrapped shape and epoch milliseconds`() = runBlocking {
        ok("""{"invitations":[{"id":"i-1","organizationId":"o-1","status":"pending","expiresAt":1900000000000}]}""")

        val invitations = client().myInvitations(now = Instant.ofEpochSecond(1_800_000_000))

        assertEquals(listOf("i-1"), invitations.map { it.id })
        assertNull(invitations.single().organizationName)
    }

    @Test
    fun `an invitation past its expiry at now is not offered`() = runBlocking {
        ok("""[{"id":"i-1","organizationId":"o-1","status":"pending","expiresAt":1900000000000}]""")

        val invitations = client().myInvitations(now = Instant.ofEpochMilli(1_900_000_000_001))

        assertTrue(invitations.isEmpty())
    }

    @Test
    fun `an unexpected invitations shape reads as none and a malformed row is dropped`() = runBlocking {
        ok("""{"error":"weird"}""")
        ok("""[{"organizationId":"o-1","status":"pending"},{"id":"i-2","organizationId":"o-2","status":"pending"}]""")
        val cloud = client()

        assertTrue(cloud.myInvitations().isEmpty())
        assertEquals(listOf("i-2"), cloud.myInvitations().map { it.id })
    }

    @Test
    fun `an ISO expiry with an offset is read`() {
        val obj = CloudJson.parseToJsonElement(
            """{"id":"i","organizationId":"o","status":"pending","expiresAt":"2030-01-01T08:00:00+08:00"}""",
        ).jsonObject
        val invitation = CloudInvitation.fromJson(obj)!!
        assertEquals(Instant.parse("2030-01-01T00:00:00Z").toEpochMilli().toDouble(), invitation.expiresAtMs!!, 0.0)
        assertTrue(invitation.isLive(Instant.parse("2029-12-31T23:59:59Z")))
        assertFalse(invitation.isLive(Instant.parse("2030-01-01T00:00:00Z")))
    }

    @Test
    fun `an unparseable expiry reads as none, so a pending invitation stays live`() {
        val obj = CloudJson.parseToJsonElement(
            """{"id":"i","organizationId":"o","status":"pending","expiresAt":"next tuesday"}""",
        ).jsonObject
        val invitation = CloudInvitation.fromJson(obj)!!
        assertNull(invitation.expiresAtMs)
        assertTrue(invitation.isLive())
    }

    // ── accept ───────────────────────────────────────────────────────────────

    @Test
    fun `accepting an invitation posts its id`() = runBlocking {
        ok("""{"invitation":{"id":"i-1"},"member":{"id":"m-1"}}""")

        client().acceptInvitation("i-1")

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/auth/organization/accept-invitation", request.path)
        assertEquals("i-1", bodyOf(request)["invitationId"]!!.jsonPrimitive.content)
    }
}
