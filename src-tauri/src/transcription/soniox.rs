use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::UnboundedReceiver;
use tokio_tungstenite::tungstenite::Message;

use crate::audio::resample::pcm_to_le_bytes;
use crate::audio::TARGET_SAMPLE_RATE;

const SONIOX_WS_URL: &str = "wss://stt-rt.soniox.com/transcribe-websocket";

/// rustls 0.23 requires a process-wide default CryptoProvider before any TLS
/// handshake; installing it lazily (once) avoids the panic in the ws task.
fn ensure_crypto_provider() {
    use std::sync::Once;
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}
/// Event name the frontend listens on (see src/lib/tauriEvents.ts).
const TRANSCRIPT_EVENT: &str = "transcript://segment";

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

/// Payload emitted to the frontend for each transcript update.
#[derive(Clone, Serialize)]
struct TranscriptEvent {
    id: String,
    source: String,
    /// Diarized speaker number within this source (0 = unknown / single speaker).
    speaker: i64,
    text: String,
    is_final: bool,
    start_ms: u64,
    end_ms: u64,
}

/// Live input level (0.0–1.0) emitted ~10×/s so the UI can show a meter.
#[derive(Clone, Serialize)]
struct LevelEvent {
    source: String,
    level: f32,
}

/// Run one Soniox realtime session: stream PCM from `pcm_rx`, parse the token
/// stream, and emit `transcript://segment` events tagged with `source`
/// ("me" for mic, "them" for system audio). Returns when the audio channel
/// closes or the socket ends.
pub async fn run_session(
    app: AppHandle,
    api_key: String,
    model: String,
    source: &'static str,
    mut pcm_rx: UnboundedReceiver<Vec<i16>>,
) -> Result<()> {
    ensure_crypto_provider();
    let (ws, _) = tokio_tungstenite::connect_async(SONIOX_WS_URL)
        .await
        .map_err(|e| anyhow!("connect failed: {e}"))?;
    let (mut write, mut read) = ws.split();

    let config = SonioxConfig {
        api_key: &api_key,
        model: &model,
        audio_format: "pcm_s16le",
        sample_rate: TARGET_SAMPLE_RATE,
        num_channels: 1,
        language_hints: None,
        enable_endpoint_detection: true,
        enable_speaker_diarization: true,
    };
    write
        .send(Message::Text(serde_json::to_string(&config)?.into()))
        .await?;
    eprintln!("[soniox:{source}] connected, model={model}, diarization=on");

    // Forward captured PCM to Soniox, then signal end-of-audio with an empty
    // text frame and close the socket.
    let level_app = app.clone();
    let forward = async move {
        let mut peak: i32 = 0;
        let mut samples: u64 = 0;
        let mut total: u64 = 0;
        let mut next_log: u64 = TARGET_SAMPLE_RATE as u64; // log once per second of audio
        // ~10 Hz UI level updates (16 kHz / 1600 = 10 windows per second).
        const WINDOW: u64 = TARGET_SAMPLE_RATE as u64 / 10;
        // Soniox closes the session with a 408 "Request timeout" if it doesn't
        // see traffic regularly (e.g. during cpal startup or silent stretches).
        // Mirror the SDK and send keep-alives on an interval.
        let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(2));
        keepalive.tick().await; // consume the immediate first tick

        loop {
            tokio::select! {
                maybe_chunk = pcm_rx.recv() => {
                    let Some(chunk) = maybe_chunk else { break };
                    for &s in &chunk {
                        peak = peak.max((s as i32).abs());
                    }
                    samples += chunk.len() as u64;
                    total += chunk.len() as u64;
                    if samples >= WINDOW {
                        let level = (peak as f32 / 32767.0).clamp(0.0, 1.0);
                        let _ = level_app.emit(
                            "audio://level",
                            LevelEvent { source: source.to_string(), level },
                        );
                        peak = 0;
                        samples = 0;
                    }
                    if total >= next_log {
                        eprintln!(
                            "[soniox:{source}] TX {}s audio sent ({} samples, {} bytes)",
                            total / TARGET_SAMPLE_RATE as u64,
                            total,
                            total * 2
                        );
                        next_log += TARGET_SAMPLE_RATE as u64;
                    }
                    let bytes = pcm_to_le_bytes(&chunk);
                    if write.send(Message::Binary(bytes.into())).await.is_err() {
                        break;
                    }
                }
                _ = keepalive.tick() => {
                    if write
                        .send(Message::Text("{\"type\":\"keepalive\"}".to_string().into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
        // Tell Soniox to finalize and flush remaining tokens before closing.
        let _ = write
            .send(Message::Text("{\"type\":\"finalize\"}".to_string().into()))
            .await;
        let _ = write.close().await;
    };

    // Read tokens and turn them into speaker-runs. Consecutive final tokens with
    // the same diarized speaker accumulate into one committed segment; a speaker
    // change (or `<end>`) closes the run and starts the next. The current
    // tentative tail is emitted under a stable `{source}-tail` id.
    let read_loop = async move {
        let emit = |id: String, speaker: i64, text: String, is_final: bool, start: u64, end: u64| {
            let _ = app.emit(
                TRANSCRIPT_EVENT,
                TranscriptEvent {
                    id,
                    source: source.to_string(),
                    speaker,
                    text,
                    is_final,
                    start_ms: start,
                    end_ms: end,
                },
            );
        };

        let mut seg_index: u64 = 0;
        let mut logged_tokens = false;
        let mut msg_count: u64 = 0;
        let mut cur_speaker: i64 = -1; // -1 = no open run
        let mut cur_final = String::new();
        let mut cur_start = 0u64;
        let mut cur_end = 0u64;

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
            // Log the first few raw payloads in full to inspect the shape.
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

            // Per-response summary (when there's anything to report).
            if !resp.tokens.is_empty() || resp.finished {
                let joined: String = resp.tokens.iter().map(|t| t.text.as_str()).collect();
                let finals = resp.tokens.iter().filter(|t| t.is_final).count();
                eprintln!(
                    "[soniox:{source}] RX {} tokens ({} final) finished={} text={joined:?}",
                    resp.tokens.len(),
                    finals,
                    resp.finished
                );
            }

            if let Some(code) = resp.error_code {
                eprintln!(
                    "[soniox:{source}] error {code}: {}",
                    resp.error_message.unwrap_or_default()
                );
                break;
            }

            if !resp.tokens.is_empty() && !logged_tokens {
                logged_tokens = true;
                eprintln!(
                    "[soniox:{source}] receiving tokens (first batch: {})",
                    resp.tokens.iter().map(|t| t.text.as_str()).collect::<String>()
                );
            }

            let mut tail = String::new();
            let mut tail_speaker = cur_speaker.max(0);
            let mut tail_start = cur_end;
            let mut endpoint = false;

            for tok in &resp.tokens {
                if tok.text == TOKEN_END || tok.text == TOKEN_FIN {
                    endpoint = true;
                    continue;
                }
                let spk: i64 = tok.speaker.parse().unwrap_or(0);
                if tok.is_final {
                    if cur_speaker == -1 {
                        cur_speaker = spk;
                        cur_start = tok.start_ms;
                    } else if spk != cur_speaker {
                        // Speaker changed: close the current run.
                        if !cur_final.trim().is_empty() {
                            emit(format!("{source}-{seg_index}"), cur_speaker, cur_final.clone(), true, cur_start, cur_end);
                            seg_index += 1;
                        }
                        cur_speaker = spk;
                        cur_final.clear();
                        cur_start = tok.start_ms;
                    }
                    cur_final.push_str(&tok.text);
                    cur_end = tok.end_ms;
                } else {
                    if tail.is_empty() {
                        tail_speaker = spk;
                        tail_start = tok.start_ms;
                    }
                    tail.push_str(&tok.text);
                }
            }

            // The committed run is settled text — emit it solid (is_final=true).
            if !cur_final.trim().is_empty() {
                emit(format!("{source}-{seg_index}"), cur_speaker, cur_final.clone(), true, cur_start, cur_end);
            }
            // The tentative tail (empty text clears the previous tail in the UI).
            emit(format!("{source}-tail"), tail_speaker, tail.clone(), false, tail_start, tail_start);

            if endpoint {
                if !cur_final.trim().is_empty() {
                    emit(format!("{source}-{seg_index}"), cur_speaker, cur_final.clone(), true, cur_start, cur_end);
                    seg_index += 1;
                }
                cur_speaker = -1;
                cur_final.clear();
            }
            if resp.finished {
                break;
            }
        }
    };

    tokio::join!(forward, read_loop);
    Ok(())
}
