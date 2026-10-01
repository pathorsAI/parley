package com.pathors.parley.feedback

import org.junit.Assert.assertEquals
import org.junit.Test

/** The device line of a report: the kind of phone, named once. */
class DeviceModelTest {

    @Test
    fun `the maker is prefixed unless the model already says it`() {
        assertEquals("samsung SM-S918B", DiagnosticsCollector.deviceModel("samsung", "SM-S918B"))
        assertEquals(PIXEL_8, DiagnosticsCollector.deviceModel("Google", "Pixel 8"))
        assertEquals(PIXEL_8, DiagnosticsCollector.deviceModel("Google", PIXEL_8))
        assertEquals("OnePlus", DiagnosticsCollector.deviceModel("OnePlus", ""))
    }

    private companion object {
        const val PIXEL_8 = "Google Pixel 8"
    }
}
