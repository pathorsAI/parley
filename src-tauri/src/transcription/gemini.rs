//! Gemini Live adapter. Opens a BidiGenerateContent session with input-audio
//! transcription enabled, streams base64 pcm16 media chunks, and surfaces the
//! `serverContent.inputTranscription` text as segments.
//!
//! Note: Gemini Live does not diarize input audio and gives no per-word
//! timestamps, so segments are emitted under speaker 0 with zeroed timings.

use anyhow::{anyhow, Result};
use base64::Engine;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use tauri::AppHandle;
use tokio::net::TcpStream;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use super::common::{
    clean_vocabulary, connect_with_headers, drive_session, LevelMeter, SegmentBuilder,
    TranscribeConfig, LEVEL_EVENT, TRANSCRIPT_EVENT,
};
use crate::audio::resample::pcm_to_le_bytes;
use crate::audio::TARGET_SAMPLE_RATE;

const GEMINI_BASE: &str =
    "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const DEFAULT_MODEL: &str = "gemini-2.0-flash-live-001";

type WsWrite = SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>;
type WsRead = SplitStream<WebSocketStream<MaybeTlsStream<TcpStream>>>;

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

/// What the read loop should do with one incoming websocket frame.
enum Frame {
    /// A JSON payload to parse.
    Payload(String),
    /// Nothing of interest — keep reading.
    Skip,
    /// The stream ended in a way that isn't an error.
    Stop,
    /// The server closed abnormally: terminal, with its reason as the detail.
    Failed(String),
}

/// Build the BidiGenerateContent `setup` frame for `model_path`.
///
/// Gemini Live has no dedicated custom-vocabulary field, but the setup frame
/// does carry a `systemInstruction` (a Content), which is the documented hook
/// for steering the model — so the phrase dictionary becomes a spelling
/// instruction. Only added when the dictionary is non-empty, leaving the setup
/// frame untouched otherwise.
fn setup_frame(model_path: &str, terms: &[String]) -> serde_json::Value {
    let mut setup = json!({
        "setup": {
            "model": model_path,
            "generationConfig": { "responseModalities": ["TEXT"] },
            "inputAudioTranscription": {}
        }
    });
    if !terms.is_empty() {
        setup["setup"]["systemInstruction"] = json!({
            "parts": [{
                "text": format!(
                    "Transcribe the input audio faithfully and verbatim. These domain terms may \
                     occur; when they do, spell them exactly as written here: {}.",
                    terms.join(", ")
                )
            }]
        });
    }
    setup
}

/// Stream PCM as base64 media chunks until the input drains or a send fails.
/// Resolves with whether the input drained (normal stop) or a send failed (dead
/// socket) — drive_session reports the latter as a failure.
async fn forward_audio(
    mut write: WsWrite,
    mut meter: LevelMeter,
    mime: String,
    mut pcm_rx: UnboundedReceiver<Vec<i16>>,
) -> bool {
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
}

/// Classify one websocket frame. Gemini Live signals terminal errors (bad key,
/// quota, invalid setup) by closing with an abnormal code + reason rather than
/// an in-band message; a normal close (1000) follows our own close.
fn classify(msg: Result<Message, tokio_tungstenite::tungstenite::Error>, source: &str) -> Frame {
    let msg = match msg {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[gemini:{source}] read error: {e}");
            return Frame::Stop;
        }
    };
    match msg {
        Message::Text(t) => Frame::Payload(t.to_string()),
        Message::Binary(b) => Frame::Payload(String::from_utf8_lossy(&b).into_owned()),
        Message::Close(frame) => {
            eprintln!("[gemini:{source}] closed by server: {frame:?}");
            match frame {
                Some(f) if f.code != CloseCode::Normal => {
                    Frame::Failed(format!("{} {}", u16::from(f.code), f.reason))
                }
                _ => Frame::Stop,
            }
        }
        _ => Frame::Skip,
    }
}

/// Fold one parsed server message into the segment builder, growing `interim`
/// with the transcription deltas and committing it on `turnComplete`.
fn apply_message(builder: &mut SegmentBuilder, interim: &mut String, m: GeminiMessage) {
    let Some(sc) = m.server_content else { return };
    if let Some(tr) = sc.input_transcription {
        if !tr.text.is_empty() {
            interim.push_str(&tr.text);
            builder.emit_tail(interim, 0, 0);
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

/// Parse server frames into transcript segments until the socket ends.
async fn read_transcripts(app: AppHandle, source: &'static str, mut read: WsRead) -> Result<()> {
    let mut builder = SegmentBuilder::new(app, source, TRANSCRIPT_EVENT);
    let mut interim = String::new();
    let mut msg_count: u64 = 0;
    while let Some(msg) = read.next().await {
        let payload = match classify(msg, source) {
            Frame::Payload(p) => p,
            Frame::Skip => continue,
            Frame::Stop => break,
            Frame::Failed(detail) => return Err(anyhow!("closed by server: {detail}")),
        };
        msg_count += 1;
        if msg_count <= 3 {
            eprintln!("[gemini:{source}] RX raw#{msg_count}: {payload}");
        }
        if let Ok(m) = serde_json::from_str::<GeminiMessage>(&payload) {
            apply_message(&mut builder, &mut interim, m);
        }
    }
    Ok(())
}

pub async fn run_session(
    app: AppHandle,
    config: TranscribeConfig,
    source: &'static str,
    pcm_rx: UnboundedReceiver<Vec<i16>>,
) -> Result<()> {
    let url = format!("{GEMINI_BASE}?key={}", config.api_key);
    let ws = connect_with_headers(&url, &[]).await?;
    let (mut write, read) = ws.split();

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
    let setup = setup_frame(&model_path, &clean_vocabulary(&config.vocabulary));
    write.send(Message::Text(setup.to_string())).await?;
    eprintln!("[gemini:{source}] connected, model={model} (diarization unsupported → speaker 0)");

    let mime = format!("audio/pcm;rate={}", TARGET_SAMPLE_RATE);
    let meter = LevelMeter::new(app.clone(), source, LEVEL_EVENT);

    drive_session(
        "gemini",
        forward_audio(write, meter, mime, pcm_rx),
        read_transcripts(app, source, read),
    )
    .await
}
