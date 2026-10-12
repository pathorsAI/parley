package com.pathors.parley.ime

import android.text.InputType
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The password refusal, verified rather than asserted.
 *
 * This is the test that matters most in the keyboard. iOS gets this behaviour
 * from the platform — a custom keyboard is simply never attached to a secure
 * field — whereas Android hands an enabled input method the input connection for
 * every field on the device and leaves the discipline to the app. So the promise
 * the keyboard makes to the user ("Parley never dictates into a password field")
 * is kept by [InputFieldGuard] and by nothing else, and it is the behaviour
 * Android's IME security guidance asks for and Play review looks at.
 *
 * It runs as a plain JVM test with no Robolectric because [InputFieldGuard] takes
 * the `int`, not an `EditorInfo`: `android.text.InputType`'s fields are
 * `static final int` and are inlined by the compiler, so nothing here touches the
 * Android runtime. That is the reason the function has the signature it does.
 */
class InputFieldGuardTest {

    // ── the four password flavours ───────────────────────────────────────────

    @Test
    fun `a text password field is refused`() {
        assertTrue(
            InputFieldGuard.isPasswordField(
                InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD,
            ),
        )
    }

    @Test
    fun `a visible password field is refused`() {
        // The "show password" variant. Visible to the user is not public to us.
        assertTrue(
            InputFieldGuard.isPasswordField(
                InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD,
            ),
        )
    }

    @Test
    fun `a web password field is refused`() {
        // What a browser reports for <input type="password"> — the most common
        // password field on the device, and the one the platform's own list of
        // three names leaves out.
        assertTrue(
            InputFieldGuard.isPasswordField(
                InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD,
            ),
        )
    }

    @Test
    fun `a numeric password field is refused`() {
        // A PIN pad.
        assertTrue(
            InputFieldGuard.isPasswordField(
                InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD,
            ),
        )
    }

    /** Flags ride in the same int and must not blind the check. */
    @Test
    fun `a password field is still refused with flags set`() {
        assertTrue(
            InputFieldGuard.isPasswordField(
                InputType.TYPE_CLASS_TEXT or
                    InputType.TYPE_TEXT_VARIATION_PASSWORD or
                    InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or
                    InputType.TYPE_TEXT_FLAG_MULTI_LINE,
            ),
        )
    }

    // ── everything else is allowed ───────────────────────────────────────────

    @Test
    fun `ordinary text fields are allowed`() {
        listOf(
            InputType.TYPE_CLASS_TEXT,
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_SHORT_MESSAGE,
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_LONG_MESSAGE,
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_SUBJECT,
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PERSON_NAME,
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE,
        ).forEach { inputType ->
            assertFalse(
                "inputType 0x${inputType.toString(16)} should be dictatable",
                InputFieldGuard.isPasswordField(inputType),
            )
            assertTrue(InputFieldGuard.allowsDictation(inputType))
        }
    }

    /**
     * The bug this guard is one bad refactor away from.
     *
     * `TYPE_TEXT_VARIATION_URI` and `TYPE_NUMBER_VARIATION_PASSWORD` are both
     * 0x10. Read the variation bits without checking the class first and a URL
     * bar becomes a password field — the guard then looks like it is working
     * while refusing the wrong fields.
     */
    @Test
    fun `a URI field is not mistaken for a numeric password`() {
        assertFalse(
            InputFieldGuard.isPasswordField(
                InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI,
            ),
        )
        assertTrue(
            "the two variations share their bits",
            InputType.TYPE_TEXT_VARIATION_URI == InputType.TYPE_NUMBER_VARIATION_PASSWORD,
        )
    }

    /** The mirror of the above: an ordinary number field is not a PIN pad. */
    @Test
    fun `a plain number field is allowed`() {
        assertFalse(InputFieldGuard.isPasswordField(InputType.TYPE_CLASS_NUMBER))
        assertTrue(InputFieldGuard.allowsDictation(InputType.TYPE_CLASS_NUMBER))
    }

    @Test
    fun `an email address field is allowed`() {
        val email = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
        assertFalse(InputFieldGuard.isPasswordField(email))
        assertTrue(InputFieldGuard.allowsDictation(email))
    }

    // ── allowsDictation, the question the keyboard actually asks ─────────────

    @Test
    fun `a password field does not allow dictation`() {
        assertFalse(
            InputFieldGuard.allowsDictation(
                InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD,
            ),
        )
        assertFalse(
            InputFieldGuard.allowsDictation(
                InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD,
            ),
        )
        assertFalse(
            InputFieldGuard.allowsDictation(
                InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD,
            ),
        )
        assertFalse(
            InputFieldGuard.allowsDictation(
                InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD,
            ),
        )
    }

    @Test
    fun `no field at all does not allow dictation`() {
        assertFalse("null EditorInfo", InputFieldGuard.allowsDictation(null))
    }

    @Test
    fun `a field that takes no text does not allow dictation`() {
        assertFalse(InputFieldGuard.allowsDictation(InputType.TYPE_NULL))
    }
}
