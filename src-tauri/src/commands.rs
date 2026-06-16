use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use tauri::{AppHandle, Emitter, State};

use crate::audio::{microphone::Microphone, AudioSource};
use crate::transcription::soniox;

const DEFAULT_MODEL: &str = "stt-rt-v4";

/// Shared meeting state held in Tauri's managed state. `running` gates all
/// capture threads; clearing it tells them to release their devices and exit.
#[derive(Default)]
pub struct MeetingState {
    running: Arc<AtomicBool>,
    threads: Mutex<Vec<JoinHandle<()>>>,
    /// Separate flag for the Settings "test mic" preview (no Soniox).
    test_running: Arc<AtomicBool>,
}

/// List available microphone input device names (for the Settings picker).
#[tauri::command]
pub fn list_input_devices() -> Vec<String> {
    crate::audio::microphone::list_input_devices()
}

/// Start a mic-only preview that emits `audio://level` (source "test") so the
/// Settings UI can show whether the selected device is actually picking up sound.
/// No Soniox session is opened.
#[tauri::command]
pub fn start_mic_test(
    app: AppHandle,
    state: State<MeetingState>,
    input_device: Option<String>,
) -> Result<(), String> {
    if state.test_running.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let running = state.test_running.clone();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
    Microphone { device_name: input_device }
        .start(tx, running)
        .map_err(|e| e.to_string())?;

    tauri::async_runtime::spawn(async move {
        let mut peak: i32 = 0;
        let mut n: u64 = 0;
        while let Some(chunk) = rx.recv().await {
            for &s in &chunk {
                peak = peak.max((s as i32).abs());
            }
            n += chunk.len() as u64;
            if n >= 1600 {
                let level = (peak as f32 / 32767.0).clamp(0.0, 1.0);
                let _ = app.emit("audio://level", serde_json::json!({ "source": "test", "level": level }));
                peak = 0;
                n = 0;
            }
        }
        // Channel closed → mic stopped; signal zero so the meter resets.
        let _ = app.emit("audio://level", serde_json::json!({ "source": "test", "level": 0.0 }));
    });
    Ok(())
}

#[tauri::command]
pub fn stop_mic_test(state: State<MeetingState>) {
    state.test_running.store(false, Ordering::SeqCst);
}

#[tauri::command]
pub fn start_meeting(
    app: AppHandle,
    state: State<MeetingState>,
    soniox_api_key: String,
    model: Option<String>,
    input_device: Option<String>,
) -> Result<(), String> {
    if soniox_api_key.trim().is_empty() {
        return Err("missing Soniox API key".into());
    }
    // Ignore if already running.
    if state.running.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let running = state.running.clone();
    let model = model.unwrap_or_else(|| DEFAULT_MODEL.to_string());

    // Microphone source → "me".
    spawn_source(
        &app,
        &state,
        Microphone { device_name: input_device },
        running.clone(),
        soniox_api_key.clone(),
        model.clone(),
        "me",
    );

    // System-audio source → "them" (macOS Core Audio tap). On other platforms
    // this is skipped until a loopback source is implemented.
    #[cfg(target_os = "macos")]
    spawn_source(
        &app,
        &state,
        crate::audio::system_macos::SystemAudio,
        running.clone(),
        soniox_api_key.clone(),
        model.clone(),
        "them",
    );

    let _ = app.emit("meeting://status", "recording");
    Ok(())
}

#[tauri::command]
pub fn stop_meeting(app: AppHandle, state: State<MeetingState>) -> Result<(), String> {
    state.running.store(false, Ordering::SeqCst);
    // Joining lets each capture thread release its device (drops its PCM sender,
    // which in turn ends the Soniox session via channel close).
    let handles: Vec<JoinHandle<()>> = state.threads.lock().unwrap().drain(..).collect();
    for h in handles {
        let _ = h.join();
    }
    let _ = app.emit("meeting://status", "stopped");
    Ok(())
}

/// Save a meeting transcript (markdown) to ~/Documents/Parley and return the
/// absolute path written. Creates the folder if needed.
#[tauri::command]
pub fn save_transcript(filename: String, contents: String) -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|_| "no HOME dir".to_string())?;
    let dir = std::path::Path::new(&home).join("Documents").join("Parley");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Sanitize the filename to a single path component.
    let safe = filename.replace(['/', '\\'], "-");
    let path = dir.join(safe);
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Start one capture backend feeding a dedicated Soniox realtime session.
fn spawn_source<S: AudioSource>(
    app: &AppHandle,
    state: &State<MeetingState>,
    source: S,
    running: Arc<AtomicBool>,
    api_key: String,
    model: String,
    label: &'static str,
) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
    match source.start(tx, running) {
        Ok(handle) => state.threads.lock().unwrap().push(handle),
        Err(e) => {
            eprintln!("[{label}] capture failed to start: {e}");
            return;
        }
    }

    let app_for_session = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = soniox::run_session(app_for_session, api_key, model, label, rx).await {
            eprintln!("[soniox:{label}] session ended: {e}");
        }
    });
}
