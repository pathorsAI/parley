//! Gemini Live adapter. Opens a BidiGenerateContent session with input-audio
//! transcription enabled, streams base64 pcm16 media chunks, and surfaces the
//! `serverContent.inputTranscription` text as segments.
//!
//! Note: Gemini Live does not diarize input audio and gives no per-word
//! timestamps, so segments are emitted under speaker 0 with zeroed timings.

use anyhow::{anyhow, Result};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use tauri::AppHandle;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::Message;

use super::common::{
    connect_with_headers, drive_session, LevelMeter, SegmentBuilder, TranscribeConfig, LEVEL_EVENT,
    TRANSCRIPT_EVENT,
};
use crate::audio::resample::pcm_to_le_bytes;
use crate::audio::TARGET_SAMPLE_RATE;

const GEMINI_BASE: &str =
    "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const DEFAULT_MODEL: &str = "gemini-2.0-flash-live-001";

#[derive(Deserialize, Default)]
struct GeminiTranscription {
    #[serde(default)]
    text: String,
}

#[derive(Deserialize, Default)]
struct GeminiServerContent {
    #[serde(rename = "inputTranscription", default)]
    input_transcription: Option<GeminiTranscription>,
    #[serde(rename = "turnComplete", default)]
    turn_complete: bool,
}

#[derive(Deserialize, Default)]
struct GeminiMessage {
    #[serde(rename = "serverContent", default)]
    server_content: Option<GeminiServerContent>,
}

pub async fn run_session(
    app: AppHandle,
    config: TranscribeConfig,
    source: &'static str,
    mut pcm_rx: UnboundedReceiver<Vec<i16>>,
) -> Result<()> {
    let url = format!("{GEMINI_BASE}?key={}", config.api_key);
    let ws = connect_with_headers(&url, &[]).await?;
    let (mut write, mut read) = ws.split();

    let model = if config.model.trim().is_empty() {
        DEFAULT_MODEL
    } else {
        config.model.as_str()
    };
    let model_path = if model.starts_with("models/") {
        model.to_string()
    } else {
        format!("models/{model}")
    };
    let setup = json!({
        "setup": {
            "model": model_path,
            "generationConfig": { "responseModalities": ["TEXT"] },
            "inputAudioTranscription": {}
        }
    });
    write.send(Message::Text(setup.to_string())).await?;
    eprintln!("[gemini:{source}] connected, model={model} (diarization unsupported → speaker 0)");

    let mime = format!("audio/pcm;rate={}", TARGET_SAMPLE_RATE);
    let mut meter = LevelMeter::new(app.clone(), source, LEVEL_EVENT);
    // Resolves with whether the input drained (normal stop) or a send failed
    // (dead socket) — drive_session reports the latter as a failure.
    let forward = async move {
        let b64 = base64::engine::general_purpose::STANDARD;
        let drained = loop {
            let Some(chunk) = pcm_rx.recv().await else {
                break true;
            };
            meter.push(&chunk);
            let bytes = pcm_to_le_bytes(&chunk);
            let data = b64.encode(&bytes);
            let msg = json!({
                "realtimeInput": { "mediaChunks": [ { "mimeType": mime, "data": data } ] }
            });
            if write.send(Message::Text(msg.to_string())).await.is_err() {
                break false;
            }
        };
        let _ = write.close().await;
        drained
    };

    let read_loop = async move {
        let mut builder = SegmentBuilder::new(app.clone(), source, TRANSCRIPT_EVENT);
        let mut interim = String::new();
        let mut msg_count: u64 = 0;
        while let Some(msg) = read.next().await {
            let payload = match msg {
                Ok(Message::Text(t)) => t.to_string(),
                Ok(Message::Binary(b)) => String::from_utf8_lossy(&b).into_owned(),
                Ok(Message::Close(frame)) => {
                    eprintln!("[gemini:{source}] closed by server: {frame:?}");
                    // Gemini Live signals terminal errors (bad key, quota,
                    // invalid setup) by closing with an abnormal code + reason
                    // rather than an in-band message. A normal close (1000)
                    // follows our own close.
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
                    eprintln!("[gemini:{source}] read error: {e}");
                    break;
                }
            };
            msg_count += 1;
            if msg_count <= 3 {
                eprintln!("[gemini:{source}] RX raw#{msg_count}: {payload}");
            }
            let m: GeminiMessage = match serde_json::from_str(&payload) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let Some(sc) = m.server_content else { continue };
            if let Some(tr) = sc.input_transcription {
                if !tr.text.is_empty() {
                    interim.push_str(&tr.text);
                    builder.emit_tail(&interim, 0, 0);
                }
            }
            if sc.turn_complete && !interim.trim().is_empty() {
                builder.push_final(interim.trim(), 0, 0, 0);
                builder.emit_committed();
                builder.endpoint();
                interim.clear();
                builder.emit_tail("", 0, 0); // clear the tail
            }
        }
        Ok(())
    };

    drive_session("gemini", forward, read_loop).await
}
