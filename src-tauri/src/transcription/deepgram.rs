//! Deepgram realtime adapter. Streams linear16 PCM over a WebSocket and parses
//! Deepgram's `Results` messages (with optional word-level diarization).

use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
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

const DEEPGRAM_BASE: &str = "wss://api.deepgram.com/v1/listen";
const DEFAULT_MODEL: &str = "nova-3";

#[derive(Deserialize, Default)]
struct DgWord {
    #[serde(default)]
    word: String,
    #[serde(default)]
    punctuated_word: Option<String>,
    #[serde(default)]
    start: f64,
    #[serde(default)]
    end: f64,
    #[serde(default)]
    speaker: Option<i64>,
}

#[derive(Deserialize, Default)]
struct DgAlternative {
    #[serde(default)]
    transcript: String,
    #[serde(default)]
    words: Vec<DgWord>,
}

#[derive(Deserialize, Default)]
struct DgChannel {
    #[serde(default)]
    alternatives: Vec<DgAlternative>,
}

#[derive(Deserialize, Default)]
struct DgResponse {
    #[serde(rename = "type", default)]
    msg_type: String,
    #[serde(default)]
    channel: DgChannel,
    #[serde(default)]
    is_final: bool,
    #[serde(default)]
    speech_final: bool,
}

pub async fn run_session(
    app: AppHandle,
    config: TranscribeConfig,
    source: &'static str,
    mut pcm_rx: UnboundedReceiver<Vec<i16>>,
) -> Result<()> {
    let model = if config.model.trim().is_empty() {
        DEFAULT_MODEL
    } else {
        config.model.as_str()
    };
    let mut url = format!(
        "{DEEPGRAM_BASE}?encoding=linear16&sample_rate={}&channels=1&interim_results=true&punctuate=true&smart_format=true&model={model}",
        TARGET_SAMPLE_RATE
    );
    if config.diarization {
        url.push_str("&diarize=true");
    }
    if let Some(lang) = config.language_hints.first() {
        url.push_str(&format!("&language={lang}"));
    }

    let ws = connect_with_headers(
        &url,
        &[("Authorization", format!("Token {}", config.api_key))],
    )
    .await?;
    let (mut write, mut read) = ws.split();
    eprintln!(
        "[deepgram:{source}] connected, model={model}, diarization={}",
        config.diarization
    );

    // Forward PCM as binary frames; keep alive; close cleanly. Resolves with
    // whether the input drained (normal stop) or a send failed (dead socket).
    let mut meter = LevelMeter::new(app.clone(), source, LEVEL_EVENT);
    let forward = async move {
        let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(5));
        keepalive.tick().await;
        let drained = loop {
            tokio::select! {
                maybe_chunk = pcm_rx.recv() => {
                    let Some(chunk) = maybe_chunk else { break true };
                    meter.push(&chunk);
                    let bytes = pcm_to_le_bytes(&chunk);
                    if write.send(Message::Binary(bytes)).await.is_err() {
                        break false;
                    }
                }
                _ = keepalive.tick() => {
                    if write.send(Message::Text("{\"type\":\"KeepAlive\"}".to_string())).await.is_err() {
                        break false;
                    }
                }
            }
        };
        let _ = write
            .send(Message::Text("{\"type\":\"CloseStream\"}".to_string()))
            .await;
        let _ = write.close().await;
        drained
    };

    let read_loop = async move {
        let mut builder = SegmentBuilder::new(app.clone(), source, TRANSCRIPT_EVENT);
        let mut msg_count: u64 = 0;
        while let Some(msg) = read.next().await {
            let payload = match msg {
                Ok(Message::Text(t)) => t.to_string(),
                Ok(Message::Binary(b)) => String::from_utf8_lossy(&b).into_owned(),
                Ok(Message::Close(frame)) => {
                    eprintln!("[deepgram:{source}] closed by server: {frame:?}");
                    // Deepgram has no in-band error messages — terminal errors
                    // arrive as an abnormal close code (1008 DATA-*, 1011
                    // NET-*, …) whose reason is the only diagnostic we get. A
                    // normal close (1000) follows our CloseStream.
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
                    eprintln!("[deepgram:{source}] read error: {e}");
                    break;
                }
            };
            msg_count += 1;
            if msg_count <= 3 {
                eprintln!("[deepgram:{source}] RX raw#{msg_count}: {payload}");
            }
            let resp: DgResponse = match serde_json::from_str(&payload) {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("[deepgram:{source}] parse error: {e}");
                    continue;
                }
            };
            if resp.msg_type != "Results" {
                continue; // Metadata, SpeechStarted, UtteranceEnd, etc.
            }
            let Some(alt) = resp.channel.alternatives.into_iter().next() else {
                continue;
            };

            if resp.is_final {
                // Settled words → push each into its speaker-run.
                for w in &alt.words {
                    let text = w.punctuated_word.clone().unwrap_or_else(|| w.word.clone());
                    if text.is_empty() {
                        continue;
                    }
                    let speaker = w.speaker.unwrap_or(0);
                    let start_ms = (w.start * 1000.0) as u64;
                    let end_ms = (w.end * 1000.0) as u64;
                    builder.push_final(&format!("{text} "), speaker, start_ms, end_ms);
                }
                builder.emit_committed();
                // speech_final marks an utterance boundary.
                if resp.speech_final {
                    builder.endpoint();
                }
                // Clear any stale tail now that this chunk is committed.
                builder.emit_tail("", builder.current_speaker(), builder.current_end());
            } else if !alt.transcript.trim().is_empty() {
                // Interim hypothesis → tentative tail.
                let speaker = alt
                    .words
                    .first()
                    .and_then(|w| w.speaker)
                    .unwrap_or(builder.current_speaker());
                let start_ms = alt
                    .words
                    .first()
                    .map(|w| (w.start * 1000.0) as u64)
                    .unwrap_or(builder.current_end());
                builder.emit_tail(&alt.transcript, speaker, start_ms);
            }
        }
        Ok(())
    };

    drive_session("deepgram", forward, read_loop).await
}
