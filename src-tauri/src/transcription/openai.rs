//! OpenAI Realtime transcription adapter. Opens a realtime session in
//! transcription intent, streams base64 pcm16 audio, and assembles the
//! delta/completed transcription events into segments.
//!
//! Note: the realtime transcription API does not diarize, so every segment is
//! emitted under speaker 0.

use anyhow::{anyhow, Result};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use tauri::AppHandle;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio_tungstenite::tungstenite::Message;

use super::common::{
    clean_vocabulary, connect_with_headers, drive_session, LevelMeter, SegmentBuilder,
    TranscribeConfig, LEVEL_EVENT, TRANSCRIPT_EVENT,
};
use super::ws::{self, Next, OnClose, Pump, WsRead, WsWrite};
use crate::audio::resample::pcm_to_le_bytes;

const OPENAI_RT_URL: &str = "wss://api.openai.com/v1/realtime?intent=transcription";
const DEFAULT_MODEL: &str = "gpt-4o-transcribe";

#[derive(Deserialize, Default)]
struct OaiError {
    #[serde(default)]
    message: String,
}

#[derive(Deserialize, Default)]
struct OaiEvent {
    #[serde(rename = "type", default)]
    event_type: String,
    #[serde(default)]
    delta: String,
    #[serde(default)]
    transcript: String,
    /// Present on `error` events — the session-level failure detail.
    #[serde(default)]
    error: Option<OaiError>,
}

/// Build the realtime session's `transcription_session.update` frame.
///
/// Custom vocabulary rides on the transcription `prompt` — the only biasing
/// hook the realtime transcription session exposes. Whisper-style prompts are
/// free text, and a comma-separated term list is the shape OpenAI documents for
/// steering spelling.
fn setup_frame(config: &TranscribeConfig, model: &str) -> serde_json::Value {
    let mut transcription = json!({ "model": model });
    if let Some(lang) = config.language_hints.first() {
        transcription["language"] = json!(lang);
    }
    let terms = clean_vocabulary(&config.vocabulary);
    if !terms.is_empty() {
        transcription["prompt"] = json!(terms.join(", "));
    }
    json!({
        "type": "transcription_session.update",
        "session": {
            "input_audio_format": "pcm16",
            "input_audio_transcription": transcription,
            "turn_detection": { "type": "server_vad", "silence_duration_ms": 500 }
        }
    })
}

/// Stream PCM as base64 append events. The realtime session has no keepalive or
/// goodbye frame — closing the write half is the whole shutdown.
async fn forward_audio(
    write: WsWrite,
    meter: LevelMeter,
    pcm_rx: UnboundedReceiver<Vec<i16>>,
) -> bool {
    let b64 = base64::engine::general_purpose::STANDARD;
    ws::forward_audio(write, meter, pcm_rx, Pump::default(), move |chunk| {
        let audio = b64.encode(pcm_to_le_bytes(chunk));
        let msg = json!({ "type": "input_audio_buffer.append", "audio": audio });
        Message::Text(msg.to_string())
    })
    .await
}

/// Fold one transcription event into the segment builder. Returns the terminal
/// error when the event is a session-level `error` — the server stops
/// transcribing after it, so it must be surfaced (see `run_metered_session`)
/// instead of logged into the void.
fn apply_event(
    builder: &mut SegmentBuilder,
    interim: &mut String,
    ev: OaiEvent,
    source: &str,
    payload: &str,
) -> Option<anyhow::Error> {
    match ev.event_type.as_str() {
        "conversation.item.input_audio_transcription.delta" => {
            interim.push_str(&ev.delta);
            builder.emit_tail(interim, 0, 0);
        }
        "conversation.item.input_audio_transcription.completed" => {
            let text = if ev.transcript.is_empty() {
                interim.clone()
            } else {
                ev.transcript
            };
            if !text.trim().is_empty() {
                builder.push_final(text.trim(), 0, 0, 0);
                builder.emit_committed();
                builder.endpoint();
            }
            interim.clear();
            builder.emit_tail("", 0, 0); // clear the tail
        }
        "error" => {
            eprintln!("[openai:{source}] error event: {payload}");
            let detail = ev
                .error
                .map(|e| e.message)
                .filter(|m| !m.is_empty())
                .unwrap_or_else(|| "server error".to_string());
            return Some(anyhow!("{detail}"));
        }
        _ => {}
    }
    None
}

/// Parse server events into transcript segments until the socket ends or a
/// terminal error event arrives.
async fn read_transcripts(app: AppHandle, source: &'static str, read: WsRead) -> Result<()> {
    let mut builder = SegmentBuilder::new(app, source, TRANSCRIPT_EVENT);
    let mut interim = String::new();
    ws::read_frames("openai", source, read, OnClose::Stop, |payload| {
        let Ok(ev) = serde_json::from_str::<OaiEvent>(payload) else {
            return Ok(Next::Continue);
        };
        match apply_event(&mut builder, &mut interim, ev, source, payload) {
            Some(err) => Err(err),
            None => Ok(Next::Continue),
        }
    })
    .await
}

pub async fn run_session(
    app: AppHandle,
    config: TranscribeConfig,
    source: &'static str,
    pcm_rx: UnboundedReceiver<Vec<i16>>,
) -> Result<()> {
    let ws = connect_with_headers(
        OPENAI_RT_URL,
        &[
            ("Authorization", format!("Bearer {}", config.api_key)),
            ("OpenAI-Beta", "realtime=v1".to_string()),
        ],
    )
    .await?;
    let (mut write, read) = ws.split();

    let model = if config.model.trim().is_empty() {
        DEFAULT_MODEL
    } else {
        config.model.as_str()
    };
    let setup = setup_frame(&config, model);
    write.send(Message::Text(setup.to_string())).await?;
    eprintln!("[openai:{source}] connected, model={model} (diarization unsupported → speaker 0)");

    let meter = LevelMeter::new(app.clone(), source, LEVEL_EVENT);

    drive_session(
        "openai",
        forward_audio(write, meter, pcm_rx),
        read_transcripts(app, source, read),
    )
    .await
}
