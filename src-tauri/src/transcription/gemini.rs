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

use super::batch::{guess_audio_mime, read_json, BatchRequest, ReplaySegment, TranscriptionResult};
use super::common::{
    clean_vocabulary, connect_with_headers, drive_session, note_connected, LevelMeter,
    SegmentBuilder, Timeline, TranscribeConfig, LEVEL_EVENT,
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
async fn read_transcripts(
    app: AppHandle,
    source: &'static str,
    timeline: Timeline,
    read: WsRead,
) -> Result<()> {
    let mut builder = SegmentBuilder::to_frontend(app, source, timeline);
    let mut interim = String::new();
    ws::read_frames("gemini", source, read, OnClose::FailIfAbnormal, |payload| {
        on_payload(&mut builder, &mut interim, payload)
    })
    .await
}

/// Fold one server payload into `builder`. Gemini reports failures by
/// closing the socket, so every payload continues the stream.
fn on_payload(builder: &mut SegmentBuilder, interim: &mut String, payload: &str) -> Result<Next> {
    if let Ok(m) = serde_json::from_str::<GeminiMessage>(payload) {
        apply_message(builder, interim, m);
    }
    Ok(Next::Continue)
}

// --- Batch (generateContent with inline audio) ---------------------------------

const GEMINI_BATCH_BASE: &str = "https://generativelanguage.googleapis.com";

#[derive(Deserialize, Default)]
struct GemResponse {
    #[serde(default)]
    candidates: Vec<GemCandidate>,
}
#[derive(Deserialize, Default)]
struct GemCandidate {
    #[serde(default)]
    content: GemContent,
}
#[derive(Deserialize, Default)]
struct GemContent {
    #[serde(default)]
    parts: Vec<GemPart>,
}
#[derive(Deserialize, Default)]
struct GemPart {
    #[serde(default)]
    text: String,
}

/// The transcription prompt. Gemini has no custom-vocabulary field; the
/// transcription is driven by a prompt, so the phrase dictionary becomes one
/// more line of that prompt.
fn batch_prompt(vocabulary: &[String]) -> String {
    let mut prompt = "Transcribe this audio verbatim. Output only the transcript text, with no commentary, labels, or timestamps.".to_string();
    let terms = clean_vocabulary(vocabulary);
    if !terms.is_empty() {
        prompt.push_str(&format!(
            "\nDomain terms that may occur — spell them exactly as written: {}.",
            terms.join(", ")
        ));
    }
    prompt
}

/// Gemini transcription via generateContent with inline audio. No timestamps or
/// diarization, so the whole transcript is a single segment spanning the file
/// (its length is measured by decoding). NEEDS LIVE SMOKE TEST.
pub(crate) async fn transcribe_file(req: BatchRequest<'_>) -> Result<TranscriptionResult, String> {
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&req.audio);
    let model = req.model.unwrap_or("gemini-2.5-flash");
    let base = req.base_or(GEMINI_BATCH_BASE);
    let url = format!(
        "{base}/v1beta/models/{model}:generateContent?key={}",
        req.credential
    );
    let body = serde_json::json!({
        "contents": [{
            "parts": [
                { "inline_data": { "mime_type": guess_audio_mime(req.upload_path), "data": b64 } },
                { "text": batch_prompt(req.vocabulary) }
            ]
        }]
    });
    let resp = req
        .client
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Gemini request failed: {e}"))?;
    let g: GemResponse = read_json(resp, "gemini transcribe").await?;
    let text = g
        .candidates
        .first()
        .and_then(|c| c.content.parts.first())
        .map(|p| p.text.trim().to_string())
        .unwrap_or_default();
    // Gemini returns no duration; decode the file to length the single segment so
    // the replay scrubber has a range (best-effort — 0 if the decode fails).
    let path = req.upload_path.to_string();
    let duration_ms = tokio::task::spawn_blocking(move || {
        crate::replay_audio::decode_to_16k_mono(std::path::Path::new(&path))
            .map(|pcm| (pcm.len() as u64) * 1000 / 16_000)
            .unwrap_or(0)
    })
    .await
    .unwrap_or(0);
    let segments = if text.is_empty() {
        Vec::new()
    } else {
        vec![ReplaySegment {
            id: "them-0".to_string(),
            speaker: 0,
            text,
            start_ms: 0,
            end_ms: duration_ms,
        }]
    };
    Ok(TranscriptionResult::fresh(segments, duration_ms))
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
    eprintln!(
        "[gemini:{source}] connected, model={model} (diarization unsupported → speaker 0), leg={}",
        config.leg
    );
    note_connected(&app, source, config.leg, false);

    let mime = format!("audio/pcm;rate={}", TARGET_SAMPLE_RATE);
    let meter = LevelMeter::new(app.clone(), source, LEVEL_EVENT).enabled(config.level_events);

    drive_session(
        "gemini",
        forward_audio(write, meter, mime, pcm_rx),
        read_transcripts(app, source, config.timeline(), read),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcription::common::testing::{builder, rows, seg};

    #[test]
    fn input_transcription_grows_the_tail_until_the_turn_completes() {
        let (mut b, out) = builder("them");
        let mut interim = String::new();
        for payload in [
            r#"{"setupComplete":{}}"#,
            r#"{"serverContent":{"inputTranscription":{"text":"Hello"}}}"#,
            r#"{"serverContent":{"inputTranscription":{"text":" world "}}}"#,
            r#"{"serverContent":{"turnComplete":true}}"#,
            r#"{"serverContent":{"turnComplete":true}}"#,
            "not json",
        ] {
            assert!(matches!(
                on_payload(&mut b, &mut interim, payload).unwrap(),
                Next::Continue
            ));
        }
        assert_eq!(
            rows(&out),
            vec![
                seg("them-tail", 0, "Hello", false, 0, 0),
                seg("them-tail", 0, "Hello world ", false, 0, 0),
                seg("them-0", 0, "Hello world", true, 0, 0),
                seg("them-0", 0, "Hello world", true, 0, 0),
                seg("them-tail", 0, "", false, 0, 0),
            ]
        );
    }

    #[test]
    fn the_setup_frame_adds_a_spelling_instruction_only_for_terms() {
        assert_eq!(
            setup_frame("models/gemini-x", &[]),
            json!({
                "setup": {
                    "model": "models/gemini-x",
                    "generationConfig": { "responseModalities": ["TEXT"] },
                    "inputAudioTranscription": {}
                }
            })
        );
        let with_terms = setup_frame("models/gemini-x", &["Parley".to_string()]);
        assert_eq!(
            with_terms["setup"]["systemInstruction"]["parts"][0]["text"],
            json!("Transcribe the input audio faithfully and verbatim. These domain terms may occur; when they do, spell them exactly as written here: Parley.")
        );
    }
}
