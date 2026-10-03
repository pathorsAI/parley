Meetings recorded on Android transcribe again. 1.13 recorded audio but returned an empty transcript.

- **The microphone no longer restarts itself in a loop.** 1.13 rebuilt the recording every ~350 ms for the whole meeting, so the transcription service got fragments with gaps between them.
- **Recording no longer locks onto a Bluetooth input that delivers silence.** The built-in microphone is preferred unless a headset can actually capture.
