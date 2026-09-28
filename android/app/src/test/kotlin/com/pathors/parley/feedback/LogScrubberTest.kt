package com.pathors.parley.feedback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What a report's log must never carry: session tokens, email addresses, and
 * the names of files the user picked. And what it must keep, because a report
 * without it is useless: recording ids, status codes, class names.
 */
class LogScrubberTest {

    @Test
    fun `a bearer token is taken out`() {
        val out = LogScrubber.scrub("GET /me with Authorization: Bearer abcDEF123.456-xyz_789")

        assertFalse(out, out.contains("abcDEF123"))
        assertTrue(out, out.contains("Bearer <redacted>"))
    }

    @Test
    fun `a token in a callback URL is taken out`() {
        val out = LogScrubber.scrub("handling parley://auth-callback?token=s3cr3t-value&next=home")

        assertFalse(out, out.contains("s3cr3t"))
        assertTrue(out, out.contains("token=<redacted>"))
        assertTrue("the rest of the URL is kept", out.contains("next=home"))
    }

    @Test
    fun `email addresses are replaced`() {
        val out = LogScrubber.scrub("signed in as jack.chen+test@pathors.com, org owner")

        assertEquals("signed in as <email>, org owner", out)
    }

    @Test
    fun `a picked file's name in a content URI is taken out, its provider kept`() {
        val out = LogScrubber.scrub(
            "no duration for content://com.android.providers.downloads.documents/document/raw%3A%2Fstorage%2FBoard%20meeting.m4a: bad",
        )

        assertFalse(out, out.contains("Board"))
        assertTrue(out, out.contains("content://com.android.providers.downloads.documents/<redacted>"))
        assertTrue(out, out.endsWith(": bad"))
    }

    @Test
    fun `a shared-storage path is taken out`() {
        val out = LogScrubber.scrub("could not delete /storage/emulated/0/Download/Acme pitch.ogg")

        assertFalse(out, out.contains("Acme"))
    }

    @Test
    fun `a long opaque token with no label is still taken out`() {
        val token = "Zx8Q2mN4pL7vR1sT9wY3bC6dF0gH5jK2"
        val out = LogScrubber.scrub("session $token rejected")

        assertEquals("session <redacted> rejected", out)
    }

    @Test
    fun `recording ids, status codes and class names survive`() {
        val line = "upload of 3f2a9c1e-7b4d-4e8f-9a0b-1c2d3e4f5a6b failed: CloudException(status=503) " +
            "relay close code=1006 at com.pathors.parley.upload.MeetingUploader.drain"

        assertEquals(line, LogScrubber.scrub(line))
    }

    @Test
    fun `the empty string is left alone`() {
        assertEquals("", LogScrubber.scrub(""))
    }
}
