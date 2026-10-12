package com.pathors.parley.ime

import android.text.InputType

/**
 * Whether the field the keyboard is attached to may be dictated into.
 *
 * ## Why this file exists at all
 *
 * iOS never needed it: a custom keyboard is simply not offered a secure text
 * entry field, so `ParleyKeyboard` cannot reach a password even in principle.
 * Android takes the opposite position — an enabled input method is handed the
 * input connection for *every* field, password fields included, with no Full
 * Access gate to withhold and no per-field permission to ask for. The platform
 * gives us the capability and leaves the discipline to us, so the refusal has to
 * be written down, and it has to be written down somewhere a test can reach it.
 *
 * Android's IME security guidance asks for exactly this behaviour, and it is one
 * of the things Play review looks at on a keyboard, so [isPasswordField] is
 * deliberately a pure function of the `int` rather than a method on
 * [android.view.inputmethod.EditorInfo]: `EditorInfo` cannot be constructed in a
 * JVM unit test, an `int` can, and the whole point of this gate is that it is
 * verified rather than asserted. See `InputFieldGuardTest`.
 *
 * ## What "refuse" means here
 *
 * The microphone key is disabled and no capture can be started — not "the audio
 * is discarded afterwards". Nothing is recorded, nothing is streamed to the
 * relay, and nothing is sent to the polish endpoint, because the session never
 * begins. A session already running when focus moves to a password field is
 * cancelled by the input method (`ParleyInputMethodService.onStartInputView`),
 * which throws its composing text away rather than committing it.
 */
object InputFieldGuard {

    /**
     * True when [inputType] describes a password field in any of the four
     * flavours Android has for one.
     *
     * The variation bits are only meaningful within a class, so the class is
     * checked first: `TYPE_NUMBER_VARIATION_PASSWORD` (0x10) and
     * `TYPE_TEXT_VARIATION_URI` (0x10) are the same bits, and a URL bar is not a
     * password field. Reading the variation without the class is how a guard like
     * this quietly starts refusing the wrong fields and allowing the right ones.
     *
     * `TYPE_TEXT_VARIATION_WEB_PASSWORD` is included even though it is not in
     * the three names the platform guidance lists: it is what a browser reports
     * for an `<input type="password">`, which is the single most common password
     * field on the device. Leaving it out would be a hole in the shape of the web.
     */
    fun isPasswordField(inputType: Int): Boolean {
        val variation = inputType and InputType.TYPE_MASK_VARIATION
        return when (inputType and InputType.TYPE_MASK_CLASS) {
            InputType.TYPE_CLASS_TEXT ->
                variation == InputType.TYPE_TEXT_VARIATION_PASSWORD ||
                    variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD ||
                    variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD

            InputType.TYPE_CLASS_NUMBER ->
                variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD

            else -> false
        }
    }

    /**
     * Whether the microphone key should be live for a field of this [inputType].
     *
     * Null means there is no field — `onStartInputView` was handed no
     * `EditorInfo`, which happens when the keyboard is shown without an editor
     * behind it. [InputType.TYPE_NULL] means the field exists but accepts no text
     * (a read-only or non-editing view). Dictating into either does nothing at
     * all, so the key is dark for both for the same reason it is dark for a
     * password: there is nowhere for the words to go.
     */
    fun allowsDictation(inputType: Int?): Boolean =
        inputType != null &&
            inputType != InputType.TYPE_NULL &&
            !isPasswordField(inputType)
}
