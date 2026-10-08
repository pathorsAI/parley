Stopping a meeting can no longer crash the app.

- **Tapping Stop while still connecting** no longer leaves the microphone running and crashes the app a moment later.
- **Unexpected errors during a meeting end the meeting** instead of killing the process.
- **A meeting that fails to start releases the microphone service**, so the recording notification no longer sticks around.

Play refused this build at commit because it targeted an Android version below the new minimum; 0.1.4 ships the same changes.
