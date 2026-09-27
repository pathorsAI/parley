package com.pathors.parley.audio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Which microphone the recording follows, and — just as important — which route
 * changes it refuses to follow.
 *
 * Both halves protect a recording: picking the headset is what stops a meeting
 * being captured from a phone in someone's pocket, and *not* rebuilding for a
 * charger is what stops the fix from punching holes in the audio all meeting
 * long.
 */
class AudioRouteChoiceTest {

    private fun builtinMic(id: Int = 1) =
        InputDevice(id = id, type = AudioRouteChoice.TYPE_BUILTIN_MIC)

    private fun wiredHeadset(id: Int = 2) =
        InputDevice(id = id, type = AudioRouteChoice.TYPE_WIRED_HEADSET)

    private fun bluetoothHeadset(id: Int = 3) =
        InputDevice(id = id, type = AudioRouteChoice.TYPE_BLUETOOTH_SCO)

    private fun bleHeadset(id: Int = 4) =
        InputDevice(id = id, type = AudioRouteChoice.TYPE_BLE_HEADSET)

    private fun usbHeadset(id: Int = 5) =
        InputDevice(id = id, type = AudioRouteChoice.TYPE_USB_HEADSET)

    private fun usbDevice(id: Int = 6) =
        InputDevice(id = id, type = AudioRouteChoice.TYPE_USB_DEVICE)

    private fun telephony(id: Int = 7) =
        InputDevice(id = id, type = AudioRouteChoice.TYPE_TELEPHONY)

    // ---------------------------------------------------------------- choosing

    @Test
    fun aWiredHeadsetBeatsTheBuiltInMic() {
        assertEquals(
            wiredHeadset(),
            AudioRouteChoice.preferred(listOf(builtinMic(), wiredHeadset())),
        )
    }

    /**
     * **The reported bug: the phone kept recording its own microphone while the
     * user believed they were on their Bluetooth headset.** They could hear the
     * meeting through the headset, so they had every reason to think it was
     * capturing them too; instead the phone recorded from a pocket for the rest
     * of the call, and nobody found out until playback. An LE Audio headset
     * needs no SCO link to capture from, so pinning to it is enough, and it
     * wins: a microphone two inches from the speaker's mouth beats one across
     * the room.
     */
    @Test
    fun aBluetoothLeHeadsetAppearingMidMeetingBeatsTheBuiltInMic() {
        val before = listOf(builtinMic())
        assertEquals(builtinMic(), AudioRouteChoice.preferred(before))

        val after = before + bleHeadset()
        assertEquals(bleHeadset(), AudioRouteChoice.preferred(after))
        assertTrue(
            "the recording must follow the headset the user just put on",
            AudioRouteChoice.needsRebuild(builtinMic(), after),
        )
    }

    @Test
    fun theTierOrderIsWiredThenUsbThenBleThenBuiltIn() {
        val all = listOf(
            builtinMic(),
            bluetoothHeadset(),
            bleHeadset(),
            usbDevice(),
            usbHeadset(),
            wiredHeadset(),
        )
        assertEquals(wiredHeadset(), AudioRouteChoice.preferred(all))
        assertEquals(usbHeadset(), AudioRouteChoice.preferred(all - wiredHeadset()))
        assertEquals(usbDevice(), AudioRouteChoice.preferred(all - wiredHeadset() - usbHeadset()))
        assertEquals(
            bleHeadset(),
            AudioRouteChoice.preferred(listOf(builtinMic(), bluetoothHeadset(), bleHeadset())),
        )
        assertEquals(
            builtinMic(),
            AudioRouteChoice.preferred(listOf(builtinMic(), bluetoothHeadset())),
        )
        assertEquals(builtinMic(), AudioRouteChoice.preferred(listOf(builtinMic())))
    }

    /** An input we do not recognise still beats recording nothing at all. */
    @Test
    fun anUnknownInputIsRankedLastButIsStillChosenWhenItIsAllThereIs() {
        val unknown = InputDevice(id = 99, type = 0) // AudioDeviceInfo.TYPE_UNKNOWN
        assertEquals(builtinMic(), AudioRouteChoice.preferred(listOf(unknown, builtinMic())))
        assertEquals(unknown, AudioRouteChoice.preferred(listOf(unknown)))
    }

    // --------------------------------------------------------------- telephony

    /**
     * Telephony is excluded outright, not ranked last. It is the call
     * uplink/downlink: you cannot record the far end of a call from it, and what
     * an app actually gets is silence or a refusal to open. Selecting it would
     * replace a working microphone with nothing — so when it is the only input
     * on offer, the honest answer is "no input", and [AudioRouteChoice.needsRebuild]
     * then leaves the existing recording alone.
     */
    @Test
    fun telephonyIsNeverChosenEvenWhenItIsTheOnlyDevice() {
        assertNull(AudioRouteChoice.preferred(listOf(telephony())))
        assertEquals(
            builtinMic(),
            AudioRouteChoice.preferred(listOf(telephony(), builtinMic())),
        )
        assertFalse(
            "a call arriving must not swap a working mic for the call uplink",
            AudioRouteChoice.needsRebuild(builtinMic(), listOf(telephony())),
        )
    }

    // ------------------------------------------------------- classic bluetooth

    /**
     * **The 1.13 outage.** Classic Bluetooth hands-free only carries a
     * microphone while a SCO audio link is up, and this app never opens one
     * (no `startBluetoothSco()`, no `setCommunicationDevice()`). An
     * `AudioRecord` pinned to a SCO input without that link opens fine and
     * records silence — so ranking SCO above the built-in mic turned every
     * phone with paired earbuds, a watch or a car kit into a machine for
     * recording meetings of zeros. The built-in mic at least records the room.
     */
    @Test
    fun aClassicBluetoothHeadsetNeverBeatsTheBuiltInMic() {
        assertEquals(
            builtinMic(),
            AudioRouteChoice.preferred(listOf(bluetoothHeadset(), builtinMic())),
        )
        assertEquals(
            builtinMic(),
            AudioRouteChoice.preferred(listOf(builtinMic(), bluetoothHeadset())),
        )
    }

    /**
     * SCO is excluded outright, the same way telephony is, not ranked last: on
     * a list with nothing else in it, last place would be first place, and the
     * recording would be silence. And a hands-free headset connecting
     * mid-meeting must not cost the recording a rebuild — the input we would
     * choose has not moved.
     */
    @Test
    fun classicBluetoothIsNeverChosenEvenWhenItIsTheOnlyDevice() {
        assertNull(AudioRouteChoice.preferred(listOf(bluetoothHeadset())))
        assertNull(
            AudioRouteChoice.preferred(listOf(bluetoothHeadset(id = 3), bluetoothHeadset(id = 8))),
        )
        assertFalse(
            "a hands-free headset connecting must not pull the recording off the built-in mic",
            AudioRouteChoice.needsRebuild(builtinMic(), listOf(bluetoothHeadset(), builtinMic())),
        )
        assertFalse(
            "a SCO input alone is no reason to abandon a working mic",
            AudioRouteChoice.needsRebuild(builtinMic(), listOf(bluetoothHeadset())),
        )
    }

    @Test
    fun anEmptyListHasNoPreferredDevice() {
        assertNull(AudioRouteChoice.preferred(emptyList()))
    }

    // ------------------------------------------------------------ determinism

    /**
     * Two inputs of the same kind — a pair of LE Audio earbuds and an LE Audio
     * speakerphone both enumerate as BLE headsets — must always resolve to the
     * same one, whatever order `getDevices()` returned them in. It barely matters which
     * wins; it matters enormously that it is always the same one, because a
     * `preferred` that flipped with enumeration order would make `needsRebuild`
     * flap, and a flapping `needsRebuild` rebuilds the `AudioRecord` every few
     * seconds — destroying the recording in the name of protecting it.
     */
    @Test
    fun tiesBreakByIdAndAreStableAcrossListOrderings() {
        val low = bleHeadset(id = 4)
        val high = bleHeadset(id = 9)
        assertEquals(low, AudioRouteChoice.preferred(listOf(low, high)))
        assertEquals(low, AudioRouteChoice.preferred(listOf(high, low)))

        val withMic = listOf(builtinMic(id = 12), high, low)
        assertEquals(low, AudioRouteChoice.preferred(withMic))
        assertEquals(low, AudioRouteChoice.preferred(withMic.reversed()))
    }

    // ------------------------------------------------------------- rebuilding

    /**
     * **The charger case, and the whole reason this function exists.** Plugging
     * in a charger fires a route-change callback like any other, but the input
     * we would choose has not moved. Rebuilding here punches a hole of tens of
     * milliseconds in the audio for nothing — and route callbacks are frequent
     * enough that a policy of "rebuild on every change" would leave a meeting
     * full of them.
     */
    @Test
    fun aRouteChangeThatLeavesTheSamePreferredDeviceDoesNotRebuild() {
        val current = builtinMic(id = 1)
        // The charger appeared; it is an output, so the input list is unchanged.
        assertFalse(AudioRouteChoice.needsRebuild(current, listOf(builtinMic(id = 1))))
    }

    @Test
    fun aBetterDeviceAppearingRebuilds() {
        assertTrue(
            AudioRouteChoice.needsRebuild(
                builtinMic(id = 1),
                listOf(builtinMic(id = 1), wiredHeadset(id = 2)),
            ),
        )
    }

    @Test
    fun havingNothingOpenYetRebuilds() {
        assertTrue(AudioRouteChoice.needsRebuild(null, listOf(builtinMic())))
    }

    @Test
    fun theCurrentDeviceDisappearingRebuilds() {
        // Headset unplugged: the built-in mic is now the best available, and it
        // is not the device the AudioRecord is pinned to.
        assertTrue(
            AudioRouteChoice.needsRebuild(wiredHeadset(id = 2), listOf(builtinMic(id = 1))),
        )
    }

    /**
     * The platform recycles device ids. A headset that vanished and a different
     * input that inherited its number would otherwise compare equal and look
     * like no change at all — leaving the recording pinned to a device that no
     * longer exists.
     */
    @Test
    fun aRecycledIdBelongingToADifferentDeviceRebuilds() {
        val current = wiredHeadset(id = 7)
        val impostor = usbDevice(id = 7)
        assertEquals(impostor, AudioRouteChoice.preferred(listOf(impostor)))
        assertTrue(AudioRouteChoice.needsRebuild(current, listOf(impostor)))
    }

    /**
     * Every input vanished. This is the one place in the capture path where
     * doing nothing beats recovering: rebuilding against nothing cannot improve
     * the recording, it can only turn a working-but-wrong one into no recording
     * — and the list is at its least trustworthy mid-transition, when it can
     * momentarily empty out on some devices.
     */
    @Test
    fun anEmptyDeviceListDoesNotRebuild() {
        assertFalse(AudioRouteChoice.needsRebuild(builtinMic(), emptyList()))
        assertFalse(AudioRouteChoice.needsRebuild(null, emptyList()))
    }

    // --------------------------------------------------------------- constants

    /**
     * The mirrored `AudioDeviceInfo.TYPE_*` values. These are public platform
     * API and therefore frozen, but they are copied numbers in a file that
     * cannot import `android.media`, so they are worth stating once more where a
     * reader will see them.
     */
    @Test
    fun theMirroredTypeConstantsMatchThePlatform() {
        assertEquals(3, AudioRouteChoice.TYPE_WIRED_HEADSET)
        assertEquals(7, AudioRouteChoice.TYPE_BLUETOOTH_SCO)
        assertEquals(11, AudioRouteChoice.TYPE_USB_DEVICE)
        assertEquals(15, AudioRouteChoice.TYPE_BUILTIN_MIC)
        assertEquals(18, AudioRouteChoice.TYPE_TELEPHONY)
        assertEquals(22, AudioRouteChoice.TYPE_USB_HEADSET)
        assertEquals(26, AudioRouteChoice.TYPE_BLE_HEADSET)
    }
}
