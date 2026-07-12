use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};

use tokio::sync::mpsc::UnboundedReceiver;

use crate::audio::microphone::Microphone;
use crate::capture::{
    run_metered_session, spawn_capture, Begin, MicCoordinator, MicTap, MicUser, RecorderBuf,
};
use crate::transcription::common::{LevelMeter, LEVEL_EVENT};
use crate::transcription::{SttProvider, TranscribeConfig};

/// Path to `name` inside the app config dir, where all of the app's small
/// config/state files (templates, session snapshot, command queue, voice
/// history) live.
pub(crate) fn app_config_file(app: &AppHandle, name: &str) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

/// Read an app-config file as a string, treating a missing file as empty (the
/// convention for every optional JSON/JSONL state file).
pub(crate) fn read_config_file(app: &AppHandle, name: &str) -> Result<String, String> {
    match std::fs::read_to_string(app_config_file(app, name)?) {
        Ok(s) => Ok(s),
        Err(_) => Ok(String::new()),
    }
}

/// Write an app-config file, creating the config dir on first use.
pub(crate) fn write_config_file(app: &AppHandle, name: &str, contents: &str) -> Result<(), String> {
    let path = app_config_file(app, name)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

/// Path to the shared templates file (app config dir). The local MCP server
/// reads/writes the same file so templates can be managed outside the app.
pub(crate) fn templates_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app_config_file(app, "templates.json")
}

/// Read the shared templates JSON (empty string if the file doesn't exist yet).
#[tauri::command]
pub fn read_templates(app: AppHandle) -> Result<String, String> {
    read_config_file(&app, "templates.json")
}

/// Write the shared templates JSON, creating the config dir if needed.
#[tauri::command]
pub fn write_templates(app: AppHandle, json: String) -> Result<(), String> {
    write_config_file(&app, "templates.json", &json)
}

/// Read the accounts (mini-CRM: companies/persons/threads/claims) JSON
/// (empty string if the file doesn't exist yet).
#[tauri::command]
pub fn read_accounts(app: AppHandle) -> Result<String, String> {
    read_config_file(&app, "accounts.json")
}

/// Write the accounts JSON, creating the config dir if needed.
#[tauri::command]
pub fn write_accounts(app: AppHandle, json: String) -> Result<(), String> {
    write_config_file(&app, "accounts.json", &json)
}

/// Read the stage-bundle overrides JSON (empty string if the file doesn't
/// exist). Builtin bundles live in the frontend; this file only carries user
/// overrides (whole-stage replace, see docs/design/stage-bundles.md S9).
#[tauri::command]
pub fn read_stage_bundles(app: AppHandle) -> Result<String, String> {
    read_config_file(&app, "stage-bundles.json")
}

/// Meeting-specific state held in Tauri's managed state. Who owns the mic (and
/// the capture threads/gate of the live session) lives in [`MicCoordinator`];
/// only what a meeting needs beyond its capture stays here.
#[derive(Default)]
pub struct MeetingState {
    /// Live transcription session tasks (the per-source Soniox/etc. WebSocket
    /// loops). Held so `stop_meeting` can `abort()` them — a direct cancel that
    /// closes the socket even if the capture→channel-close cascade stalls, instead
    /// of letting the session linger and keep emitting transcript after stop.
    tasks: Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>,
    /// This meeting's `meeting://error` mute (fresh per start, set on stop).
    /// Session tasks outlive `stop_meeting` by the flush/abort grace; a failure
    /// in that window must not tear down whatever meeting runs NEXT — see
    /// `run_metered_session`.
    error_mute: Mutex<Option<std::sync::Arc<std::sync::atomic::AtomicBool>>>,
    /// Buffers the recorded audio of the in-progress live meeting (see RecorderBuf).
    recorder: RecorderBuf,
    /// Output stream of the meeting-translate session (translated voice → the
    /// virtual mic / chosen device). Held so `stop_meeting` releases the device;
    /// `None` for meetings without translation.
    translate_playback: Mutex<Option<crate::audio::playback::PlaybackHandle>>,
    /// Interpreter-strip pause: while true the translate session drops mic
    /// uploads (silence to the counterpart, no billing). Reset on every start.
    translate_paused: std::sync::Arc<std::sync::atomic::AtomicBool>,
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

/// Whether a live meeting is currently recording. The Settings UI uses this to
/// disable the mic test + device picker while recording (switching the input
/// mid-meeting can disrupt the meeting's capture).
#[tauri::command]
pub fn meeting_active(coord: State<MicCoordinator>) -> bool {
    coord.owner() == Some(MicUser::Meeting)
}

/// Pause / resume the meeting-translate upload (the interpreter strip's ⏸).
/// While paused the counterpart hears silence and no audio tokens are billed.
/// Broadcasts `translate://paused` so every surface (in-window strip + floating
/// interpreter window) stays in sync regardless of which one toggled it.
#[tauri::command]
pub fn set_translate_paused(app: AppHandle, state: State<MeetingState>, paused: bool) {
    state
        .translate_paused
        .store(paused, std::sync::atomic::Ordering::SeqCst);
    let _ = app.emit("translate://paused", paused);
    log::info!("meeting-translate: paused={paused}");
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn start_meeting(
    app: AppHandle,
    state: State<MeetingState>,
    coord: State<MicCoordinator>,
    provider: String,
    api_key: String,
    model: Option<String>,
    language_hints: Option<Vec<String>>,
    diarization: Option<bool>,
    input_device: Option<String>,
    // Hosted "parley" mode: the cloud STT relay's `wss://` URL. When set,
    // `api_key` is the cloud Bearer token (not a vendor key) and the adapter
    // relays through this URL. Absent for BYOK providers.
    relay_url: Option<String>,
    // Meeting translation: when `translate_language` is set, the "me" side runs
    // through Gemini live-translate instead of the STT provider — bilingual
    // segments feed the transcript, and the translated voice plays out
    // `translate_output_device` (ideally the Parley virtual mic). The "them"
    // side keeps the configured STT provider. Requires `translate_api_key`
    // (a Gemini key — distinct from the STT provider's key).
    translate_language: Option<String>,
    translate_output_device: Option<String>,
    translate_api_key: Option<String>,
) -> Result<(), String> {
    let provider = SttProvider::from_id(&provider).map_err(|e| e.to_string())?;
    if api_key.trim().is_empty() {
        return Err("missing transcription API key".into());
    }
    let relay_endpoint = relay_url.filter(|u| !u.trim().is_empty());
    // Hosted mode's api_key is the cloud session token, which only the relay
    // accepts — streaming it straight to the vendor dies with an opaque
    // in-band auth error. Refuse loudly instead (a call site that forgot
    // relayUrl is a frontend bug).
    if provider == SttProvider::Parley && relay_endpoint.is_none() {
        return Err("hosted transcription requires the cloud relay URL".into());
    }
    // Meeting translation: validate up front (before the mic is claimed) so a
    // misconfigured start fails cleanly instead of half-starting.
    let translate_language = translate_language.filter(|l| !l.trim().is_empty());
    let translate_api_key = translate_api_key.filter(|k| !k.trim().is_empty());
    if translate_language.is_some() && translate_api_key.is_none() {
        return Err("meeting translation requires a Gemini API key".into());
    }
    // Claim the mic. A meeting outranks the Settings mic test and voice typing,
    // so the coordinator stops either one first (device released before our
    // capture opens); a second start while a meeting runs is an idempotent no-op.
    // The gate is per-session: stop_meeting clears exactly this session's
    // threads, and a detached/wedged thread from a prior session (holding its
    // own dead gate) can never be revived by a later start.
    let gate = match coord.begin(MicUser::Meeting) {
        Begin::Started(gate) => gate,
        Begin::AlreadyActive => return Ok(()),
        // Unreachable today (Meeting outranks everything), kept for safety.
        Begin::Busy(owner) => return Err(format!("microphone is in use by {owner:?}")),
    };
    // Arm a fresh recording buffer for this meeting (the designated session below
    // tees its PCM into it; stop_meeting encodes + clears it).
    *state.recorder.lock().unwrap() = Some(Vec::new());
    // Drop any (finished) session handles from a prior meeting before this one fills in.
    state.tasks.lock().unwrap().clear();
    // Arm THIS meeting's error mute (unset). The previous meeting's sessions
    // hold the previous Arc — already muted by its stop.
    let error_mute = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    *state.error_mute.lock().unwrap() = Some(error_mute.clone());
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
        relay_endpoint: relay_endpoint.clone(),
    };

    // Diarizing providers separate speakers themselves, so mix mic + system
    // into ONE session (1x cost) and let diarization label speakers. Providers
    // without diarization keep two sessions so "me"/"them" stays deterministic.
    #[cfg(target_os = "macos")]
    {
        let mic = Microphone {
            device_name: input_device,
        };
        let sys = crate::audio::system_macos::SystemAudio { app: app.clone() };
        // Shared far-end state: the system-audio tap feeds it, the mic prosody
        // tap reads it to reject the counterpart's voice bleeding through the
        // speakers into the mic (pace/intonation must score "me" only).
        let far = std::sync::Arc::new(crate::audio::prosody::FarEndState::new());
        if let Some(lang) = translate_language {
            // ── Translated meeting ─────────────────────────────────────────
            // "me" runs through Gemini live-translate (bilingual segments +
            // translated voice → the chosen output / virtual mic) instead of
            // the STT provider; "them" keeps the provider — two sessions, so
            // recording follows the non-diarized convention (mic only).
            let gemini_key = translate_api_key.expect("validated above");
            let rx_me = spawn_capture(&coord, MicUser::Meeting, mic, gate.clone(), "me")
                .ok()
                .map(|rx| {
                    let rx = spawn_mic_prosody_tap(&app, rx, Some(far.clone()));
                    spawn_recorder_tee(rx, recorder.clone())
                });
            let Some(rx_me) = rx_me else {
                // Translation without the mic is meaningless — fail the start
                // (the frontend rolls its meeting state back on the error).
                coord.stop(MicUser::Meeting);
                log::error!("meeting: translate mode requested but the mic could not start");
                return Err("microphone could not be started".into());
            };
            state
                .translate_paused
                .store(false, std::sync::atomic::Ordering::SeqCst);
            match crate::translate::spawn_meeting_translate(
                &app,
                gemini_key,
                lang,
                translate_output_device,
                rx_me,
                error_mute.clone(),
                state.translate_paused.clone(),
            ) {
                Ok((task, playback)) => {
                    state.tasks.lock().unwrap().push(task);
                    *state.translate_playback.lock().unwrap() = Some(playback);
                }
                Err(e) => {
                    coord.stop(MicUser::Meeting);
                    return Err(e);
                }
            }
            if let Ok(rx) = spawn_capture(&coord, MicUser::Meeting, sys, gate.clone(), "them") {
                let rx = spawn_farend_tap(rx, far);
                state.tasks.lock().unwrap().push(run_metered_session(
                    &app,
                    provider,
                    make_config(),
                    "them",
                    rx,
                    None,
                    "meeting://error",
                    Some(error_mute.clone()),
                    // No release cutoff — meetings end via stop, not key-up.
                    None,
                ));
            }
        } else if diarization {
            // Tap the PRE-MIX mic for delivery coaching (issue #22): the prosody
            // analyzer must see raw mic, never the mixed/diarized stream.
            let rx_me = spawn_capture(&coord, MicUser::Meeting, mic, gate.clone(), "me")
                .ok()
                .map(|rx| spawn_mic_prosody_tap(&app, rx, Some(far.clone())));
            let rx_them = spawn_capture(&coord, MicUser::Meeting, sys, gate.clone(), "them")
                .ok()
                .map(|rx| spawn_farend_tap(rx, far));
            let mut tasks = state.tasks.lock().unwrap();
            log::info!(
                "meeting: capture started (mic: {}, system: {})",
                rx_me.is_some(),
                rx_them.is_some()
            );
            match (rx_me, rx_them) {
                (Some(a), Some(b)) => {
                    let (tx_mix, rx_mix) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
                    tauri::async_runtime::spawn(crate::audio::mixer::mix_streams(
                        app.clone(),
                        a,
                        b,
                        tx_mix,
                    ));
                    // Record the mixed stream → the saved file holds both sides.
                    tasks.push(run_metered_session(
                        &app,
                        provider,
                        make_config(),
                        "mix",
                        rx_mix,
                        Some(recorder),
                        "meeting://error",
                        Some(error_mute.clone()),
                        None,
                    ));
                }
                // If one capture failed, transcribe + record whichever started.
                (Some(a), None) => {
                    tasks.push(run_metered_session(
                        &app,
                        provider,
                        make_config(),
                        "me",
                        a,
                        Some(recorder),
                        "meeting://error",
                        Some(error_mute.clone()),
                        None,
                    ));
                }
                (None, Some(b)) => {
                    tasks.push(run_metered_session(
                        &app,
                        provider,
                        make_config(),
                        "them",
                        b,
                        Some(recorder),
                        "meeting://error",
                        Some(error_mute.clone()),
                        None,
                    ));
                }
                (None, None) => {
                    // No capture at all — without this the meeting would sit in
                    // "recording" forever with an empty transcript. Release the
                    // mic claim too: nothing is capturing, so voice typing / the
                    // mic test shouldn't stay locked out until the frontend
                    // reacts to the error (its stop_meeting is a no-op by then).
                    coord.stop(MicUser::Meeting);
                    log::error!("meeting: no audio source could be started");
                    let _ = app.emit(
                        "meeting://error",
                        serde_json::json!({
                            "source": "meeting",
                            "code": "capture",
                            "message": "no audio source could be started",
                        }),
                    );
                }
            }
        } else {
            // No diarization → two sessions. Record the mic only (mixing two
            // un-aligned streams into one file would garble it); see plan note.
            let mut tasks = state.tasks.lock().unwrap();
            if let Ok(rx) = spawn_capture(&coord, MicUser::Meeting, mic, gate.clone(), "me") {
                let rx = spawn_mic_prosody_tap(&app, rx, Some(far.clone()));
                tasks.push(run_metered_session(
                    &app,
                    provider,
                    make_config(),
                    "me",
                    rx,
                    Some(recorder),
                    "meeting://error",
                    Some(error_mute.clone()),
                    None,
                ));
            }
            if let Ok(rx) = spawn_capture(&coord, MicUser::Meeting, sys, gate.clone(), "them") {
                let rx = spawn_farend_tap(rx, far);
                tasks.push(run_metered_session(
                    &app,
                    provider,
                    make_config(),
                    "them",
                    rx,
                    None,
                    "meeting://error",
                    Some(error_mute.clone()),
                    None,
                ));
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Meeting translation is wired in the macOS path only for now (the
        // product ships macOS-first); reference the params so non-mac dev
        // builds stay warning-free.
        let _ = (&translate_language, &translate_output_device, &translate_api_key);
        let mic = Microphone {
            device_name: input_device,
        };
        if let Ok(rx) = spawn_capture(&coord, MicUser::Meeting, mic, gate.clone(), "me") {
            // No system capture on this platform → no far-end reference to gate on.
            let rx = spawn_mic_prosody_tap(&app, rx, None);
            let task = run_metered_session(
                &app,
                provider,
                make_config(),
                "me",
                rx,
                Some(recorder),
                "meeting://error",
                Some(error_mute.clone()),
                None,
            );
            state.tasks.lock().unwrap().push(task);
        }
    }

    let _ = app.emit("meeting://status", "recording");
    Ok(())
}

#[tauri::command]
pub fn stop_meeting(
    app: AppHandle,
    state: State<MeetingState>,
    coord: State<MicCoordinator>,
) -> Result<(), String> {
    // Direct-cancel safety net for the transcription sessions. Stopping the
    // capture below starts the graceful capture→channel-close cascade, which
    // closes the socket and emits final usage. The abort is ONLY a backstop for a
    // socket that never closes (a stalled provider/network): wait a generous grace
    // so even a slow finalize completes first — aborting an already-finished task
    // is a no-op, and after stop no new audio flows, so the extra idle wait
    // produces no new transcript. (A short grace would cut a slow finalize and
    // lose the last segment + usage event.)
    // From this point the meeting is over: a failure inside the flush/abort
    // grace below belongs to THIS (ended) meeting, and raising meeting://error
    // for it would tear down whatever meeting the user starts next (or toast a
    // spurious failure). Mute FIRST — before anything below can make a session
    // fail — then release the tasks; run_metered_session logs instead.
    if let Some(mute) = state.error_mute.lock().unwrap().as_ref() {
        mute.store(true, std::sync::atomic::Ordering::SeqCst);
    }
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

    // Clear this session's gate and join its capture threads (bounded grace) so
    // each releases its device — dropping its PCM sender, which ends the STT
    // session via channel close. See MicCoordinator for the gate/detach story.
    coord.stop(MicUser::Meeting);
    // Release the meeting-translate output stream (no-op for untranslated
    // meetings). The sink held by the (draining) session task keeps writing
    // into a bounded buffer harmlessly until the task ends.
    let _ = state.translate_playback.lock().unwrap().take();
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
                    let query = path.split_once('?').map_or("", |(_, q)| q);
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
                    let _ = app.emit(
                        "auth://callback",
                        serde_json::json!({ "token": token, "error": error }),
                    );
                    break;
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if std::time::Instant::now() > deadline {
                        let _ =
                            app.emit("auth://callback", serde_json::json!({ "error": "timeout" }));
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

/// Tee the mic ("me") PCM through a [`ProsodyAnalyzer`](crate::audio::prosody::ProsodyAnalyzer)
/// for live delivery coaching, forwarding every chunk untouched downstream.
/// Mirrors the sample `counter` in [`run_metered_session`]: one extra `Vec` move
/// per chunk, no measurable STT impact.
///
/// This is the single mic tap point and it sits BEFORE the mixer, so with
/// diarization on we analyze raw mic — never the mixed/diarized stream (the
/// issue #22 hard constraint: delivery is scored on "me" only). `far` is the
/// counterpart's shared acoustic state (from [`spawn_farend_tap`]) used to
/// reject the far voice leaking through the SPEAKERS into the mic — without it,
/// a speakers-only setup scores the other side's pace/intonation as the user's.
fn spawn_mic_prosody_tap(
    app: &AppHandle,
    mut rx: UnboundedReceiver<Vec<i16>>,
    far: Option<std::sync::Arc<crate::audio::prosody::FarEndState>>,
) -> UnboundedReceiver<Vec<i16>> {
    let (tx, out_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
    let app = app.clone();
    // Also the feed point for the voice-typing mic tee (see MicTap): while a
    // dictation session is subscribed, every raw-mic chunk is cloned to it.
    let tap = app.state::<MicTap>().inner().clone();
    tap.source_started();
    tauri::async_runtime::spawn(async move {
        let mut analyzer = crate::audio::prosody::ProsodyAnalyzer::new(app, "me", far);
        while let Some(chunk) = rx.recv().await {
            analyzer.push(&chunk);
            tap.forward(&chunk);
            if tx.send(chunk).is_err() {
                break;
            }
        }
        tap.source_ended();
    });
    out_rx
}

/// Tee PCM into the meeting's recording buffer, forwarding every chunk
/// untouched downstream. The translate path needs this standalone tee because
/// its session doesn't go through [`run_metered_session`] (which does the
/// recorder tee for STT sessions).
#[cfg(target_os = "macos")]
fn spawn_recorder_tee(
    mut rx: UnboundedReceiver<Vec<i16>>,
    recorder: RecorderBuf,
) -> UnboundedReceiver<Vec<i16>> {
    let (tx, out_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
    tauri::async_runtime::spawn(async move {
        while let Some(chunk) = rx.recv().await {
            if let Some(buf) = recorder.lock().unwrap().as_mut() {
                buf.extend_from_slice(&chunk);
            }
            if tx.send(chunk).is_err() {
                break;
            }
        }
    });
    out_rx
}

/// Tee the system-audio ("them") PCM through a
/// [`FarEndAnalyzer`](crate::audio::prosody::FarEndAnalyzer) that feeds the
/// shared far-end state for speaker-bleed rejection, forwarding every chunk
/// untouched downstream. Counterpart of [`spawn_mic_prosody_tap`].
#[cfg(target_os = "macos")]
fn spawn_farend_tap(
    mut rx: UnboundedReceiver<Vec<i16>>,
    far: std::sync::Arc<crate::audio::prosody::FarEndState>,
) -> UnboundedReceiver<Vec<i16>> {
    let (tx, out_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
    tauri::async_runtime::spawn(async move {
        let mut analyzer = crate::audio::prosody::FarEndAnalyzer::new(far);
        while let Some(chunk) = rx.recv().await {
            analyzer.push(&chunk);
            if tx.send(chunk).is_err() {
                break;
            }
        }
    });
    out_rx
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
    file.seek(SeekFrom::Start(start))
        .map_err(|e| e.to_string())?;
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
    app_config_file(app, "session.json")
}

/// Write the live session snapshot (meeting status, transcript, todos,
/// evaluations) so MCP clients can read the current meeting state.
#[tauri::command]
pub fn write_session(app: AppHandle, json: String) -> Result<(), String> {
    write_config_file(&app, "session.json", &json)
}

/// Append-only queue of mutation commands the MCP server writes and the
/// frontend applies (add/check/remove todo, add/remove evaluation).
pub(crate) fn session_commands_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app_config_file(app, "session_commands.jsonl")
}

/// Read the pending session-command queue (one JSON object per line). The
/// frontend polls this and applies commands it hasn't seen yet.
#[tauri::command]
pub fn read_session_commands(app: AppHandle) -> Result<String, String> {
    read_config_file(&app, "session_commands.jsonl")
}

/// Append-only results file for RPC-style session commands: the MCP server
/// enqueues a command carrying an `id`, the frontend executes it and appends
/// `{ id, ok, data|error }` here, and the MCP handler polls for its id.
pub(crate) fn session_command_results_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app_config_file(app, "session_command_results.jsonl")
}

/// Append one RPC command result (a JSON object line) for the MCP server to
/// pick up. Called by the frontend after executing a command that carried an id.
#[tauri::command]
pub fn append_session_command_result(app: AppHandle, json: String) -> Result<(), String> {
    use std::io::Write;
    let path = session_command_results_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(file, "{}", json.trim()).map_err(|e| e.to_string())
}
