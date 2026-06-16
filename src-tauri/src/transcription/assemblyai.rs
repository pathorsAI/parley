//! AssemblyAI streaming (v3) adapter. Streams pcm_s16le over a WebSocket and
//! turns each formatted "Turn" into a transcript segment.
//!
//! Note: v3 streaming does not provide speaker diarization, so every segment is
//! emitted under speaker 0 (a single speaker in the UI).

use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tauri::AppHandle;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio_tungstenite::tungstenite::Message;

use super::common::{connect_with_headers, LevelMeter, SegmentBuilder, TranscribeConfig};
use crate::audio::resample::pcm_to_le_bytes;
use crate::audio::TARGET_SAMPLE_RATE;

const AAI_BASE: &str = "wss://streaming.assemblyai.com/v3/ws";

#[derive(Deserialize, Default)]
struct AaiWord {
    #[serde(default)]
    start: u64,
    #[serde(default)]
    end: u64,
}

#[derive(Deserialize, Default)]
struct AaiMessage {
    #[serde(rename = "type", default)]
    msg_type: String,
    #[serde(default)]
    transcript: String,
    #[serde(default)]
    end_of_turn: bool,
    #[serde(default)]
    turn_is_formatted: bool,
    #[serde(default)]
    words: Vec<AaiWord>,
    #[serde(default)]
    error: Option<String>,
}

pub async fn run_session(
    app: AppHandle,
    config: TranscribeConfig,
    source: &'static str,
    mut pcm_rx: UnboundedReceiver<Vec<i16>>,
) -> Result<()> {
    let url = format!(
        "{AAI_BASE}?sample_rate={}&encoding=pcm_s16le&format_turns=true",
        TARGET_SAMPLE_RATE
    );
    // AssemblyAI takes the API key directly in the Authorization header.
    let ws = connect_with_headers(&url, &[("Authorization", config.api_key.clone())]).await?;
    let (mut write, mut read) = ws.split();
    eprintln!("[assemblyai:{source}] connected (diarization unsupported → speaker 0)");

    let mut meter = LevelMeter::new(app.clone(), source);
    let forward = async move {
        while let Some(chunk) = pcm_rx.recv().await {
            meter.push(&chunk);
            let bytes = pcm_to_le_bytes(&chunk);
            if write.send(Message::Binary(bytes.into())).await.is_err() {
                break;
            }
        }
        let _ = write.send(Message::Text("{\"type\":\"Terminate\"}".to_string().into())).await;
        let _ = write.close().await;
    };

    let read_loop = async move {
        let mut builder = SegmentBuilder::new(app.clone(), source);
        let mut msg_count: u64 = 0;
        while let Some(msg) = read.next().await {
            let payload = match msg {
                Ok(Message::Text(t)) => t.to_string(),
                Ok(Message::Binary(b)) => String::from_utf8_lossy(&b).into_owned(),
                Ok(Message::Close(frame)) => {
                    eprintln!("[assemblyai:{source}] closed by server: {frame:?}");
                    break;
                }
                Ok(_) => continue,
                Err(e) => {
                    eprintln!("[assemblyai:{source}] read error: {e}");
                    break;
                }
            };
            msg_count += 1;
            if msg_count <= 3 {
                eprintln!("[assemblyai:{source}] RX raw#{msg_count}: {payload}");
            }
            let m: AaiMessage = match serde_json::from_str(&payload) {
                Ok(m) => m,
                Err(e) => {
                    eprintln!("[assemblyai:{source}] parse error: {e}");
                    continue;
                }
            };
            if let Some(err) = m.error {
                eprintln!("[assemblyai:{source}] error: {err}");
                break;
            }
            if m.msg_type != "Turn" {
                continue; // Begin / Termination / etc.
            }
            let text = m.transcript.trim();
            if text.is_empty() {
                continue;
            }
            let start_ms = m.words.first().map(|w| w.start).unwrap_or(0);
            let end_ms = m.words.last().map(|w| w.end).unwrap_or(start_ms);

            if m.end_of_turn && m.turn_is_formatted {
                // The turn is settled and punctuated → commit it as one segment.
                builder.push_final(text, 0, start_ms, end_ms);
                builder.emit_committed();
                builder.endpoint();
                builder.emit_tail("", 0, end_ms); // clear the tail
            } else {
                // Cumulative interim hypothesis for the in-progress turn.
                builder.emit_tail(text, 0, start_ms);
            }
        }
    };

    tokio::join!(forward, read_loop);
    Ok(())
}
