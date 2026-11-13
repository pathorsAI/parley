package com.pathors.parley.meeting

import com.pathors.parley.kit.SttRelayClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

private const val TOKEN = "session-token"

/**
 * The personal dictionary reaches the live relay — a meeting's every leg and an
 * import — as the start frame's `hints.terms`, as iOS `MeetingRecorder` and
 * the desktop send it.
 */
class RecognitionHintsTest {
    private val terms = listOf("Parley", "Cerana")

    @Test
    fun `every meeting leg carries the dictionary`() {
        val first = meetingRelayOptions(TOKEN, leg = 0, timeOffsetMs = 0, hintTerms = terms)
        val reconnect = meetingRelayOptions(TOKEN, leg = 2, timeOffsetMs = 61_000, hintTerms = terms)

        assertEquals(terms, first.hintTerms)
        assertNull(first.idPrefix)
        assertEquals(terms, reconnect.hintTerms)
        assertEquals("${SttRelayClient.SOURCE}@2", reconnect.idPrefix)
        assertEquals(61_000L, reconnect.timeOffsetMs)
        assertEquals(SttRelayClient.Feature.MEETING, reconnect.feature)
        assertEquals(terms, SttRelayClient.startFrame(reconnect).hints?.terms)
    }

    @Test
    fun `an import carries the dictionary in the meeting bucket`() {
        val options = importRelayOptions(TOKEN, terms)
        assertEquals(terms, SttRelayClient.startFrame(options).hints?.terms)
        assertEquals(SttRelayClient.Feature.MEETING, options.feature)
    }

    @Test
    fun `an empty dictionary sends no hints at all`() {
        assertNull(SttRelayClient.startFrame(meetingRelayOptions(TOKEN, 0, 0, emptyList())).hints)
    }
}
