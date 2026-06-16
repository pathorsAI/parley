//! OpenAI Realtime transcription adapter. Opens a realtime session in
//! transcription intent, streams base64 pcm16 audio, and assembles the
//! delta/completed transcription events into segments.
//!
//! Note: the realtime transcription API does not diarize, so every segment is
//! emitted under speaker 0.

use anyhow::Result;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use tauri::AppHandle;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio_tungstenite::tungstenite::Message;

use super::common::{connect_with_headers, LevelMeter, SegmentBuilder, TranscribeConfig};
use crate::audio::resample::pcm_to_le_bytes;

const OPENAI_RT_URL: &str = "wss://api.openai.com/v1/realtime?intent=transcription";
const DEFAULT_MODEL: &str = "gpt-4o-transcribe";

#[derive(Deserialize, Default)]
struct OaiEvent {
    #[serde(rename = "type", default)]
    event_type: String,
    #[serde(default)]
    delta: String,
    #[serde(default)]
    transcript: String,
}

pub async fn run_session(
    app: AppHandle,
    config: TranscribeConfig,
    source: &'static str,
    mut pcm_rx: UnboundedReceiver<Vec<i16>>,
) -> Result<()> {
    let ws = connect_with_headers(
        OPENAI_RT_URL,
        &[
            ("Authorization", format!("Bearer {}", config.api_key)),
            ("OpenAI-Beta", "realtime=v1".to_string()),
        ],
    )
    .await?;
    let (mut write, mut read) = ws.split();

    let model = if config.model.trim().is_empty() {
        DEFAULT_MODEL
    } else {
        config.model.as_str()
    };
    let mut transcription = json!({ "model": model });
    if let Some(lang) = config.language_hints.first() {
        transcription["language"] = json!(lang);
    }
    let setup = json!({
        "type": "transcription_session.update",
        "session": {
            "input_audio_format": "pcm16",
            "input_audio_transcription": transcription,
            "turn_detection": { "type": "server_vad", "silence_duration_ms": 500 }
        }
    });
    write.send(Message::Text(setup.to_string())).await?;
    eprintln!("[openai:{source}] connected, model={model} (diarization unsupported → speaker 0)");

    let mut meter = LevelMeter::new(app.clone(), source);
    let forward = async move {
        let b64 = base64::engine::general_purpose::STANDARD;
        while let Some(chunk) = pcm_rx.recv().await {
            meter.push(&chunk);
            let bytes = pcm_to_le_bytes(&chunk);
            let audio = b64.encode(&bytes);
            let msg = json!({ "type": "input_audio_buffer.append", "audio": audio });
            if write
                .send(Message::Text(msg.to_string()))
                .await
                .is_err()
            {
                break;
            }
        }
        let _ = write.close().await;
    };

    let read_loop = async move {
        let mut builder = SegmentBuilder::new(app.clone(), source);
        let mut interim = String::new();
        let mut msg_count: u64 = 0;
        while let Some(msg) = read.next().await {
            let payload = match msg {
                Ok(Message::Text(t)) => t.to_string(),
                Ok(Message::Binary(b)) => String::from_utf8_lossy(&b).into_owned(),
                Ok(Message::Close(frame)) => {
                    eprintln!("[openai:{source}] closed by server: {frame:?}");
                    break;
                }
                Ok(_) => continue,
                Err(e) => {
                    eprintln!("[openai:{source}] read error: {e}");
                    break;
                }
            };
            msg_count += 1;
            if msg_count <= 3 {
                eprintln!("[openai:{source}] RX raw#{msg_count}: {payload}");
            }
            let ev: OaiEvent = match serde_json::from_str(&payload) {
                Ok(e) => e,
                Err(_) => continue,
            };
            match ev.event_type.as_str() {
                "conversation.item.input_audio_transcription.delta" => {
                    interim.push_str(&ev.delta);
                    builder.emit_tail(&interim, 0, 0);
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
                }
                _ => {}
            }
        }
    };

    tokio::join!(forward, read_loop);
    Ok(())
}
