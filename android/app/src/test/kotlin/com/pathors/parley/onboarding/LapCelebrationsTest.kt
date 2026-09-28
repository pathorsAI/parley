package com.pathors.parley.onboarding

import com.pathors.parley.screenshot.DemoMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** The lap's finish bursts once per recording, under iOS's key, until the lap is reset. */
class LapCelebrationsTest {

    private val stored = mutableMapOf<String, Boolean>()

    private val celebrations = LapCelebrations(
        read = { stored[it] == true },
        write = { key, value -> stored[key] = value },
        clear = { stored.clear() },
    )

    @Before
    fun setUp() {
        DemoMode.disable()
    }

    @Test
    fun `the first finish on a recording bursts, and never again`() {
        assertTrue(celebrations.claim(SAMPLE))
        assertFalse(celebrations.claim(SAMPLE))
        assertTrue("another recording has its own", celebrations.claim(OTHER))
    }

    @Test
    fun `it is kept under the iOS key`() {
        celebrations.claim(SAMPLE)
        assertEquals(mapOf("lapMotion.celebrated.$SAMPLE" to true), stored)
    }

    @Test
    fun `starting the lap over plays the finish again`() {
        celebrations.claim(SAMPLE)
        celebrations.forgetAll()
        assertTrue(celebrations.claim(SAMPLE))
    }

    private companion object {
        const val SAMPLE = "sample-hongsheng"
        const val OTHER = "rec-1"
    }
}
