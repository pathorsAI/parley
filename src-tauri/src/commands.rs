use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use tauri::{AppHandle, Emitter, Manager, State};

use tokio::sync::mpsc::UnboundedReceiver;

use crate::audio::{microphone::Microphone, AudioSource};
use crate::transcription::{self, SttProvider, TranscribeConfig};

/// Path to the shared templates file (app config dir). The local MCP server
/// reads/writes the same file so templates can be managed outside the app.
pub(crate) fn templates_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("templates.json"))
}

/// Read the shared templates JSON (empty string if the file doesn't exist yet).
#[tauri::command]
pub fn read_templates(app: AppHandle) -> Result<String, String> {
    let path = templates_path(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(_) => Ok(String::new()),
    }
}

/// Write the shared templates JSON, creating the config dir if needed.
#[tauri::command]
pub fn write_templates(app: AppHandle, json: String) -> Result<(), String> {
    let path = templates_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

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
    Microphone {
        device_name: input_device,
    }
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
                let _ = app.emit(
                    "audio://level",
                    serde_json::json!({ "source": "test", "level": level }),
                );
                peak = 0;
                n = 0;
            }
        }
        // Channel closed → mic stopped; signal zero so the meter resets.
        let _ = app.emit(
            "audio://level",
            serde_json::json!({ "source": "test", "level": 0.0 }),
        );
    });
    Ok(())
}

#[tauri::command]
pub fn stop_mic_test(state: State<MeetingState>) {
    state.test_running.store(false, Ordering::SeqCst);
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn start_meeting(
    app: AppHandle,
    state: State<MeetingState>,
    provider: String,
    api_key: String,
    model: Option<String>,
    language_hints: Option<Vec<String>>,
    diarization: Option<bool>,
    input_device: Option<String>,
) -> Result<(), String> {
    let provider = SttProvider::from_id(&provider).map_err(|e| e.to_string())?;
    if api_key.trim().is_empty() {
        return Err("missing transcription API key".into());
    }
    // Ignore if already running.
    if state.running.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let running = state.running.clone();
    let model = model
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| provider.default_model().to_string());
    // Honor the request only if the provider can actually diarize.
    let diarization = diarization.unwrap_or(true) && provider.supports_diarization();
    let language_hints = language_hints.unwrap_or_default();
    let make_config = || TranscribeConfig {
        api_key: api_key.clone(),
        model: model.clone(),
        language_hints: language_hints.clone(),
        diarization,
    };

    // Diarizing providers separate speakers themselves, so mix mic + system
    // into ONE session (1x cost) and let diarization label speakers. Providers
    // without diarization keep two sessions so "me"/"them" stays deterministic.
    #[cfg(target_os = "macos")]
    {
        let mic = Microphone {
            device_name: input_device,
        };
        let sys = crate::audio::system_macos::SystemAudio;
        if diarization {
            let rx_me = spawn_capture(&state, mic, running.clone(), "me");
            let rx_them = spawn_capture(&state, sys, running.clone(), "them");
            match (rx_me, rx_them) {
                (Some(a), Some(b)) => {
                    let (tx_mix, rx_mix) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
                    tauri::async_runtime::spawn(crate::audio::mixer::mix_streams(a, b, tx_mix));
                    run_metered_session(&app, provider, make_config(), "mix", rx_mix);
                }
                // If one capture failed, transcribe whichever started.
                (Some(a), None) => run_metered_session(&app, provider, make_config(), "me", a),
                (None, Some(b)) => run_metered_session(&app, provider, make_config(), "them", b),
                (None, None) => {}
            }
        } else {
            if let Some(rx) = spawn_capture(&state, mic, running.clone(), "me") {
                run_metered_session(&app, provider, make_config(), "me", rx);
            }
            if let Some(rx) = spawn_capture(&state, sys, running.clone(), "them") {
                run_metered_session(&app, provider, make_config(), "them", rx);
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let mic = Microphone {
            device_name: input_device,
        };
        if let Some(rx) = spawn_capture(&state, mic, running.clone(), "me") {
            run_metered_session(&app, provider, make_config(), "me", rx);
        }
    }

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

/// Start one capture backend on its own thread, returning the PCM receiver.
/// Returns `None` if the device failed to start.
fn spawn_capture<S: AudioSource>(
    state: &State<MeetingState>,
    source: S,
    running: Arc<AtomicBool>,
    label: &'static str,
) -> Option<UnboundedReceiver<Vec<i16>>> {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
    match source.start(tx, running) {
        Ok(handle) => {
            state.threads.lock().unwrap().push(handle);
            Some(rx)
        }
        Err(e) => {
            eprintln!("[{label}] capture failed to start: {e}");
            None
        }
    }
}

/// Run a transcription session over `rx`, counting the audio streamed so the
/// frontend can bill it. Emits a `usage://stt` event when the session ends.
fn run_metered_session(
    app: &AppHandle,
    provider: SttProvider,
    config: TranscribeConfig,
    label: &'static str,
    rx: UnboundedReceiver<Vec<i16>>,
) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Interpose a sample counter between capture and the STT adapter: it
        // forwards every chunk untouched, then yields the total once the input
        // closes so we can bill the audio duration actually streamed.
        let (count_tx, count_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
        let counter = tauri::async_runtime::spawn(async move {
            let mut rx = rx;
            let mut samples: u64 = 0;
            while let Some(chunk) = rx.recv().await {
                samples += chunk.len() as u64;
                if count_tx.send(chunk).is_err() {
                    break;
                }
            }
            samples
        });

        if let Err(e) =
            transcription::run_session(provider, app.clone(), config, label, count_rx).await
        {
            eprintln!("[stt:{label}] session ended: {e}");
        }

        let samples = counter.await.unwrap_or(0);
        let seconds = samples as f64 / crate::audio::TARGET_SAMPLE_RATE as f64;
        let _ = app.emit(
            "usage://stt",
            serde_json::json!({
                "provider": provider.id(),
                "source": label,
                "seconds": seconds,
            }),
        );
    });
}

/// Get the absolute path to the templates.json file.
#[tauri::command]
pub fn get_templates_path(app: AppHandle) -> Result<String, String> {
    let path = templates_path(&app)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Path to the live session snapshot the built-in MCP server reads.
pub(crate) fn session_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("session.json"))
}

/// Write the live session snapshot (meeting status, transcript, todos,
/// evaluations) so MCP clients can read the current meeting state.
#[tauri::command]
pub fn write_session(app: AppHandle, json: String) -> Result<(), String> {
    let path = session_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}
