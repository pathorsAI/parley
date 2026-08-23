//! Gemini Live adapter. Opens a BidiGenerateContent session with input-audio
//! transcription enabled, streams base64 pcm16 media chunks, and surfaces the
//! `serverContent.inputTranscription` text as segments.
//!
//! Note: Gemini Live does not diarize input audio and gives no per-word
//! timestamps, so segments are emitted under speaker 0 with zeroed timings.

use anyhow::Result;
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

/// Stream PCM as base64 media chunks. Gemini Live has no keepalive or goodbye
/// frame — closing the write half is the whole shutdown.
async fn forward_audio(
    write: WsWrite,
    meter: LevelMeter,
    mime: String,
    pcm_rx: UnboundedReceiver<Vec<i16>>,
) -> bool {
    let b64 = base64::engine::general_purpose::STANDARD;
    ws::forward_audio(write, meter, pcm_rx, Pump::default(), move |chunk| {
        let data = b64.encode(pcm_to_le_bytes(chunk));
        let msg = json!({
            "realtimeInput": { "mediaChunks": [ { "mimeType": mime, "data": data } ] }
        });
        Message::Text(msg.to_string())
    })
    .await
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
///
/// Gemini Live signals terminal errors (bad key, quota, invalid setup) by
/// closing with an abnormal code + reason rather than an in-band message, so an
/// abnormal close is the failure — a normal close (1000) follows our own.
async fn read_transcripts(app: AppHandle, source: &'static str, read: WsRead) -> Result<()> {
    let mut builder = SegmentBuilder::new(app, source, TRANSCRIPT_EVENT);
    let mut interim = String::new();
    ws::read_frames("gemini", source, read, OnClose::FailIfAbnormal, |payload| {
        if let Ok(m) = serde_json::from_str::<GeminiMessage>(payload) {
            apply_message(&mut builder, &mut interim, m);
        }
        Ok(Next::Continue)
    })
    .await
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
