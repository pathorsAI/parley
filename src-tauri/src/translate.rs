//! Live voice translation: microphone → Gemini Live Translate → output device.
//!
//! This is Parley's first *speech-to-speech* pipeline. Unlike the transcription
//! adapters (which only emit text), the translate session consumes the model's
//! **audio** output: it opens a `gemini-3.5-live-translate-preview` BidiGenerate
//! session with `responseModalities: ["AUDIO"]` + a `translationConfig`, streams
//! the mic's 16 kHz PCM up, and pushes the returned 24 kHz translated PCM into an
//! [`audio::playback`] sink that plays it out a chosen device.
//!
//! Phase 1 plays to any output device (headphones for validation). Phase 2 will
//! point the sink at a bundled "Parley Microphone" virtual device so apps like
//! Google Meet pick up the translated voice as if it were the user's mic.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc::UnboundedReceiver;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::Message;

use crate::audio::microphone::Microphone;
use crate::audio::playback::{start_playback, PlaybackHandle, PlaybackSink, TRANSLATE_OUTPUT_RATE};
use crate::audio::resample::pcm_to_le_bytes;
use crate::audio::TARGET_SAMPLE_RATE;
use crate::capture::{spawn_capture, Begin, MicCoordinator, MicUser};
use crate::transcription::common::{connect_with_headers, drive_session, LevelMeter, LEVEL_EVENT};

const GEMINI_BASE: &str =
    "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const DEFAULT_MODEL: &str = "gemini-3.5-live-translate-preview";

/// Status event: payload is `"running"` | `"stopped"`.
const STATUS_EVENT: &str = "translate://status";
/// Terminal-failure event: `{ code, message }`.
const ERROR_EVENT: &str = "translate://error";
/// Live transcript event: `{ input, output }` (in-flight interim text).
const TRANSCRIPT_EVENT: &str = "translate://transcript";

// ---------------------------------------------------------------------------
// Server-message shapes (only the fields we consume).
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
struct InlineData {
    #[serde(default)]
    data: String,
}

#[derive(Deserialize, Default)]
struct Part {
    #[serde(rename = "inlineData", default)]
    inline_data: Option<InlineData>,
}

#[derive(Deserialize, Default)]
struct ModelTurn {
    #[serde(default)]
    parts: Vec<Part>,
}

#[derive(Deserialize, Default)]
struct Transcription {
    #[serde(default)]
    text: String,
}

#[derive(Deserialize, Default)]
struct ServerContent {
    #[serde(rename = "modelTurn", default)]
    model_turn: Option<ModelTurn>,
    #[serde(rename = "inputTranscription", default)]
    input_transcription: Option<Transcription>,
    #[serde(rename = "outputTranscription", default)]
    output_transcription: Option<Transcription>,
    #[serde(rename = "turnComplete", default)]
    turn_complete: bool,
}

#[derive(Deserialize, Default)]
struct GeminiMessage {
    #[serde(rename = "serverContent", default)]
    server_content: Option<ServerContent>,
}

// ---------------------------------------------------------------------------
// Managed state.
// ---------------------------------------------------------------------------

/// Singleton guard for the live-translation session. Holds the session task, the
/// output-stream handle (kept alive for the session's lifetime), and a per-session
/// error mute so a failure that lands after a manual stop doesn't toast the user.
#[derive(Default)]
pub struct TranslateState {
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    playback: Mutex<Option<PlaybackHandle>>,
    error_mute: Mutex<Option<Arc<AtomicBool>>>,
}

/// List available output device names (for the settings picker).
#[tauri::command]
pub fn list_output_devices() -> Vec<String> {
    crate::audio::playback::list_output_devices()
}

/// Whether a live translation session is currently running.
#[tauri::command]
pub fn translate_active(coord: State<MicCoordinator>) -> bool {
    coord.owner() == Some(MicUser::Translate)
}

/// Start a live translation session: capture `input_device` (or the default mic),
/// translate to `target_language`, and play the translated audio out
/// `output_device` (or the default output).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn start_translate(
    app: AppHandle,
    coord: State<MicCoordinator>,
    state: State<TranslateState>,
    api_key: String,
    model: Option<String>,
    target_language: String,
    echo_target_language: Option<bool>,
    input_device: Option<String>,
    output_device: Option<String>,
) -> Result<(), String> {
    if api_key.trim().is_empty() {
        return Err("missing Gemini API key".into());
    }
    if target_language.trim().is_empty() {
        return Err("missing target language".into());
    }

    // Claim the mic. Translate is the top-priority full-mic user, so the
    // coordinator stops a meeting / dictation / mic test first; a second start
    // while already translating is an idempotent no-op.
    let gate = match coord.begin(MicUser::Translate) {
        Begin::Started(gate) => gate,
        Begin::AlreadyActive => return Ok(()),
        Begin::Busy(owner) => return Err(format!("microphone is in use by {owner:?}")),
    };

    // Capture the mic (16 kHz mono PCM).
    let mic = Microphone {
        device_name: input_device,
    };
    let pcm_rx = match spawn_capture(&coord, MicUser::Translate, mic, gate, "translate") {
        Ok(rx) => rx,
        Err(e) => {
            coord.stop(MicUser::Translate);
            return Err(e);
        }
    };

    // Open the output device the translated audio plays to.
    let (sink, playback) = match start_playback(output_device) {
        Ok(pair) => pair,
        Err(e) => {
            coord.stop(MicUser::Translate);
            return Err(format!("could not open output device: {e}"));
        }
    };
    *state.playback.lock().unwrap() = Some(playback);

    let error_mute = Arc::new(AtomicBool::new(false));
    *state.error_mute.lock().unwrap() = Some(error_mute.clone());

    let model = model
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let echo = echo_target_language.unwrap_or(true);
    let params = SessionParams {
        api_key,
        model,
        target_language,
        echo,
    };

    let task = tauri::async_runtime::spawn(run_translate_session(
        app.clone(),
        params,
        pcm_rx,
        sink,
        error_mute,
    ));
    *state.task.lock().unwrap() = Some(task);

    let _ = app.emit(STATUS_EVENT, "running");
    Ok(())
}

/// Stop the live translation session: release the mic (which drains the session),
/// stop playback, and abort the task as a backstop.
#[tauri::command]
pub fn stop_translate(app: AppHandle, coord: State<MicCoordinator>, state: State<TranslateState>) {
    // Mute first: from here the session is over, so a socket error raised during
    // teardown must not surface as a user-facing failure.
    if let Some(mute) = state.error_mute.lock().unwrap().as_ref() {
        mute.store(true, Ordering::SeqCst);
    }
    // Releasing the mic drops the capture sender → the forward loop drains →
    // drive_session awaits the final flush and the socket closes cleanly.
    coord.stop(MicUser::Translate);
    // Stop the output stream immediately (the sink, held by the task, keeps
    // draining harmlessly into a bounded buffer until the task ends).
    let _ = state.playback.lock().unwrap().take();

    // Backstop: if the socket never closes (stalled provider), abort after a
    // grace so a normal stop still lets the final flush complete first.
    if let Some(task) = state.task.lock().unwrap().take() {
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(4000)).await;
            task.abort();
        });
    }
    let _ = app.emit(STATUS_EVENT, "stopped");
}

struct SessionParams {
    api_key: String,
    model: String,
    target_language: String,
    echo: bool,
}

async fn run_translate_session(
    app: AppHandle,
    params: SessionParams,
    pcm_rx: UnboundedReceiver<Vec<i16>>,
    sink: PlaybackSink,
    error_mute: Arc<AtomicBool>,
) {
    let in_samples = Arc::new(AtomicU64::new(0));
    let out_samples = Arc::new(AtomicU64::new(0));
    let result = session_inner(
        app.clone(),
        &params,
        pcm_rx,
        sink,
        in_samples.clone(),
        out_samples.clone(),
    )
    .await;

    if let Err(e) = result {
        let msg = e.to_string();
        if error_mute.load(Ordering::SeqCst) {
            log::info!("[translate] session ended after stop — suppressing error: {msg}");
        } else {
            log::warn!("[translate] session failed: {msg}");
            let low = msg.to_lowercase();
            let code = if msg.contains("401")
                || msg.contains("403")
                || low.contains("unauthorized")
                || low.contains("api key")
            {
                "key"
            } else if msg.contains("429") || msg.contains("quota") {
                "quota"
            } else {
                "connect"
            };
            let _ = app.emit(ERROR_EVENT, json!({ "code": code, "message": msg }));
        }
    }

    // Bill the audio actually streamed (both directions are charged as audio
    // tokens — output audio is the expensive side; see the pricing memory).
    let in_seconds = in_samples.load(Ordering::SeqCst) as f64 / TARGET_SAMPLE_RATE as f64;
    let out_seconds = out_samples.load(Ordering::SeqCst) as f64 / TRANSLATE_OUTPUT_RATE as f64;
    let _ = app.emit(
        "usage://translate",
        json!({
            "model": params.model,
            "inputSeconds": in_seconds,
            "outputSeconds": out_seconds,
        }),
    );
}

async fn session_inner(
    app: AppHandle,
    params: &SessionParams,
    mut pcm_rx: UnboundedReceiver<Vec<i16>>,
    mut sink: PlaybackSink,
    in_samples: Arc<AtomicU64>,
    out_samples: Arc<AtomicU64>,
) -> Result<()> {
    let url = format!("{GEMINI_BASE}?key={}", params.api_key);
    let ws = connect_with_headers(&url, &[]).await?;
    let (mut write, mut read) = ws.split();

    let model_path = if params.model.starts_with("models/") {
        params.model.clone()
    } else {
        format!("models/{}", params.model)
    };
    let setup = json!({
        "setup": {
            "model": model_path,
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "inputAudioTranscription": {},
                "outputAudioTranscription": {},
                "translationConfig": {
                    "targetLanguageCode": params.target_language,
                    "echoTargetLanguage": params.echo,
                }
            }
        }
    });
    write.send(Message::Text(setup.to_string())).await?;
    log::info!(
        "[translate] connected, model={} → {}",
        params.model,
        params.target_language
    );

    let mime = format!("audio/pcm;rate={TARGET_SAMPLE_RATE}");
    let mut in_meter = LevelMeter::new(app.clone(), "translate-in", LEVEL_EVENT);
    // Resolves `true` when the mic drained (normal stop), `false` if a send
    // failed (dead socket) — drive_session reports the latter as a failure.
    let forward = async move {
        let b64 = base64::engine::general_purpose::STANDARD;
        loop {
            let Some(chunk) = pcm_rx.recv().await else {
                break true;
            };
            in_meter.push(&chunk);
            in_samples.fetch_add(chunk.len() as u64, Ordering::Relaxed);
            let data = b64.encode(pcm_to_le_bytes(&chunk));
            let msg = json!({
                "realtimeInput": { "mediaChunks": [ { "mimeType": mime, "data": data } ] }
            });
            if write.send(Message::Text(msg.to_string())).await.is_err() {
                break false;
            }
        }
    };

    let read_loop = async move {
        let b64 = base64::engine::general_purpose::STANDARD;
        let mut out_meter = LevelMeter::new(app.clone(), "translate-out", LEVEL_EVENT);
        let mut interim_in = String::new();
        let mut interim_out = String::new();
        while let Some(msg) = read.next().await {
            let payload = match msg {
                Ok(Message::Text(t)) => t.to_string(),
                Ok(Message::Binary(b)) => String::from_utf8_lossy(&b).into_owned(),
                Ok(Message::Close(frame)) => {
                    log::info!("[translate] closed by server: {frame:?}");
                    // Gemini Live signals terminal errors (bad key, quota, invalid
                    // setup) by closing with an abnormal code; a normal close (1000)
                    // follows our own close after a clean stop.
                    if let Some(f) = frame {
                        if f.code != CloseCode::Normal {
                            return Err(anyhow!(
                                "closed by server: {} {}",
                                u16::from(f.code),
                                f.reason
                            ));
                        }
                    }
                    break;
                }
                Ok(_) => continue,
                Err(e) => {
                    log::warn!("[translate] read error: {e}");
                    break;
                }
            };
            let m: GeminiMessage = match serde_json::from_str(&payload) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let Some(sc) = m.server_content else { continue };

            // Translated audio → jitter buffer → speakers/virtual mic.
            if let Some(turn) = sc.model_turn {
                for part in turn.parts {
                    let Some(inline) = part.inline_data else {
                        continue;
                    };
                    if inline.data.is_empty() {
                        continue;
                    }
                    let Ok(bytes) = b64.decode(inline.data.as_bytes()) else {
                        continue;
                    };
                    let pcm = le_bytes_to_pcm(&bytes);
                    out_samples.fetch_add(pcm.len() as u64, Ordering::Relaxed);
                    out_meter.push(&pcm);
                    sink.push(&pcm);
                }
            }

            // Optional live transcripts for the UI (source + translated text).
            if let Some(tr) = sc.input_transcription {
                interim_in.push_str(&tr.text);
            }
            if let Some(tr) = sc.output_transcription {
                interim_out.push_str(&tr.text);
            }
            let _ = app.emit(
                TRANSCRIPT_EVENT,
                json!({ "input": interim_in, "output": interim_out }),
            );
            if sc.turn_complete {
                interim_in.clear();
                interim_out.clear();
            }
        }
        Ok(())
    };

    drive_session("gemini-translate", forward, read_loop).await
}

/// Decode a raw s16le byte buffer into i16 PCM samples.
fn le_bytes_to_pcm(bytes: &[u8]) -> Vec<i16> {
    bytes
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect()
}
