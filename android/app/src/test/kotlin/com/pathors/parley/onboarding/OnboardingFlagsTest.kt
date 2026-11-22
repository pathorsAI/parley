package com.pathors.parley.onboarding

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** "Re-run onboarding" and leaving the wizard, on the flags the root reads. */
class OnboardingFlagsTest {

    @Test
    fun aRerunCoversTheAppFromTheWelcome() {
        val flags = OnboardingFlags.inMemory()
        flags.finish()

        flags.startRerun()

        assertEquals("intro", flags.step.value)
        assertTrue(flags.rerun.value)
        assertTrue(flags.afterSignIn.value)
        assertFalse(flags.completed.value)
    }

    @Test
    fun leavingTheWizardEndsTheRerun() {
        val flags = OnboardingFlags.inMemory()
        flags.startRerun()

        flags.finish()

        assertFalse(flags.rerun.value)
        assertFalse(flags.afterSignIn.value)
        assertTrue(flags.completed.value)
        assertEquals("", flags.step.value)
    }

    @Test
    fun theRerunKeepsTheSpeakerBackground() {
        val flags = OnboardingFlags.inMemory()
        flags.setBackground("I design at Pathors.")

        flags.startRerun()

        assertEquals("I design at Pathors.", flags.background.value)
    }

    @Test
    fun theIntroKeyIsTheWizardsOwn() {
        assertEquals(
            com.pathors.parley.ui.OnboardingStep.INTRO.key,
            OnboardingFlags.INTRO_STEP,
        )
    }
}
