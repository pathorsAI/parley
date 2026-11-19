package com.pathors.parley.onboarding

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import com.pathors.parley.screenshot.DemoMode
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * What the onboarding wizard keeps between launches — iOS `OnboardingFlag`,
 * under the same keys.
 *
 * `SharedPreferences` rather than a DataStore for the reason
 * [LapCelebrations] gives: the root decides whether to cover the app with the
 * wizard in its first frame, and a suspend read would show the library for a
 * frame and then swap it out. Each value is mirrored into a [StateFlow] so the
 * UI recomposes when a step writes it.
 *
 * In demo mode every write goes to memory only, because a screenshot run
 * promises no residue; a demo route sets the step it shows explicitly.
 */
class OnboardingFlags internal constructor(private val preferences: SharedPreferences?) {

    private val _step = MutableStateFlow(preferences?.getString(STEP_KEY, null).orEmpty())

    /** The step to resume on (`OnboardingStep.key`), or empty. */
    val step: StateFlow<String> = _step.asStateFlow()

    private val _afterSignIn = MutableStateFlow(preferences?.getBoolean(AFTER_SIGN_IN_KEY, false) ?: false)

    /**
     * Set when sign-in starts from the wizard, cleared when the wizard is left.
     * Signed-in users from before this flow never see the rest of it.
     */
    val afterSignIn: StateFlow<Boolean> = _afterSignIn.asStateFlow()

    private val _completed = MutableStateFlow(preferences?.getBoolean(COMPLETED_KEY, false) ?: false)

    /** The wizard has been finished or skipped once on this device. */
    val completed: StateFlow<Boolean> = _completed.asStateFlow()

    private val _background = MutableStateFlow(preferences?.getString(BACKGROUND_KEY, null).orEmpty())

    /**
     * The speaker background (the desktop's `settings.userBackground`), seeded
     * by the microphone check and edited on the context step.
     */
    val background: StateFlow<String> = _background.asStateFlow()

    fun setStep(value: String) = write(_step, value) { putString(STEP_KEY, value) }

    fun setAfterSignIn(value: Boolean) = write(_afterSignIn, value) { putBoolean(AFTER_SIGN_IN_KEY, value) }

    fun setCompleted(value: Boolean) = write(_completed, value) { putBoolean(COMPLETED_KEY, value) }

    fun setBackground(value: String) = write(_background, value) { putString(BACKGROUND_KEY, value) }

    /** Leaving the wizard, by Skip or by one of the last screen's buttons. */
    fun finish() {
        setAfterSignIn(false)
        setCompleted(true)
        setStep("")
    }

    @Synchronized
    private fun <T> write(flow: MutableStateFlow<T>, value: T, put: SharedPreferences.Editor.() -> Unit) {
        flow.value = value
        if (!DemoMode.isActive) preferences?.edit { put() }
    }

    companion object {
        /** The iOS `UserDefaults` keys. */
        const val STEP_KEY = "onboarding.step"
        const val AFTER_SIGN_IN_KEY = "onboarding.afterSignIn"
        const val COMPLETED_KEY = "onboarding.completed"
        const val BACKGROUND_KEY = "onboarding.userBackground"

        private const val FILE = "parley_onboarding_flags"

        fun device(context: Context): OnboardingFlags =
            OnboardingFlags(context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE))

        /** A store that forgets — previews and tests. */
        fun inMemory(): OnboardingFlags = OnboardingFlags(null)
    }
}
