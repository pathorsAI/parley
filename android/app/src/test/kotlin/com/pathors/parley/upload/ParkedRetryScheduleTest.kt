package com.pathors.parley.upload

import com.pathors.parley.cloud.CloudJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val T0 = 1_800_000_000_000L
private const val HOUR_MS = 60L * 60L * 1_000L
private const val BAD_REQUEST = 400

/** When a parked upload is tried again on its own: 1 h, 6 h, 24 h, then by hand. */
class ParkedRetryScheduleTest {

    private fun refusedTimes(times: Int): ParkedUpload {
        var parked = ParkedUpload.first(BAD_REQUEST, T0)
        repeat(times - 1) { parked = parked.refusedAgain(BAD_REQUEST, T0) }
        return parked
    }

    @Test
    fun `the schedule is one hour, six hours, a day`() {
        assertEquals(T0 + HOUR_MS, ParkedRetrySchedule.nextRetryAtMs(refusedTimes(1)))
        assertEquals(T0 + 6 * HOUR_MS, ParkedRetrySchedule.nextRetryAtMs(refusedTimes(2)))
        assertEquals(T0 + 24 * HOUR_MS, ParkedRetrySchedule.nextRetryAtMs(refusedTimes(3)))
    }

    @Test
    fun `after the third retry it waits for a tap`() {
        val parked = refusedTimes(4)
        assertNull(ParkedRetrySchedule.nextRetryAtMs(parked))
        assertFalse(ParkedRetrySchedule.isDue(parked, Long.MAX_VALUE))
    }

    @Test
    fun `due exactly at the deadline and not a millisecond before`() {
        val parked = refusedTimes(1)
        assertFalse(ParkedRetrySchedule.isDue(parked, T0 + HOUR_MS - 1))
        assertTrue(ParkedRetrySchedule.isDue(parked, T0 + HOUR_MS))
    }

    @Test
    fun `the schedule is anchored on the latest refusal`() {
        val later = ParkedUpload.first(BAD_REQUEST, T0).refusedAgain(413, T0 + HOUR_MS)
        assertEquals(T0, later.firstRefusedAtMs)
        assertEquals(413, later.httpStatus)
        assertEquals(T0 + 7 * HOUR_MS, ParkedRetrySchedule.nextRetryAtMs(later))
    }

    @Test
    fun `the parking survives the manifest round trip`() {
        val pending = PendingUpload(
            id = "rec",
            title = "Meeting",
            startedAtMs = T0,
            durationMs = 1.0,
            parked = refusedTimes(2),
        )
        val json = CloudJson.encodeToString(PendingUpload.serializer(), pending)
        assertEquals(pending, CloudJson.decodeFromString(PendingUpload.serializer(), json))
    }

    @Test
    fun `a manifest from before parking reads as an ordinary pending upload`() {
        val json = """{"id":"rec","title":"Meeting","startedAtMs":1,"durationMs":1.0}"""
        assertNull(CloudJson.decodeFromString(PendingUpload.serializer(), json).parked)
    }
}
