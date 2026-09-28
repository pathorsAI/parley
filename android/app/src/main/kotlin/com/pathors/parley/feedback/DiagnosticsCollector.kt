package com.pathors.parley.feedback

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.os.Build
import com.pathors.parley.BuildConfig
import java.util.Locale
import java.util.TimeZone
import kotlinx.serialization.json.JsonObject

/**
 * The shared vocabulary for "which microphone": `AudioDeviceInfo.TYPE_*` mapped
 * onto the six route names iOS reports too, so the admin view can group the two
 * platforms' reports by the same word.
 */
object AudioRouteLabel {
    const val BUILT_IN = "builtInMic"
    const val BLUETOOTH_A2DP = "bluetoothA2DP"
    const val BLUETOOTH_HFP = "bluetoothHFP"
    const val WIRED = "wired"
    const val USB = "usb"
    const val OTHER = "other"

    fun of(type: Int): String = when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_MIC -> BUILT_IN
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> BLUETOOTH_A2DP
        // SCO is the hands-free profile; an LE Audio headset's microphone is
        // the same role on the newer stack.
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET -> BLUETOOTH_HFP
        AudioDeviceInfo.TYPE_WIRED_HEADSET -> WIRED
        AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_ACCESSORY -> USB
        else -> OTHER
    }
}

/**
 * Gathers, on the device, what [DiagnosticsBuilder] turns into a report's
 * `diagnostics`: the build, the phone, and the state of the few things that
 * explain most failures — microphone permission, the upload queue, whether
 * anyone is signed in — plus this process's recent log.
 *
 * Nothing here is read that is not in the list the report sheet discloses
 * ("the app version, device and recent error log"): no account details beyond
 * signed-in-or-not, no recording content, no identifiers of the phone.
 *
 * `micPermission` is only ever `granted` or `denied`. iOS can also say
 * `undetermined`; Android cannot tell "never asked" from "refused" without an
 * Activity to ask `shouldShowRequestPermissionRationale`, and guessing would
 * make the field lie in exactly the reports where it matters.
 */
class DiagnosticsCollector(
    private val context: Context,
    private val pendingUploads: () -> Int,
    private val syncLastError: () -> String?,
    private val signedIn: suspend () -> Boolean,
    private val log: () -> List<LogRing.Entry> = { Log.ring.snapshot() },
) {

    /** For a report somebody is sending (every trigger but a crash). */
    suspend fun collect(recording: RecordingContext?): JsonObject =
        DiagnosticsBuilder.build(
            base().copy(
                recording = recording,
                micPermission = micPermission(),
                syncPendingCount = runCatching(pendingUploads).getOrNull(),
                syncLastError = runCatching(syncLastError).getOrNull(),
                signedIn = runCatching { signedIn() }.getOrNull(),
                log = log(),
            ),
        )

    /** For a crash report: only what the settings footnote promises. */
    fun collectForCrash(crash: JsonObject): JsonObject =
        DiagnosticsBuilder.forCrash(base().copy(crash = crash))

    private fun base() = DiagnosticsInput(
        appVersion = BuildConfig.VERSION_NAME,
        appBuild = BuildConfig.VERSION_CODE.toString(),
        osVersion = Build.VERSION.RELEASE.orEmpty(),
        sdkInt = Build.VERSION.SDK_INT,
        deviceModel = deviceModel(),
        locale = Locale.getDefault().toLanguageTag(),
        timezone = TimeZone.getDefault().id,
    )

    private fun micPermission(): String =
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            "granted"
        } else {
            "denied"
        }

    companion object {
        /**
         * `Google Pixel 8`, `samsung SM-S918B` — the maker is prefixed unless
         * the model already starts with it, which Pixels and some others do.
         * The model name, not any device identifier: it says which phone
         * *kind*, never which phone.
         */
        fun deviceModel(manufacturer: String = Build.MANUFACTURER.orEmpty(), model: String = Build.MODEL.orEmpty()): String =
            when {
                model.isEmpty() -> manufacturer
                manufacturer.isEmpty() || model.startsWith(manufacturer, ignoreCase = true) -> model
                else -> "$manufacturer $model"
            }
    }
}
