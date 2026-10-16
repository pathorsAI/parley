//! OpenAI Realtime transcription adapter. Opens a realtime session in
//! transcription intent, streams base64 pcm16 audio, and assembles the
//! delta/completed transcription events into segments.
//!
//! Note: the realtime transcription API does not diarize, so every segment is
//! emitted under speaker 0.

use anyhow::{anyhow, Result};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use tauri::AppHandle;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio_tungstenite::tungstenite::Message;

use super::batch::{
    guess_audio_mime, last_end, read_json, BatchRequest, ReplaySegment, TranscriptionResult,
};
use super::common::{
    clean_vocabulary, connect_with_headers, drive_session, note_connected, LevelMeter,
    SegmentBuilder, Timeline, TranscribeConfig, LEVEL_EVENT,
};
use super::ws::{self, Next, OnClose, Pump, WsRead, WsWrite};
use crate::audio::resample::pcm_to_le_bytes;

const OPENAI_RT_URL: &str = "wss://api.openai.com/v1/realtime?intent=transcription";
const DEFAULT_MODEL: &str = "gpt-4o-transcribe";

#[derive(Deserialize, Default)]
struct OaiError {
    #[serde(default)]
    message: String,
}

#[derive(Deserialize, Default)]
struct OaiEvent {
    #[serde(rename = "type", default)]
    event_type: String,
    #[serde(default)]
    delta: String,
    #[serde(default)]
    transcript: String,
    /// Present on `error` events — the session-level failure detail.
    #[serde(default)]
    error: Option<OaiError>,
}

/// Build the realtime session's `transcription_session.update` frame.
///
/// Custom vocabulary rides on the transcription `prompt` — the only biasing
/// hook the realtime transcription session exposes. Whisper-style prompts are
/// free text, and a comma-separated term list is the shape OpenAI documents for
/// steering spelling.
fn setup_frame(config: &TranscribeConfig, model: &str) -> serde_json::Value {
    let mut transcription = json!({ "model": model });
    if let Some(lang) = config.language_hints.first() {
        transcription["language"] = json!(lang);
    }
    let terms = clean_vocabulary(&config.vocabulary);
    if !terms.is_empty() {
        transcription["prompt"] = json!(terms.join(", "));
    }
    json!({
        "type": "transcription_session.update",
        "session": {
            "input_audio_format": "pcm16",
            "input_audio_transcription": transcription,
            "turn_detection": { "type": "server_vad", "silence_duration_ms": 500 }
        }
    })
}

/// Stream PCM as base64 append events. The realtime session has no keepalive or
/// goodbye frame — closing the write half is the whole shutdown.
async fn forward_audio(
    write: WsWrite,
    meter: LevelMeter,
    pcm_rx: UnboundedReceiver<Vec<i16>>,
) -> bool {
    let b64 = base64::engine::general_purpose::STANDARD;
    ws::forward_audio(write, meter, pcm_rx, Pump::default(), move |chunk| {
        let audio = b64.encode(pcm_to_le_bytes(chunk));
        let msg = json!({ "type": "input_audio_buffer.append", "audio": audio });
        Message::Text(msg.to_string())
    })
    .await
}

/// Fold one transcription event into the segment builder. Returns the terminal
/// error when the event is a session-level `error` — the server stops
/// transcribing after it, so it must be surfaced (see `run_metered_session`)
/// instead of logged into the void.
fn apply_event(
    builder: &mut SegmentBuilder,
    interim: &mut String,
    ev: OaiEvent,
    source: &str,
    payload: &str,
) -> Option<anyhow::Error> {
    match ev.event_type.as_str() {
        "conversation.item.input_audio_transcription.delta" => {
            interim.push_str(&ev.delta);
            builder.emit_tail(interim, 0, 0);
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
            let detail = ev
                .error
                .map(|e| e.message)
                .filter(|m| !m.is_empty())
                .unwrap_or_else(|| "server error".to_string());
            return Some(anyhow!("{detail}"));
        }
        _ => {}
    }
    None
}

/// Parse server events into transcript segments until the socket ends or a
/// terminal error event arrives.
async fn read_transcripts(
    app: AppHandle,
    source: &'static str,
    timeline: Timeline,
    read: WsRead,
) -> Result<()> {
    let mut builder = SegmentBuilder::to_frontend(app, source, timeline);
    let mut interim = String::new();
    ws::read_frames("openai", source, read, OnClose::Stop, |payload| {
        on_payload(&mut builder, &mut interim, source, payload)
    })
    .await
}

/// Fold one server payload into `builder`, growing `interim` with the deltas;
/// an `error` event ends the session and an unparseable payload is skipped.
fn on_payload(
    builder: &mut SegmentBuilder,
    interim: &mut String,
    source: &str,
    payload: &str,
) -> Result<Next> {
    let Ok(ev) = serde_json::from_str::<OaiEvent>(payload) else {
        return Ok(Next::Continue);
    };
    match apply_event(builder, interim, ev, source, payload) {
        Some(err) => Err(err),
        None => Ok(Next::Continue),
    }
}

// --- Batch (/v1/audio/transcriptions) ------------------------------------------

const OPENAI_BATCH_BASE: &str = "https://api.openai.com";

#[derive(Deserialize, Default)]
struct OaiVerbose {
    #[serde(default)]
    duration: f64,
    #[serde(default)]
    text: String,
    #[serde(default)]
    segments: Vec<OaiSegment>,
}
#[derive(Deserialize, Default)]
struct OaiSegment {
    #[serde(default)]
    start: f64,
    #[serde(default)]
    end: f64,
    #[serde(default)]
    text: String,
}

/// OpenAI transcription with `verbose_json` for segment timestamps (whisper-1 —
/// the gpt-4o transcribe models reject verbose_json). No diarization → a single
/// speaker. 25 MB request limit (compression helps). Shape verified vs docs.
pub(crate) async fn transcribe_file(req: BatchRequest<'_>) -> Result<TranscriptionResult, String> {
    let base = req.base_or(OPENAI_BATCH_BASE);
    let file_name = req.file_name_or("recording.ogg");
    let part = reqwest::multipart::Part::bytes(req.audio)
        .file_name(file_name)
        .mime_str(guess_audio_mime(req.upload_path))
        .map_err(|e| format!("openai: bad mime: {e}"))?;
    // whisper-1 returns verbose_json segments with timestamps; the gpt-4o
    // transcribe models don't, so default to whisper-1 for the replay path.
    let model = req.model.unwrap_or("whisper-1");
    let mut form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", model.to_string())
        .text("response_format", "verbose_json");
    if let Some(lang) = req.language_hints.first() {
        form = form.text("language", lang.clone());
    }
    // Whisper's only biasing hook is the free-text `prompt`; a comma-separated
    // term list is the documented way to steer spelling. Same string the
    // realtime adapter puts in `input_audio_transcription.prompt`.
    let terms = clean_vocabulary(req.vocabulary);
    if !terms.is_empty() {
        form = form.text("prompt", terms.join(", "));
    }
    let resp = req
        .client
        .post(format!("{base}/v1/audio/transcriptions"))
        .bearer_auth(req.credential)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("OpenAI request failed: {e}"))?;
    let v: OaiVerbose = read_json(resp, "openai transcribe").await?;
    Ok(verbose_result(v))
}

/// Map the verbose segments; fall back to the flat text as one segment.
fn verbose_result(v: OaiVerbose) -> TranscriptionResult {
    let mut segments: Vec<ReplaySegment> = v
        .segments
        .into_iter()
        .filter(|s| !s.text.trim().is_empty())
        .enumerate()
        .map(|(i, s)| ReplaySegment {
            id: format!("them-{i}"),
            speaker: 0,
            text: s.text.trim().to_string(),
            start_ms: (s.start * 1000.0) as u64,
            end_ms: (s.end * 1000.0) as u64,
        })
        .collect();
    if segments.is_empty() && !v.text.trim().is_empty() {
        segments.push(ReplaySegment {
            id: "them-0".to_string(),
            speaker: 0,
            text: v.text.trim().to_string(),
            start_ms: 0,
            end_ms: (v.duration * 1000.0) as u64,
        });
    }
    let duration_ms = ((v.duration * 1000.0) as u64).max(last_end(&segments));
    TranscriptionResult::fresh(segments, duration_ms)
}

pub async fn run_session(
    app: AppHandle,
    config: TranscribeConfig,
    source: &'static str,
    pcm_rx: UnboundedReceiver<Vec<i16>>,
) -> Result<()> {
    let ws = connect_with_headers(
        OPENAI_RT_URL,
        &[
            ("Authorization", format!("Bearer {}", config.api_key)),
            ("OpenAI-Beta", "realtime=v1".to_string()),
        ],
    )
    .await?;
    let (mut write, read) = ws.split();

    let model = if config.model.trim().is_empty() {
        DEFAULT_MODEL
    } else {
        config.model.as_str()
    };
    let setup = setup_frame(&config, model);
    write.send(Message::Text(setup.to_string())).await?;
    eprintln!(
        "[openai:{source}] connected, model={model} (diarization unsupported → speaker 0), leg={}",
        config.leg
    );
    note_connected(&app, source, config.leg, false);

    let meter = LevelMeter::new(app.clone(), source, LEVEL_EVENT).enabled(config.level_events);

    drive_session(
        "openai",
        forward_audio(write, meter, pcm_rx),
        read_transcripts(app, source, config.timeline(), read),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcription::common::testing::{builder, rows, seg};

    #[test]
    fn deltas_grow_the_tail_and_completion_commits_it() {
        let (mut b, out) = builder("voice-typing");
        let mut interim = String::new();
        for payload in [
            r#"{"type":"transcription_session.created"}"#,
            r#"{"type":"conversation.item.input_audio_transcription.delta","delta":"Hel"}"#,
            r#"{"type":"conversation.item.input_audio_transcription.delta","delta":"lo"}"#,
            r#"{"type":"conversation.item.input_audio_transcription.completed","transcript":" Hello. "}"#,
            r#"{"type":"conversation.item.input_audio_transcription.delta","delta":"again"}"#,
            r#"{"type":"conversation.item.input_audio_transcription.completed","transcript":""}"#,
            "not json",
        ] {
            assert!(matches!(
                on_payload(&mut b, &mut interim, "voice-typing", payload).unwrap(),
                Next::Continue
            ));
        }
        assert_eq!(
            rows(&out),
            vec![
                seg("voice-typing-tail", 0, "Hel", false, 0, 0),
                seg("voice-typing-tail", 0, "Hello", false, 0, 0),
                seg("voice-typing-0", 0, "Hello.", true, 0, 0),
                seg("voice-typing-0", 0, "Hello.", true, 0, 0),
                seg("voice-typing-tail", 0, "", false, 0, 0),
                seg("voice-typing-tail", 0, "again", false, 0, 0),
                // An empty completion commits what the deltas built.
                seg("voice-typing-1", 0, "again", true, 0, 0),
                seg("voice-typing-1", 0, "again", true, 0, 0),
                seg("voice-typing-tail", 0, "", false, 0, 0),
            ]
        );
    }

    #[test]
    fn an_error_event_ends_the_session_with_its_message() {
        let (mut b, _) = builder("me");
        let mut interim = String::new();
        let err = on_payload(
            &mut b,
            &mut interim,
            "me",
            r#"{"type":"error","error":{"message":"Incorrect API key provided"}}"#,
        )
        .unwrap_err();
        assert_eq!(err.to_string(), "Incorrect API key provided");
        let err = on_payload(&mut b, &mut interim, "me", r#"{"type":"error"}"#).unwrap_err();
        assert_eq!(err.to_string(), "server error");
    }

    #[test]
    fn the_setup_frame_carries_the_language_and_prompt() {
        let config = TranscribeConfig {
            api_key: String::new(),
            model: String::new(),
            language_hints: vec!["zh".into()],
            diarization: false,
            vocabulary: vec!["Parley".into(), " 派斯 ".into()],
            relay_endpoint: None,
            leg: 0,
            time_offset_ms: 0,
            level_events: true,
        };
        assert_eq!(
            setup_frame(&config, "gpt-4o-transcribe"),
            json!({
                "type": "transcription_session.update",
                "session": {
                    "input_audio_format": "pcm16",
                    "input_audio_transcription": {
                        "model": "gpt-4o-transcribe",
                        "language": "zh",
                        "prompt": "Parley, 派斯",
                    },
                    "turn_detection": { "type": "server_vad", "silence_duration_ms": 500 }
                }
            })
        );
    }
}
