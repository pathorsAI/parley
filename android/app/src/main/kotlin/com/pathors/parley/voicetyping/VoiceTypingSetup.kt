package com.pathors.parley.voicetyping

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import android.util.Log
import android.view.inputmethod.InputMethodManager
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The two doors between the keyboard and the app, plus the questions the keyboard
 * has to ask before it dares open a microphone.
 *
 * ## Why this file exists at all
 *
 * An `InputMethodService` **cannot request a runtime permission**. There is no
 * Activity to host the request, and `ActivityCompat.requestPermissions` needs
 * one — so `RECORD_AUDIO` can only ever be granted from the app. This is the
 * Android analogue of the iOS constraint that a keyboard extension cannot open
 * the microphone at all (`ios/Keyboard/KeyboardViewController.swift`): both
 * platforms force a hand-off, they just draw the line in different places.
 *
 * | | iOS | Android |
 * |---|---|---|
 * | Records | the app | the keyboard's own process |
 * | Hand-off is for | recording itself | *granting* the mic, once |
 * | Trigger | every dictation (unless the app is awake) | only while the grant or the session is missing |
 *
 * So the Android hand-off is a one-time setup trip, not a per-dictation round
 * trip — and getting it wrong is the single most common way third-party
 * dictation keyboards break: the mic button appears to do nothing, forever,
 * because nothing in the IME can ever ask for the permission it is missing.
 *
 * ## The doors
 *
 * * [openSetupInApp] — from the keyboard into the app, at the screen that can
 *   actually fix things (request the mic, or sign in).
 * * [openSystemImeSettings] / [showImePicker] — from the app out to the system,
 *   for the two steps only the user can take: *enable* the keyboard, then
 *   *switch* to it.
 */
object VoiceTypingSetup {

    private const val TAG = "VoiceTypingSetup"

    /** The IME's component, as the framework and `adb shell ime` spell it. */
    const val IME_ID = "com.pathors.parley/.voicetyping.ParleyInputMethodService"

    /**
     * Deep link the keyboard uses to reach the setup screen. Declared on
     * `MainActivity` next to the sign-in callback, and consumed by
     * [SetupRequest] once the navigation graph is up.
     */
    const val SETUP_URI = "parley://voice-typing"

    /** Whether `RECORD_AUDIO` is granted to this process right now. */
    fun hasMicPermission(context: Context): Boolean =
        context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

    /** Whether the user has enabled the Parley keyboard in system settings. */
    fun isImeEnabled(context: Context): Boolean {
        val imm = context.getSystemService(InputMethodManager::class.java) ?: return false
        return imm.enabledInputMethodList.any { it.packageName == context.packageName }
    }

    /** Whether the Parley keyboard is the one currently selected. */
    fun isImeSelected(context: Context): Boolean {
        val current = Settings.Secure.getString(
            context.contentResolver,
            Settings.Secure.DEFAULT_INPUT_METHOD,
        )
        return current?.startsWith("${context.packageName}/") == true
    }

    /**
     * Open the app's voice-typing setup screen from the keyboard.
     *
     * `FLAG_ACTIVITY_NEW_TASK` is required (a Service has no task of its own),
     * and the start is allowed despite Android 10+ background-activity-start
     * restrictions because an IME showing its input view *has a visible window*,
     * which is one of the documented exemptions. It is also unambiguously
     * user-initiated: this only ever runs from a tap on the keyboard.
     */
    fun openSetupInApp(context: Context) {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(SETUP_URI))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            Log.w(TAG, "could not open the Parley app for setup", e)
        }
    }

    /**
     * The system's "Manage on-screen keyboards" list, where the Parley keyboard
     * is switched on. There is no API to enable an IME for the user — this jump
     * is as far as any keyboard app can go.
     */
    fun openSystemImeSettings(context: Context) {
        val intent = Intent(Settings.ACTION_INPUT_METHOD_SETTINGS)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            Log.w(TAG, "no input-method settings activity on this device", e)
        }
    }

    /**
     * The "Change keyboard" picker — step two, switching to Parley. Also what the
     * keyboard's own globe key uses, so the user is never trapped in an
     * input-only keyboard.
     */
    fun showImePicker(context: Context) {
        context.getSystemService(InputMethodManager::class.java)?.showInputMethodPicker()
    }

    /** This app's entry in system Settings, for a permanently-denied mic grant. */
    fun openAppSettings(context: Context) {
        val intent = Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.fromParts("package", context.packageName, null),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            Log.w(TAG, "no application details settings activity", e)
        }
    }

    /**
     * A pending "show me the voice-typing setup" request, carried from the deep
     * link that `MainActivity` receives to the navigation graph that can act on
     * it.
     *
     * A latch rather than an event: when the keyboard hands off while the user is
     * signed *out*, the graph does not exist yet (the sign-in wall is up), so the
     * request has to survive until after sign-in — which is exactly the trip the
     * user was sent on. Mirrors how `screenshot/DemoMode` drives navigation.
     */
    object SetupRequest {
        private val _pending = MutableStateFlow(false)

        /** True while a hand-off is waiting to be shown. */
        val pending: StateFlow<Boolean> = _pending.asStateFlow()

        /** @return true if [uri] was the setup deep link (and is now pending). */
        fun handle(uri: Uri): Boolean {
            if (uri.toString().trimEnd('/') != SETUP_URI) return false
            _pending.value = true
            return true
        }

        /** The graph has navigated; stop asking. */
        fun consume() {
            _pending.value = false
        }
    }
}
