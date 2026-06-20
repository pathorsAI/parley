//! Batch (async) transcription for uploaded recordings — the "replay" feature.
//!
//! Unlike the realtime adapters in `transcription/`, this drives Soniox's async
//! REST API: upload the file, create a transcription job, poll until it
//! completes, then fetch the diarized token stream. The tokens are grouped into
//! speaker-runs (mirroring `transcription::common::SegmentBuilder`) and returned
//! to the frontend as ready-to-render segments.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::transcription::common::ensure_crypto_provider;

const SONIOX_BASE: &str = "https://api.soniox.com/v1";
/// Async batch model (distinct from the realtime `stt-rt-v5`).
const DEFAULT_ASYNC_MODEL: &str = "stt-async-v5";
/// How long to wait between status polls.
const POLL_INTERVAL: Duration = Duration::from_millis(1500);
/// Safety cap so a stuck job can't poll forever (~20 min at 1.5s/poll).
const MAX_POLLS: u32 = 800;

/// A finished, diarized transcript segment handed to the frontend. Serializes to
/// camelCase so it matches the TS `TranscriptSegment` shape directly.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplaySegment {
    id: String,
    /// Always 0-based diarized speaker; the source is fixed to "them" in JS.
    speaker: i64,
    text: String,
    start_ms: u64,
    end_ms: u64,
}

/// Result of `transcribe_file` — segments plus the overall duration.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionResult {
    segments: Vec<ReplaySegment>,
    duration_ms: u64,
}

// --- Soniox wire types --------------------------------------------------------

#[derive(Serialize)]
struct CreateTranscriptionRequest<'a> {
    file_id: &'a str,
    model: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    language_hints: Option<Vec<String>>,
    enable_speaker_diarization: bool,
}

#[derive(Deserialize)]
struct IdResponse {
    id: String,
}

#[derive(Deserialize)]
struct TranscriptionStatus {
    status: String,
    #[serde(default)]
    error_message: Option<String>,
    #[serde(default)]
    audio_duration_ms: Option<u64>,
}

#[derive(Deserialize, Default)]
struct Token {
    #[serde(default)]
    text: String,
    #[serde(default)]
    start_ms: u64,
    #[serde(default)]
    end_ms: u64,
    /// Speaker can arrive as a string ("1") or a number, or be absent.
    #[serde(default)]
    speaker: Option<SpeakerId>,
}

/// Soniox sends the speaker as a string in some responses and a number in
/// others; accept either.
#[derive(Deserialize)]
#[serde(untagged)]
enum SpeakerId {
    Num(i64),
    Str(String),
}

impl SpeakerId {
    fn to_i64(&self) -> i64 {
        match self {
            SpeakerId::Num(n) => *n,
            SpeakerId::Str(s) => s.trim().parse().unwrap_or(0),
        }
    }
}

#[derive(Deserialize, Default)]
struct TranscriptResponse {
    #[serde(default)]
    tokens: Vec<Token>,
}

/// Transcribe an audio file via Soniox's async API and return diarized segments.
///
/// `language_hints` may be empty (Soniox auto-detects). `diarization` toggles
/// speaker separation. The `api_key` is supplied by the frontend from settings
/// and never leaves the Rust side beyond the Soniox request.
#[tauri::command]
pub async fn transcribe_file(
    _app: AppHandle,
    path: String,
    api_key: String,
    model: Option<String>,
    language_hints: Vec<String>,
    diarization: bool,
) -> Result<TranscriptionResult, String> {
    ensure_crypto_provider();

    if api_key.trim().is_empty() {
        return Err("Missing Soniox API key".to_string());
    }

    let model = model.unwrap_or_else(|| DEFAULT_ASYNC_MODEL.to_string());
    let client = reqwest::Client::new();

    // 1. Upload the file → file id.
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("Failed to read file: {e}"))?;
    let file_name = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "recording".to_string());
    let part = reqwest::multipart::Part::bytes(bytes).file_name(file_name);
    let form = reqwest::multipart::Form::new().part("file", part);

    let upload_resp = client
        .post(format!("{SONIOX_BASE}/files"))
        .bearer_auth(&api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Upload request failed: {e}"))?;
    let upload: IdResponse = read_json(upload_resp, "file upload").await?;
    let file_id = upload.id;

    // 2. Create the async transcription job → transcription id.
    let hints = if language_hints.is_empty() {
        None
    } else {
        Some(language_hints)
    };
    let create_body = CreateTranscriptionRequest {
        file_id: &file_id,
        model: &model,
        language_hints: hints,
        enable_speaker_diarization: diarization,
    };
    let create_resp = client
        .post(format!("{SONIOX_BASE}/transcriptions"))
        .bearer_auth(&api_key)
        .json(&create_body)
        .send()
        .await
        .map_err(|e| format!("Create transcription failed: {e}"))?;
    let created: IdResponse = read_json(create_resp, "create transcription").await?;
    let transcription_id = created.id;

    // 3. Poll until completed or error.
    let audio_duration_ms = loop_poll(&client, &api_key, &transcription_id).await?;

    // 4. Fetch the transcript tokens.
    let transcript_resp = client
        .get(format!(
            "{SONIOX_BASE}/transcriptions/{transcription_id}/transcript"
        ))
        .bearer_auth(&api_key)
        .send()
        .await
        .map_err(|e| format!("Fetch transcript failed: {e}"))?;
    let transcript: TranscriptResponse = read_json(transcript_resp, "fetch transcript").await?;

    // 5. Best-effort cleanup of the uploaded file + transcription on Soniox.
    let _ = client
        .delete(format!("{SONIOX_BASE}/transcriptions/{transcription_id}"))
        .bearer_auth(&api_key)
        .send()
        .await;
    let _ = client
        .delete(format!("{SONIOX_BASE}/files/{file_id}"))
        .bearer_auth(&api_key)
        .send()
        .await;

    // Group consecutive same-speaker tokens into segments (mirrors the realtime
    // SegmentBuilder: a speaker change closes the open run).
    let segments = group_tokens(&transcript.tokens);
    let duration_ms = segments
        .iter()
        .map(|s| s.end_ms)
        .max()
        .unwrap_or(audio_duration_ms)
        .max(audio_duration_ms);

    Ok(TranscriptionResult {
        segments,
        duration_ms,
    })
}

/// Poll the transcription status until it completes (returns the reported audio
/// duration) or errors. Surfaces a timeout if it never settles.
async fn loop_poll(
    client: &reqwest::Client,
    api_key: &str,
    transcription_id: &str,
) -> Result<u64, String> {
    for _ in 0..MAX_POLLS {
        tokio::time::sleep(POLL_INTERVAL).await;

        let status_resp = client
            .get(format!("{SONIOX_BASE}/transcriptions/{transcription_id}"))
            .bearer_auth(api_key)
            .send()
            .await
            .map_err(|e| format!("Poll request failed: {e}"))?;
        let status: TranscriptionStatus = read_json(status_resp, "poll status").await?;

        match status.status.as_str() {
            "completed" => return Ok(status.audio_duration_ms.unwrap_or(0)),
            "error" => {
                return Err(format!(
                    "Transcription failed: {}",
                    status.error_message.unwrap_or_else(|| "unknown error".into())
                ));
            }
            // "queued" | "processing" | anything else → keep polling.
            _ => continue,
        }
    }
    Err("Transcription timed out".to_string())
}

/// Group a flat token stream into speaker-runs. A change of speaker closes the
/// current run and starts a new one; whitespace is preserved as Soniox supplies
/// it. Empty / whitespace-only runs are dropped.
fn group_tokens(tokens: &[Token]) -> Vec<ReplaySegment> {
    let mut segments: Vec<ReplaySegment> = Vec::new();
    let mut seg_index: u64 = 0;

    let mut cur_speaker: i64 = -1;
    let mut cur_text = String::new();
    let mut cur_start: u64 = 0;
    let mut cur_end: u64 = 0;

    for tok in tokens {
        // Skip control / endpoint markers that some models emit.
        if tok.text == "<end>" || tok.text == "<fin>" {
            continue;
        }
        let spk = tok.speaker.as_ref().map(|s| s.to_i64()).unwrap_or(0);

        if cur_speaker == -1 {
            cur_speaker = spk;
            cur_start = tok.start_ms;
        } else if spk != cur_speaker {
            if !cur_text.trim().is_empty() {
                segments.push(ReplaySegment {
                    id: format!("them-{seg_index}"),
                    speaker: cur_speaker,
                    text: cur_text.clone(),
                    start_ms: cur_start,
                    end_ms: cur_end,
                });
                seg_index += 1;
            }
            cur_speaker = spk;
            cur_text.clear();
            cur_start = tok.start_ms;
        }
        cur_text.push_str(&tok.text);
        cur_end = tok.end_ms;
    }

    if !cur_text.trim().is_empty() {
        segments.push(ReplaySegment {
            id: format!("them-{seg_index}"),
            speaker: cur_speaker.max(0),
            text: cur_text,
            start_ms: cur_start,
            end_ms: cur_end,
        });
    }

    segments
}

/// Turn a reqwest Response into a deserialized body, surfacing the HTTP status +
/// body text on failure so callers get a useful error message.
async fn read_json<T: serde::de::DeserializeOwned>(
    resp: reqwest::Response,
    ctx: &str,
) -> Result<T, String> {
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("{ctx}: failed to read response: {e}"))?;
    if !status.is_success() {
        return Err(format!("{ctx}: HTTP {status}: {text}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("{ctx}: bad response JSON: {e} — {text}"))
}
