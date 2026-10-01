package com.pathors.parley.audio

/**
 * One input the platform is offering, reduced to what the choice depends on.
 *
 * A deliberately tiny stand-in for `AudioDeviceInfo`, which is a final platform
 * class with no public constructor: reduced like this, the routing decision can
 * be exercised against a Bluetooth headset appearing mid-meeting without a
 * Bluetooth headset, which is the only way this code was ever going to be
 * tested. The caller maps `AudioManager.getDevices(GET_DEVICES_INPUTS)` into
 * these.
 *
 * @property id `AudioDeviceInfo.getId()`. The identity of the route, and the
 *   thing [AudioRouteChoice.needsRebuild] compares. Note that the platform
 *   recycles ids, which is why [type] is compared alongside it.
 * @property type `AudioDeviceInfo.TYPE_*`; kept as a raw Int so this file needs
 *   no `android.media` import. The constants are mirrored, with their names, in
 *   [AudioRouteChoice].
 * @property sampleRates `getSampleRates()`. Not used by the choice — carried so
 *   the caller can decide what format to reopen the `AudioRecord` with once the
 *   choice is made, without having to hold on to the platform object.
 * @property channelCounts `getChannelCounts()`, carried for the same reason.
 */
data class InputDevice(
    val id: Int,
    val type: Int,
    val sampleRates: List<Int> = emptyList(),
    val channelCounts: List<Int> = emptyList(),
)

/**
 * Which microphone a recording should be using, and whether the one it is using
 * is still the right answer.
 *
 * ## The failure
 *
 * Nothing in this codebase watches audio routing. `AudioRecord` is opened
 * against whatever input the platform happened to prefer at
 * `startRecording()` and is then **pinned to it for the life of the
 * recording** — the object has no notion of following a route change. So a user
 * who joins a meeting on speakerphone and then puts on a Bluetooth headset ten
 * minutes in gets the worst possible combination: the headset is obviously
 * working, because they can hear through it, so they believe they are recording
 * through its microphone, while the phone goes on recording through its own
 * from a pocket or a table. Eighty minutes of much worse audio, and no
 * indication until playback.
 *
 * The fix is to notice the route change and rebuild the `AudioRecord` against
 * the better input. [preferred] decides which input that is; [needsRebuild]
 * decides whether it is worth the interruption.
 *
 * ## Why not rebuild on every route change
 *
 * Because rebuilding costs audio. Tearing down and reopening an `AudioRecord`
 * puts a hole of some tens of milliseconds in the recording, and route-change
 * callbacks fire for things that have nothing to do with the microphone —
 * plugging in a charger is a route change, so is an HDMI cable, so is a
 * notification sound grabbing focus. iOS came to the same conclusion and
 * guards it with `needsRebuild()` (`ios/App/Parley/AudioCapture.swift` lines
 * 463-478): *"A route change that leaves both intact (plugging in a charger,
 * say) needs no rebuild, and rebuilding anyway would punch a hole in the audio
 * for no reason."*
 *
 * The two platforms test different things for the same reason, and the
 * difference is worth knowing. iOS has no device identity to compare —
 * `AVAudioEngine` hands you a format, not a device — so it infers "the route
 * moved" from the hardware sample rate or channel count changing under the tap.
 * Android does give every input an id, so here the comparison is the direct
 * one: did the input we would choose today stop being the input we are on?
 *
 * ## No Android here on purpose
 *
 * Types are raw `Int`s and devices are [InputDevice], so the whole decision is
 * plain Kotlin and testable off-device. The caller owns the
 * `AudioDeviceCallback` and the mapping.
 */
object AudioRouteChoice {

    // The `AudioDeviceInfo.TYPE_*` values this file ranks, mirrored as raw Ints
    // so nothing here imports `android.media`. The numbers alone are unreadable,
    // hence a name on every one. Verified against
    // `$ANDROID_HOME/platforms/android-36/android.jar`; they are public API
    // constants and therefore frozen — a value may be added to the set, but an
    // existing one can never change.

    /** `AudioDeviceInfo.TYPE_WIRED_HEADSET` */
    const val TYPE_WIRED_HEADSET = 3

    /** `AudioDeviceInfo.TYPE_BLUETOOTH_SCO` */
    const val TYPE_BLUETOOTH_SCO = 7

    /** `AudioDeviceInfo.TYPE_USB_DEVICE` */
    const val TYPE_USB_DEVICE = 11

    /** `AudioDeviceInfo.TYPE_BUILTIN_MIC` */
    const val TYPE_BUILTIN_MIC = 15

    /** `AudioDeviceInfo.TYPE_TELEPHONY` */
    const val TYPE_TELEPHONY = 18

    /** `AudioDeviceInfo.TYPE_USB_HEADSET` */
    const val TYPE_USB_HEADSET = 22

    /** `AudioDeviceInfo.TYPE_BLE_HEADSET` */
    const val TYPE_BLE_HEADSET = 26

    /**
     * Rank for [preferred], best first. Lower wins.
     *
     * The principle behind the order is that **a headset the user deliberately
     * put on beats the microphone that was there anyway**. Plugging in or
     * pairing a headset is an act of intent, and in a meeting it is almost
     * always the intent "record me through this"; the built-in microphone is
     * merely the default nobody chose.
     *
     * Within that, the tiers are ordered by how good the captured speech
     * actually is:
     *
     * 1. [TYPE_WIRED_HEADSET] — a boom or inline microphone a few inches from
     *    the mouth, on an analogue path with no codec, no pairing and no
     *    battery. Nothing beats it for a recording.
     * 2. [TYPE_USB_HEADSET] — the same physical advantage over a digital path.
     *    Below wired only because it is one more layer that can enumerate
     *    oddly, not because it sounds worse.
     * 3. [TYPE_USB_DEVICE] — anything else arriving over USB: an audio
     *    interface, a dock, a desk microphone. Very likely better than the
     *    built-in mic, but it is a category rather than a device, so it ranks
     *    below the two things that announce themselves as headsets.
     * 4. [TYPE_BLE_HEADSET] — LE Audio. Wireless, but LC3 at a real bitrate is
     *    a different world from SCO, and — the part that matters here — it
     *    needs no SCO audio link: pinning a record to it is enough to capture
     *    from it.
     * 5. [TYPE_BUILTIN_MIC] — the default, and the fallback that always exists.
     * 6. everything else — unknown or exotic inputs. Ranked last rather than
     *    excluded: if a device somehow offers no built-in microphone, an input
     *    we do not recognise still beats recording nothing.
     *
     * Two types are not in the table at all; [preferred] drops them before
     * ranking. [TYPE_TELEPHONY] because it is not a microphone, and
     * [TYPE_BLUETOOTH_SCO] because this app cannot capture from it. See there
     * for why.
     */
    private fun tierOf(type: Int): Int = when (type) {
        TYPE_WIRED_HEADSET -> 0
        TYPE_USB_HEADSET -> 1
        TYPE_USB_DEVICE -> 2
        TYPE_BLE_HEADSET -> 3
        TYPE_BUILTIN_MIC -> 4
        else -> 5
    }

    /**
     * The best input to record through, or null when there is none worth
     * opening.
     *
     * **[TYPE_TELEPHONY] is excluded outright**, not merely ranked last. It is
     * the call uplink/downlink, and selecting it does not get you the far end of
     * a phone call — that is blocked at a level far below this code, and what
     * an app actually gets from it is silence or a refusal to open. So it is not
     * a worse microphone, it is *not a microphone*, and letting it rank anywhere
     * in the table would mean a call arriving mid-meeting could replace a
     * working input with nothing at all. Ranking it last would not be enough
     * either: on a device that exposes telephony but whose built-in mic is
     * already held by the call, last place is first place.
     *
     * **[TYPE_BLUETOOTH_SCO] is excluded outright too**, for a different reason
     * with the same outcome. Classic Bluetooth hands-free only carries a
     * microphone while a SCO audio link is up, and bringing one up is the app's
     * job — `startBluetoothSco()`, or `setCommunicationDevice()` on newer
     * platforms. This app does neither. An `AudioRecord` pinned to a SCO input
     * with no link open does not fail; on most devices it opens happily and
     * captures silence, for the whole meeting, with nothing to say so until
     * playback. That is far worse than the built-in microphone, which at least
     * records the room. And because merely pairing earbuds, a watch or a car
     * kit is enough to make a SCO input appear in the list, ranking it
     * anywhere above the built-in mic would silently empty the recording of
     * every user who happens to own one. Excluding it only means *we* never
     * pin a record to it: when the user does have SCO active for some other
     * reason, the platform's own routing still applies.
     *
     * Ties inside a tier are broken by ascending [InputDevice.id], purely so the
     * answer is **deterministic**. It barely matters which of two equivalent
     * inputs wins; it matters enormously that the same set of devices always
     * produces the same winner, because [needsRebuild] compares this function's
     * output against the current device. A `preferred` that could return either
     * of two ids depending on the order `getDevices()` happened to enumerate
     * would make `needsRebuild` flap — and flapping here means rebuilding the
     * `AudioRecord` every two seconds, i.e. destroying the recording in the name
     * of protecting it.
     */
    fun preferred(devices: List<InputDevice>): InputDevice? =
        devices
            .filter { it.type != TYPE_TELEPHONY && it.type != TYPE_BLUETOOTH_SCO }
            .minWithOrNull(compareBy<InputDevice>({ tierOf(it.type) }, { it.id }))

    /**
     * Has the route moved in a way that is worth rebuilding the `AudioRecord`
     * for?
     *
     * The four answers, and why each is the way it is:
     *
     * - **No preferred device at all → false.** Every input vanished, or the
     *   only ones left are telephony or classic Bluetooth. Rebuilding against
     *   nothing cannot produce a better recording; it can only turn a
     *   working-but-possibly-wrong
     *   recording into no recording, and it would do so at the exact moment the
     *   device list is unreliable (mid-transition, the list momentarily empties
     *   on some devices). This is the one place in the whole capture path where
     *   *doing nothing* beats *recovering* — everywhere else, a capture that has
     *   stopped producing audio should be rebuilt, and here the rebuild is what
     *   would stop it.
     * - **No current device, but a preferred one exists → true.** Nothing is
     *   open; open the best thing available.
     * - **The preferred device's id differs from the current one → true.** This
     *   is the reported bug: the headset appeared, it outranks the built-in mic,
     *   and the recording must follow it.
     * - **Same id → false, with one exception.** This is the charger case, and
     *   it is the whole point of the function existing rather than every route
     *   callback rebuilding directly. The exception is id reuse: the platform
     *   recycles device ids, so a device that disappeared and a different one
     *   that took its number would otherwise look like no change at all. Hence
     *   the final check that [current] is still present *as itself* — same id
     *   and same type — and not merely that something with its id is.
     */
    fun needsRebuild(current: InputDevice?, devices: List<InputDevice>): Boolean {
        val best = preferred(devices) ?: return false
        if (current == null) return true
        if (best.id != current.id) return true
        return devices.none { it.id == current.id && it.type == current.type }
    }
}
