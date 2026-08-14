package com.pathors.parley.cloud

import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `DELETE /me` on the wire, and how its failures are classified.
 *
 * The 409 case is the one that matters: the account-deletion UI branches on
 * [CloudException.ownsOrganizations] to tell the user to transfer their
 * organization first, and a regression that flattened it into a generic error
 * would leave them staring at "try again" for something retrying can never fix.
 */
class CloudClientDeleteAccountTest {
    private val server = MockWebServer()

    private fun client(unauthorized: AtomicInteger = AtomicInteger()): CloudClient =
        CloudClient(
            baseUrl = server.url("/").toString(),
            tokenProvider = { "session-token" },
            onUnauthorized = { unauthorized.incrementAndGet() },
        )

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `sends an authenticated DELETE to me`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))

        client().deleteAccount()

        val request = server.takeRequest()
        assertEquals("DELETE", request.method)
        assertEquals("/me", request.path)
        assertEquals("Bearer session-token", request.getHeader("Authorization"))
    }

    @Test
    fun `409 owned_organizations is its own typed refusal`() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(409).setBody(
                """
                {"error":"owned_organizations",
                 "organizations":[{"id":"org_1","name":"Pathors"}],
                 "message":"Delete or transfer owned organizations before deleting this account."}
                """.trimIndent()
            )
        )

        val error = runCatching { client().deleteAccount() }.exceptionOrNull()

        val cloudError = error as CloudException
        assertEquals(409, cloudError.status)
        assertEquals(CloudException.OWNED_ORGANIZATIONS, cloudError.code)
        assertTrue(cloudError.ownsOrganizations)
        // Retrying can never clear this — the organization has to go first.
        assertFalse(cloudError.isRetryable)
    }

    @Test
    fun `an unrelated 409 is not the organization refusal`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":"conflict"}"""))

        val error = runCatching { client().deleteAccount() }.exceptionOrNull() as CloudException

        assertEquals(409, error.status)
        assertFalse(error.ownsOrganizations)
    }

    @Test
    fun `a 401 clears the session and is not the organization refusal`() = runBlocking {
        val unauthorized = AtomicInteger()
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"code":"unauthorized"}"""))

        val error = runCatching { client(unauthorized).deleteAccount() }
            .exceptionOrNull() as CloudException

        assertTrue(error.isAuthExpired)
        assertFalse(error.ownsOrganizations)
        assertEquals(1, unauthorized.get())
    }

    @Test
    fun `a server fault stays retryable`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(503))

        val error = runCatching { client().deleteAccount() }.exceptionOrNull() as CloudException

        assertTrue(error.isRetryable)
        assertFalse(error.ownsOrganizations)
    }
}
