use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use tauri::{AppHandle, Emitter, Manager, State};

use tokio::sync::mpsc::UnboundedReceiver;

use crate::audio::{microphone::Microphone, AudioSource};
use crate::transcription::common::{LevelMeter, LEVEL_EVENT};
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

/// Accumulates the live meeting's recorded PCM (16 kHz mono i16) so it can be
/// encoded to Ogg/Opus on stop and saved into the local history. `None` between
/// meetings; armed (`Some(empty)`) by `start_meeting` and drained by `stop_meeting`.
pub(crate) type RecorderBuf = Arc<Mutex<Option<Vec<i16>>>>;

/// Shared meeting state held in Tauri's managed state. `running` is the global
/// "a meeting is active" status (queried by the mic-test + UI). Capture threads,
/// however, watch a PER-SESSION `capture_gate` (not `running`) so a thread from a
/// previous meeting can never be revived by the next `start_meeting` flipping a
/// shared flag back to true — each meeting gets a fresh gate, and stop clears it.
#[derive(Default)]
pub struct MeetingState {
    running: Arc<AtomicBool>,
    /// Per-meeting capture flag handed to every capture thread of the CURRENT
    /// session. `start_meeting` installs a fresh one; `stop_meeting` clears it to
    /// tell exactly this session's threads to exit. A detached/wedged thread from
    /// an old session holds its own (already-false) gate, so a later meeting can't
    /// adopt or revive it. `None` between meetings.
    capture_gate: Mutex<Option<Arc<AtomicBool>>>,
    threads: Mutex<Vec<JoinHandle<()>>>,
    /// Live transcription session tasks (the per-source Soniox/etc. WebSocket
    /// loops). Held so `stop_meeting` can `abort()` them — a direct cancel that
    /// closes the socket even if the capture→channel-close cascade stalls, instead
    /// of letting the session linger and keep emitting transcript after stop.
    tasks: Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>,
    /// Separate flag for the Settings "test mic" preview (no Soniox).
    test_running: Arc<AtomicBool>,
    /// Buffers the recorded audio of the in-progress live meeting (see RecorderBuf).
    recorder: RecorderBuf,
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
    // The meeting owns the mic until it ends — never open a competing input stream
    // while recording. On macOS a second stream can make CoreAudio renegotiate the
    // device and silently kill the meeting's capture (transcription stops). The UI
    // also disables the test while recording; this is the reliable backstop.
    if state.running.load(Ordering::SeqCst) {
        return Ok(());
    }
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
        // Reuse the shared metering primitive so peak/window logic lives in one place.
        let mut meter = LevelMeter::new(app.clone(), "test");
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
pub fn stop_mic_test(state: State<MeetingState>) {
    state.test_running.store(false, Ordering::SeqCst);
}

/// Whether a live meeting is currently recording. The Settings UI uses this to
/// disable the mic test + device picker while recording (switching the input
/// mid-meeting can disrupt the meeting's capture).
#[tauri::command]
pub fn meeting_active(state: State<MeetingState>) -> bool {
    state.running.load(Ordering::SeqCst)
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
    // Tear down any Settings "test mic" stream so it can't contend with the
    // meeting's capture (its thread exits when this flag clears).
    state.test_running.store(false, Ordering::SeqCst);
    // Per-session capture gate: a FRESH flag owned by THIS meeting's capture threads
    // (not the global `state.running`). Installed in state so stop_meeting can clear
    // exactly this session's threads; a later start_meeting installs a new one, so a
    // detached/wedged thread from a prior session can never be revived. The var is
    // named `running` so the capture call sites below read naturally.
    let running = Arc::new(AtomicBool::new(true));
    *state.capture_gate.lock().unwrap() = Some(running.clone());
    // Arm a fresh recording buffer for this meeting (the designated session below
    // tees its PCM into it; stop_meeting encodes + clears it).
    *state.recorder.lock().unwrap() = Some(Vec::new());
    // Drop any (finished) session handles from a prior meeting before this one fills in.
    state.tasks.lock().unwrap().clear();
    let recorder = state.recorder.clone();
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
            // Tap the PRE-MIX mic for delivery coaching (issue #22): the prosody
            // analyzer must see raw mic, never the mixed/diarized stream.
            let rx_me = spawn_capture(&state, mic, running.clone(), "me")
                .map(|rx| spawn_mic_prosody_tap(&app, rx));
            let rx_them = spawn_capture(&state, sys, running.clone(), "them");
            let mut tasks = state.tasks.lock().unwrap();
            match (rx_me, rx_them) {
                (Some(a), Some(b)) => {
                    let (tx_mix, rx_mix) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
                    tauri::async_runtime::spawn(crate::audio::mixer::mix_streams(app.clone(), a, b, tx_mix));
                    // Record the mixed stream → the saved file holds both sides.
                    tasks.push(run_metered_session(&app, provider, make_config(), "mix", rx_mix, Some(recorder)));
                }
                // If one capture failed, transcribe + record whichever started.
                (Some(a), None) => {
                    tasks.push(run_metered_session(&app, provider, make_config(), "me", a, Some(recorder)));
                }
                (None, Some(b)) => {
                    tasks.push(run_metered_session(&app, provider, make_config(), "them", b, Some(recorder)));
                }
                (None, None) => {}
            }
        } else {
            // No diarization → two sessions. Record the mic only (mixing two
            // un-aligned streams into one file would garble it); see plan note.
            if let Some(rx) = spawn_capture(&state, mic, running.clone(), "me") {
                let rx = spawn_mic_prosody_tap(&app, rx);
                let task = run_metered_session(&app, provider, make_config(), "me", rx, Some(recorder));
                state.tasks.lock().unwrap().push(task);
            }
            if let Some(rx) = spawn_capture(&state, sys, running.clone(), "them") {
                let task = run_metered_session(&app, provider, make_config(), "them", rx, None);
                state.tasks.lock().unwrap().push(task);
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let mic = Microphone {
            device_name: input_device,
        };
        if let Some(rx) = spawn_capture(&state, mic, running.clone(), "me") {
            let rx = spawn_mic_prosody_tap(&app, rx);
            let task = run_metered_session(&app, provider, make_config(), "me", rx, Some(recorder));
            state.tasks.lock().unwrap().push(task);
        }
    }

    let _ = app.emit("meeting://status", "recording");
    Ok(())
}

#[tauri::command]
pub fn stop_meeting(app: AppHandle, state: State<MeetingState>) -> Result<(), String> {
    state.running.store(false, Ordering::SeqCst);
    // Tell THIS session's capture threads to exit. They watch the per-session gate,
    // not the global `running`; `take()` so the next meeting installs a fresh one and
    // can never reuse/revive this session's gate.
    if let Some(gate) = state.capture_gate.lock().unwrap().take() {
        gate.store(false, Ordering::SeqCst);
    }

    // Direct-cancel safety net for the transcription sessions. Clearing the gate
    // above starts the graceful capture→channel-close cascade, which closes the
    // socket and emits final usage. The abort is ONLY a backstop for a socket that
    // never closes (a stalled provider/network): wait a generous grace so even a slow
    // finalize completes first — aborting an already-finished task is a no-op, and
    // after stop no new audio flows, so the extra idle wait produces no new transcript.
    // (A short grace would cut a slow finalize and lose the last segment + usage event.)
    let tasks: Vec<tauri::async_runtime::JoinHandle<()>> =
        state.tasks.lock().unwrap().drain(..).collect();
    if !tasks.is_empty() {
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(8000)).await;
            for t in tasks {
                t.abort();
            }
        });
    }

    // Joining lets each capture thread release its device (drops its PCM sender,
    // which in turn ends the Soniox session via channel close). Capture threads
    // self-exit within ~100 ms of the gate clearing, but bound the wait so a wedged
    // thread (e.g. a stuck CoreAudio teardown) can't hang the stop command itself;
    // the session WebSocket is force-closed separately by the watchdog above. A
    // detached wedged thread is harmless: it holds a now-dead per-session gate, so a
    // later meeting (fresh gate) never adopts or revives it.
    let handles: Vec<JoinHandle<()>> = state.threads.lock().unwrap().drain(..).collect();
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1500);
    for h in handles {
        while !h.is_finished() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        if h.is_finished() {
            let _ = h.join();
        } else {
            log::warn!("stop_meeting: capture thread didn't exit within grace; detaching");
        }
    }
    let _ = app.emit("meeting://status", "stopped");

    // Encode the captured audio off-thread and tell the frontend where it landed
    // (which then writes the history entry). Skip very short / empty recordings.
    let pcm = state.recorder.lock().unwrap().take();
    if let Some(pcm) = pcm {
        let app = app.clone();
        std::thread::spawn(move || {
            let rate = crate::audio::TARGET_SAMPLE_RATE as usize;
            if pcm.len() < rate * 2 {
                log::info!("recording: too short to save ({} samples)", pcm.len());
                return;
            }
            let duration_ms = (pcm.len() as u64 * 1000) / rate as u64;
            let out = crate::replay_audio::unique_recording_path();
            match crate::replay_audio::encode_opus_ogg(&pcm, &out) {
                Ok(()) => {
                    log::info!(
                        "recording: saved {} ({} ms)",
                        out.to_string_lossy(),
                        duration_ms
                    );
                    let _ = app.emit(
                        "meeting://recording-saved",
                        serde_json::json!({
                            "path": out.to_string_lossy(),
                            "durationMs": duration_ms,
                        }),
                    );
                }
                Err(e) => log::error!("recording: encode failed: {e}"),
            }
        });
    }
    Ok(())
}

/// Delete a freshly-encoded live recording the frontend decided NOT to save —
/// e.g. an empty meeting with no transcript (likely an accidental Start/Stop).
/// `save_history_entry` removes the temp source when it moves it into an entry
/// folder; this is the matching cleanup for the skip path so the `.ogg` doesn't
/// orphan in the temp dir.
///
/// Guarded: only removes a file under the OS temp dir whose name matches our own
/// `parley-recording-*.ogg`, so it can never be coerced into deleting an
/// arbitrary path.
#[tauri::command]
pub fn discard_recording(path: String) {
    let p = std::path::Path::new(&path);
    let in_temp = p.starts_with(std::env::temp_dir());
    let looks_like_ours = p
        .file_name()
        .and_then(|f| f.to_str())
        .is_some_and(|f| f.starts_with("parley-recording-") && f.ends_with(".ogg"));
    if in_temp && looks_like_ours {
        match std::fs::remove_file(p) {
            Ok(()) => log::info!("recording: discarded unsaved {path}"),
            Err(e) => log::warn!("recording: discard failed for {path}: {e}"),
        }
    } else {
        log::warn!("recording: refused to discard non-recording path {path}");
    }
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

/// Copy a recording's audio file to a user-chosen destination (the replay
/// "Save audio…" action — the frontend picks `dst` via the save dialog).
#[tauri::command]
pub fn export_recording(src: String, dst: String) -> Result<(), String> {
    if !std::path::Path::new(&src).exists() {
        return Err(format!("source recording not found: {src}"));
    }
    std::fs::copy(&src, &dst).map_err(|e| e.to_string())?;
    Ok(())
}

/// Minimal percent-decoder for the loopback query (the token is encodeURIComponent'd).
fn urldecode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 3 <= b.len() => match u8::from_str_radix(&s[i + 1..i + 3], 16) {
                Ok(byte) => {
                    out.push(byte);
                    i += 3;
                }
                Err(_) => {
                    out.push(b[i]);
                    i += 1;
                }
            },
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Start a one-shot loopback server for the desktop Google-login handoff. The
/// cloud, after OAuth, redirects the browser to `http://127.0.0.1:<port>/cb?token=…`;
/// we capture that token, emit `auth://callback` to the frontend, show a
/// "you can close this tab" page, and stop. Returns the bound port immediately so
/// the caller can build the callback URL. Works in `tauri dev` (no URL-scheme
/// registration, unlike a custom-scheme deep link). Gives up after 5 minutes.
#[tauri::command]
pub fn start_oauth_loopback(app: AppHandle) -> Result<u16, String> {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener.set_nonblocking(true).ok();

    std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
        loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut buf = [0u8; 4096];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]);
                    // Request line: "GET /cb?token=… HTTP/1.1"
                    let path = req
                        .lines()
                        .next()
                        .and_then(|l| l.split_whitespace().nth(1))
                        .unwrap_or("");
                    let query = path.splitn(2, '?').nth(1).unwrap_or("");
                    let (mut token, mut error) = (None::<String>, None::<String>);
                    for pair in query.split('&') {
                        let mut kv = pair.splitn(2, '=');
                        match (kv.next(), kv.next()) {
                            (Some("token"), Some(v)) => token = Some(urldecode(v)),
                            (Some("error"), Some(v)) => error = Some(urldecode(v)),
                            _ => {}
                        }
                    }
                    let body = "<!doctype html><meta charset=utf-8><title>Parley</title>\
<body style=\"font-family:system-ui;padding:3rem;text-align:center;color:#333\">\
<h2>Parley</h2><p>登入完成，可以關閉這個分頁回到 Parley。</p>\
<p>You're signed in — close this tab and return to Parley.</p></body>";
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(resp.as_bytes());
                    let _ = stream.flush();
                    let _ = app.emit("auth://callback", serde_json::json!({ "token": token, "error": error }));
                    break;
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if std::time::Instant::now() > deadline {
                        let _ = app.emit("auth://callback", serde_json::json!({ "error": "timeout" }));
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(_) => break,
            }
        }
    });

    Ok(port)
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

/// Tee the mic ("me") PCM through a [`ProsodyAnalyzer`](crate::audio::prosody::ProsodyAnalyzer)
/// for live delivery coaching, forwarding every chunk untouched downstream.
/// Mirrors the sample `counter` in [`run_metered_session`]: one extra `Vec` move
/// per chunk, no measurable STT impact.
///
/// This is the single mic tap point and it sits BEFORE the mixer, so with
/// diarization on we analyze raw mic — never the mixed/diarized stream (the
/// issue #22 hard constraint: delivery is scored on "me" only).
fn spawn_mic_prosody_tap(
    app: &AppHandle,
    mut rx: UnboundedReceiver<Vec<i16>>,
) -> UnboundedReceiver<Vec<i16>> {
    let (tx, out_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut analyzer = crate::audio::prosody::ProsodyAnalyzer::new(app, "me");
        while let Some(chunk) = rx.recv().await {
            analyzer.push(&chunk);
            if tx.send(chunk).is_err() {
                break;
            }
        }
    });
    out_rx
}

/// Run a transcription session over `rx`, counting the audio streamed so the
/// frontend can bill it. Emits a `usage://stt` event when the session ends.
/// When `recorder` is `Some`, every chunk is also appended to it so the meeting
/// can be saved to history (only the designated session passes a recorder).
fn run_metered_session(
    app: &AppHandle,
    provider: SttProvider,
    config: TranscribeConfig,
    label: &'static str,
    rx: UnboundedReceiver<Vec<i16>>,
    recorder: Option<RecorderBuf>,
) -> tauri::async_runtime::JoinHandle<()> {
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
                // Tee into the recording buffer (kept while the meeting is armed).
                if let Some(rec) = &recorder {
                    if let Some(buf) = rec.lock().unwrap().as_mut() {
                        buf.extend_from_slice(&chunk);
                    }
                }
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
    })
}

/// Get the absolute path to the templates.json file.
#[tauri::command]
pub fn get_templates_path(app: AppHandle) -> Result<String, String> {
    let path = templates_path(&app)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Read the tail of the rotating field log (`<app_log_dir>/parley.log`) for the
/// live in-app log viewer. Returns at most `max_bytes` from the end; a partial
/// first line (from cutting mid-line) is dropped so callers always get whole
/// lines. Empty string if the file doesn't exist yet.
#[tauri::command]
pub fn read_log_tail(app: AppHandle, max_bytes: u64) -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};

    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    let path = dir.join("parley.log");
    let mut file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(e.to_string()),
    };
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let cap = max_bytes.max(1);
    let start = len.saturating_sub(cap);
    file.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| e.to_string())?;

    let mut text = String::from_utf8_lossy(&buf).into_owned();
    // Drop the leading partial line when we started mid-file.
    if start > 0 {
        if let Some(nl) = text.find('\n') {
            text = text.split_off(nl + 1);
        }
    }
    Ok(text)
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

/// Append-only queue of mutation commands the MCP server writes and the
/// frontend applies (add/check/remove todo, add/remove evaluation).
pub(crate) fn session_commands_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("session_commands.jsonl"))
}

/// Read the pending session-command queue (one JSON object per line). The
/// frontend polls this and applies commands it hasn't seen yet.
#[tauri::command]
pub fn read_session_commands(app: AppHandle) -> Result<String, String> {
    let path = session_commands_path(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(_) => Ok(String::new()),
    }
}
