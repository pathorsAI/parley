//! Soniox realtime adapter. Streams PCM over a WebSocket and parses Soniox's
//! token stream (with speaker diarization) into transcript segments.

use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio_tungstenite::tungstenite::Message;

use super::common::{ensure_crypto_provider, LevelMeter, SegmentBuilder, TranscribeConfig};
use crate::audio::resample::pcm_to_le_bytes;
use crate::audio::TARGET_SAMPLE_RATE;

const SONIOX_WS_URL: &str = "wss://stt-rt.soniox.com/transcribe-websocket";

/// Soniox endpoint markers. `<end>` closes an utterance; `<fin>` is the final
/// token emitted when the whole stream ends.
const TOKEN_END: &str = "<end>";
const TOKEN_FIN: &str = "<fin>";

#[derive(Serialize)]
struct SonioxConfig<'a> {
    api_key: &'a str,
    model: &'a str,
    audio_format: &'a str,
    sample_rate: u32,
    num_channels: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    language_hints: Option<Vec<String>>,
    enable_endpoint_detection: bool,
    enable_speaker_diarization: bool,
}

#[derive(Deserialize, Default)]
struct SonioxToken {
    #[serde(default)]
    text: String,
    #[serde(default)]
    is_final: bool,
    #[serde(default)]
    start_ms: u64,
    #[serde(default)]
    end_ms: u64,
    /// Diarized speaker — Soniox sends this as a STRING (e.g. "1"), or omits it
    /// on control tokens like `<end>`. Parsed to a number in the read loop.
    #[serde(default)]
    speaker: String,
}

#[derive(Deserialize, Default)]
struct SonioxResponse {
    #[serde(default)]
    tokens: Vec<SonioxToken>,
    #[serde(default)]
    error_code: Option<i64>,
    #[serde(default)]
    error_message: Option<String>,
    #[serde(default)]
    finished: bool,
}

/// Run one Soniox realtime session: stream PCM from `pcm_rx`, parse the token
/// stream, and emit `transcript://segment` events tagged with `source`
/// ("me" for mic, "them" for system audio).
pub async fn run_session(
    app: AppHandle,
    config: TranscribeConfig,
    source: &'static str,
    mut pcm_rx: UnboundedReceiver<Vec<i16>>,
) -> Result<()> {
    ensure_crypto_provider();
    let (ws, _) = tokio_tungstenite::connect_async(SONIOX_WS_URL)
        .await
        .map_err(|e| anyhow!("connect failed: {e}"))?;
    let (mut write, mut read) = ws.split();

    let language_hints = if config.language_hints.is_empty() {
        None
    } else {
        Some(config.language_hints.clone())
    };
    let wire = SonioxConfig {
        api_key: &config.api_key,
        model: &config.model,
        audio_format: "pcm_s16le",
        sample_rate: TARGET_SAMPLE_RATE,
        num_channels: 1,
        language_hints,
        enable_endpoint_detection: true,
        enable_speaker_diarization: config.diarization,
    };
    write
        .send(Message::Text(serde_json::to_string(&wire)?.into()))
        .await?;
    eprintln!(
        "[soniox:{source}] connected, model={}, diarization={}",
        config.model, config.diarization
    );

    // Forward captured PCM, emit a level meter, keep the session alive, then
    // finalize and close.
    let mut meter = LevelMeter::new(app.clone(), source);
    let forward = async move {
        let mut total: u64 = 0;
        let mut next_log: u64 = TARGET_SAMPLE_RATE as u64;
        // Soniox closes with a 408 if it doesn't see traffic regularly; mirror
        // the SDK and send keep-alives on an interval.
        let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(2));
        keepalive.tick().await;

        loop {
            tokio::select! {
                maybe_chunk = pcm_rx.recv() => {
                    let Some(chunk) = maybe_chunk else { break };
                    meter.push(&chunk);
                    total += chunk.len() as u64;
                    if total >= next_log {
                        eprintln!("[soniox:{source}] TX {}s audio sent", total / TARGET_SAMPLE_RATE as u64);
                        next_log += TARGET_SAMPLE_RATE as u64;
                    }
                    let bytes = pcm_to_le_bytes(&chunk);
                    if write.send(Message::Binary(bytes.into())).await.is_err() {
                        break;
                    }
                }
                _ = keepalive.tick() => {
                    if write.send(Message::Text("{\"type\":\"keepalive\"}".to_string().into())).await.is_err() {
                        break;
                    }
                }
            }
        }
        let _ = write
            .send(Message::Text("{\"type\":\"finalize\"}".to_string().into()))
            .await;
        let _ = write.close().await;
    };

    // Read tokens → speaker-runs via the shared SegmentBuilder.
    let read_loop = async move {
        let mut builder = SegmentBuilder::new(app.clone(), source);
        let mut msg_count: u64 = 0;

        while let Some(msg) = read.next().await {
            let msg = match msg {
                Ok(m) => m,
                Err(e) => {
                    eprintln!("[soniox:{source}] read error: {e}");
                    break;
                }
            };
            let payload = match msg {
                Message::Text(t) => t.to_string(),
                Message::Binary(b) => String::from_utf8_lossy(&b).into_owned(),
                Message::Close(frame) => {
                    eprintln!("[soniox:{source}] socket closed by server: {frame:?}");
                    break;
                }
                _ => continue,
            };
            msg_count += 1;
            if msg_count <= 3 {
                eprintln!("[soniox:{source}] RX raw#{msg_count}: {payload}");
            }

            let resp: SonioxResponse = match serde_json::from_str(&payload) {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("[soniox:{source}] RX parse error: {e} — payload: {payload}");
                    continue;
                }
            };

            if let Some(code) = resp.error_code {
                eprintln!("[soniox:{source}] error {code}: {}", resp.error_message.unwrap_or_default());
                break;
            }

            let mut tail = String::new();
            let mut tail_speaker = builder.current_speaker();
            let mut tail_start = builder.current_end();
            let mut endpoint = false;

            for tok in &resp.tokens {
                if tok.text == TOKEN_END || tok.text == TOKEN_FIN {
                    endpoint = true;
                    continue;
                }
                let spk: i64 = tok.speaker.parse().unwrap_or(0);
                if tok.is_final {
                    builder.push_final(&tok.text, spk, tok.start_ms, tok.end_ms);
                } else {
                    if tail.is_empty() {
                        tail_speaker = spk;
                        tail_start = tok.start_ms;
                    }
                    tail.push_str(&tok.text);
                }
            }

            builder.emit_committed();
            builder.emit_tail(&tail, tail_speaker, tail_start);
            if endpoint {
                builder.endpoint();
            }
            if resp.finished {
                break;
            }
        }
    };

    tokio::join!(forward, read_loop);
    Ok(())
}
