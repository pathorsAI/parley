//! AssemblyAI streaming (v3) adapter. Streams pcm_s16le over a WebSocket and
//! turns each formatted "Turn" into a transcript segment.
//!
//! Note: v3 streaming does not provide speaker diarization, so every segment is
//! emitted under speaker 0 (a single speaker in the UI).

use anyhow::{anyhow, Result};
use futures_util::stream::SplitStream;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tauri::AppHandle;
use tokio::net::TcpStream;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use super::common::{
    clean_vocabulary, connect_with_headers, drive_session, urlencode, LevelMeter, SegmentBuilder,
    TranscribeConfig, LEVEL_EVENT, TRANSCRIPT_EVENT,
};
use crate::audio::resample::pcm_to_le_bytes;
use crate::audio::TARGET_SAMPLE_RATE;

const AAI_BASE: &str = "wss://streaming.assemblyai.com/v3/ws";

type WsRead = SplitStream<WebSocketStream<MaybeTlsStream<TcpStream>>>;

/// Universal-Streaming's custom-vocabulary query param, ready to append to the
/// v3 websocket URL. The wire shape is `keyterms_prompt=<JSON array of terms>`,
/// url-encoded — note the JSON array, not a repeated param (that is the v3
/// streaming spelling; the batch API instead takes a `word_boost` body array).
/// Empty string when there's nothing to bias toward.
pub fn keyterms_param(vocabulary: &[String]) -> String {
    let terms = clean_vocabulary(vocabulary);
    if terms.is_empty() {
        return String::new();
    }
    match serde_json::to_string(&terms) {
        Ok(json) => format!("&keyterms_prompt={}", urlencode(&json)),
        // Serializing a Vec<String> cannot realistically fail; if it somehow
        // does, stream without biasing rather than with a malformed URL.
        Err(_) => String::new(),
    }
}

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

/// What the read loop should do with one incoming websocket frame.
enum Frame {
    /// A JSON payload to parse.
    Payload(String),
    /// Nothing of interest — keep reading.
    Skip,
    /// The stream ended; stop reading.
    Stop,
}

/// Classify one websocket frame into "parse this" / "ignore" / "we're done".
fn classify(msg: Result<Message, tokio_tungstenite::tungstenite::Error>, source: &str) -> Frame {
    match msg {
        Ok(Message::Text(t)) => Frame::Payload(t.to_string()),
        Ok(Message::Binary(b)) => Frame::Payload(String::from_utf8_lossy(&b).into_owned()),
        Ok(Message::Close(frame)) => {
            eprintln!("[assemblyai:{source}] closed by server: {frame:?}");
            Frame::Stop
        }
        Ok(_) => Frame::Skip,
        Err(e) => {
            eprintln!("[assemblyai:{source}] read error: {e}");
            Frame::Stop
        }
    }
}

/// Turn one "Turn" message into either a committed segment (settled and
/// punctuated) or the tentative tail for the in-progress turn.
fn apply_turn(builder: &mut SegmentBuilder, m: &AaiMessage) {
    let text = m.transcript.trim();
    if text.is_empty() {
        return;
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

/// Parse server frames into transcript segments until the socket ends or an
/// in-band error arrives.
async fn read_transcripts(app: AppHandle, source: &'static str, mut read: WsRead) -> Result<()> {
    let mut builder = SegmentBuilder::new(app, source, TRANSCRIPT_EVENT);
    let mut msg_count: u64 = 0;
    while let Some(msg) = read.next().await {
        let payload = match classify(msg, source) {
            Frame::Payload(p) => p,
            Frame::Skip => continue,
            Frame::Stop => break,
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
            // In-band errors are terminal (the server closes after) — the
            // session is dead, so surface it (see run_metered_session).
            eprintln!("[assemblyai:{source}] error: {err}");
            return Err(anyhow!("server error: {err}"));
        }
        if m.msg_type != "Turn" {
            continue; // Begin / Termination / etc.
        }
        apply_turn(&mut builder, &m);
    }
    Ok(())
}

pub async fn run_session(
    app: AppHandle,
    config: TranscribeConfig,
    source: &'static str,
    mut pcm_rx: UnboundedReceiver<Vec<i16>>,
) -> Result<()> {
    let url = format!(
        "{AAI_BASE}?sample_rate={}&encoding=pcm_s16le&format_turns=true{}",
        TARGET_SAMPLE_RATE,
        keyterms_param(&config.vocabulary)
    );
    // AssemblyAI takes the API key directly in the Authorization header.
    let ws = connect_with_headers(&url, &[("Authorization", config.api_key.clone())]).await?;
    let (mut write, read) = ws.split();
    eprintln!("[assemblyai:{source}] connected (diarization unsupported → speaker 0)");

    let mut meter = LevelMeter::new(app.clone(), source, LEVEL_EVENT);
    // Resolves with whether the input drained (normal stop) or a send failed
    // (dead socket) — drive_session reports the latter as a failure.
    let forward = async move {
        let drained = loop {
            let Some(chunk) = pcm_rx.recv().await else {
                break true;
            };
            meter.push(&chunk);
            let bytes = pcm_to_le_bytes(&chunk);
            if write.send(Message::Binary(bytes)).await.is_err() {
                break false;
            }
        };
        let _ = write
            .send(Message::Text("{\"type\":\"Terminate\"}".to_string()))
            .await;
        let _ = write.close().await;
        drained
    };

    drive_session("assemblyai", forward, read_transcripts(app, source, read)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keyterms_prompt_is_a_url_encoded_json_array() {
        let vocab = vec!["Parley".to_string(), " Parley ".to_string()];
        // The duplicate is normalized away, so the array carries one term.
        assert_eq!(
            keyterms_param(&vocab),
            "&keyterms_prompt=%5B%22Parley%22%5D"
        );
    }

    #[test]
    fn an_empty_dictionary_leaves_the_url_untouched() {
        assert_eq!(keyterms_param(&[]), "");
        assert_eq!(keyterms_param(&["  ".to_string()]), "");
    }
}
