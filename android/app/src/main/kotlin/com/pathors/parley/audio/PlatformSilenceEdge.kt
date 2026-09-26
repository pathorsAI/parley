package com.pathors.parley.audio

/**
 * Turns `AudioRecordingCallback.onRecordingConfigChanged` deliveries into the
 * two facts [com.pathors.parley.kit.CaptureRecovery] can act on — "something
 * took the microphone" and "it gave it back" — and swallows everything else.
 *
 * The callback is far noisier than those two facts. Android fires it for every
 * change to the recording configuration, and on Android 10 and up an app only
 * sees its own recordings there, so the changes it reports are almost always
 * **ours**: our `AudioRecord` starting (one configuration, not silenced), our
 * `AudioRecord` stopping (an empty list), and the same pair again for every
 * rebuild. Only a change in `isClientSilenced` on a *live* configuration is the
 * other app doing something.
 *
 * Forwarding the raw value was a feedback loop: our own start reported "not
 * silenced", the recovery policy read that as an interruption ending and
 * rebuilt the microphone, the rebuild stopped and started the record, which
 * reported "not silenced" twice more, and so on for the whole meeting — a
 * recording of 100–300 ms fragments with a hole after each one, and a relay
 * that got nothing it could transcribe. Android 1.13 shipped that way.
 *
 * Not thread-safe; the callback is delivered on one `Handler`, and this is only
 * ever called from it.
 */
class PlatformSilenceEdge {
    private var silenced = false

    /**
     * Fold one delivery into the edge detector.
     *
     * @param anyRecording whether the delivery listed any recording at all. An
     *   empty list is our own record stopping — at the end of the meeting or
     *   in the middle of a rebuild — and says nothing about who holds the
     *   microphone, so it never produces an event and never resets the state.
     * @param anySilenced whether any listed recording is `isClientSilenced`.
     * @return `true` when the microphone has just been taken away, `false` when
     *   it has just been given back, or null when this delivery changed neither
     *   — which is every delivery caused by our own record starting or
     *   stopping, and every repeat of a state already reported.
     */
    fun observe(anyRecording: Boolean, anySilenced: Boolean): Boolean? {
        if (!anyRecording) return null
        if (anySilenced == silenced) return null
        silenced = anySilenced
        return anySilenced
    }
}
