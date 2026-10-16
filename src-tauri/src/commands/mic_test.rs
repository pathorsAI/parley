//! The Settings microphone preview: a level meter on the selected input, with
//! no transcription session behind it.

use tauri::{AppHandle, Emitter, State};

use crate::audio::microphone::Microphone;
use crate::capture::{spawn_capture, Begin, MicCoordinator, MicUser};
use crate::transcription::common::{LevelMeter, LEVEL_EVENT};

/// List available microphone input device names (for the Settings picker).
#[tauri::command]
pub fn list_input_devices() -> Vec<String> {
    crate::audio::microphone::list_input_devices()
}

/// Start a mic-only preview that emits `audio://level` (source "test") so the
/// Settings UI can show whether the selected device is actually picking up sound.
/// No transcription session is opened.
#[tauri::command]
pub fn start_mic_test(
    app: AppHandle,
    coord: State<MicCoordinator>,
    input_device: Option<String>,
) -> Result<(), String> {
    // A meeting (or dictation) owns the mic until it ends — never open a
    // competing input stream while recording. On macOS a second stream can make
    // CoreAudio renegotiate the device and silently kill the live capture
    // (transcription stops). The UI also disables the test while recording; the
    // coordinator is the reliable backstop.
    let gate = match coord.begin(MicUser::MicTest) {
        Begin::Started(gate) => gate,
        Begin::AlreadyActive | Begin::Busy(_) => return Ok(()),
    };
    let mic = Microphone {
        device_name: input_device,
    };
    let mut rx = match spawn_capture(&coord, MicUser::MicTest, mic, gate, "test") {
        Ok(rx) => rx,
        Err(e) => {
            // Free the claim so the next test isn't refused forever.
            coord.stop(MicUser::MicTest);
            return Err(e);
        }
    };

    tauri::async_runtime::spawn(async move {
        // Reuse the shared metering primitive so peak/window logic lives in one place.
        let mut meter = LevelMeter::new(app.clone(), "test", LEVEL_EVENT);
        while let Some(chunk) = rx.recv().await {
            meter.push(&chunk);
        }
        // Channel closed → mic stopped; signal zero so the meter resets.
        let _ = app.emit(
            LEVEL_EVENT,
            serde_json::json!({ "source": "test", "level": 0.0 }),
        );
    });
    Ok(())
}

#[tauri::command]
pub fn stop_mic_test(coord: State<MicCoordinator>) {
    coord.stop(MicUser::MicTest);
}
