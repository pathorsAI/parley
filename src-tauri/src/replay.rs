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

    // 0. Try to compress the recording to a much smaller Opus/Ogg file before
    // uploading. This is best-effort: any failure (unsupported codec, encode
    // error, …) falls back to uploading the original file so it never blocks an
    // upload. `compressed_temp` is set only when we produced a temp file, so we
    // can delete it afterward (even on error).
    let original_size = tokio::fs::metadata(&path).await.map(|m| m.len()).ok();
    let mut compressed_temp: Option<std::path::PathBuf> = None;
    let upload_path: String = match compress_for_upload_blocking(path.clone()).await {
        Ok(temp) => {
            let compressed_size = tokio::fs::metadata(&temp).await.map(|m| m.len()).ok();
            match (original_size, compressed_size) {
                (Some(orig), Some(comp)) => eprintln!(
                    "[replay] compressed audio: {orig} bytes -> {comp} bytes ({:.1}% of original)",
                    if orig > 0 { comp as f64 / orig as f64 * 100.0 } else { 0.0 }
                ),
                _ => eprintln!("[replay] compressed audio (sizes unavailable)"),
            }
            let p = temp.to_string_lossy().into_owned();
            compressed_temp = Some(temp);
            p
        }
        Err(e) => {
            eprintln!("[replay] audio compression failed, uploading original: {e}");
            path.clone()
        }
    };

    // Run the rest of the flow, ensuring the temp file is cleaned up afterward.
    let result = run_upload_and_transcribe(
        &client,
        &api_key,
        &upload_path,
        &model,
        language_hints,
        diarization,
    )
    .await;

    if let Some(temp) = compressed_temp.take() {
        let _ = tokio::fs::remove_file(&temp).await;
    }

    result
}

/// Run `compress_for_upload` off the async runtime (it does blocking file IO +
/// CPU-bound decode/encode). Returns the temp output path on success.
async fn compress_for_upload_blocking(path: String) -> Result<std::path::PathBuf, String> {
    tokio::task::spawn_blocking(move || {
        crate::replay_audio::compress_for_upload(std::path::Path::new(&path))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("compression task panicked: {e}"))?
}

/// Upload `upload_path` to Soniox, create + poll the transcription job, fetch the
/// transcript, and group it into segments. Split out from `transcribe_file` so
/// the caller can guarantee temp-file cleanup regardless of outcome.
async fn run_upload_and_transcribe(
    client: &reqwest::Client,
    api_key: &str,
    upload_path: &str,
    model: &str,
    language_hints: Vec<String>,
    diarization: bool,
) -> Result<TranscriptionResult, String> {
    // 1. Upload the file → file id.
    let bytes = tokio::fs::read(upload_path)
        .await
        .map_err(|e| format!("Failed to read file: {e}"))?;
    let file_name = std::path::Path::new(upload_path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "recording".to_string());
    let part = reqwest::multipart::Part::bytes(bytes).file_name(file_name);
    let form = reqwest::multipart::Form::new().part("file", part);

    let upload_resp = client
        .post(format!("{SONIOX_BASE}/files"))
        .bearer_auth(api_key)
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
        model,
        language_hints: hints,
        enable_speaker_diarization: diarization,
    };
    let create_resp = client
        .post(format!("{SONIOX_BASE}/transcriptions"))
        .bearer_auth(api_key)
        .json(&create_body)
        .send()
        .await
        .map_err(|e| format!("Create transcription failed: {e}"))?;
    let created: IdResponse = read_json(create_resp, "create transcription").await?;
    let transcription_id = created.id;

    // 3. Poll until completed or error.
    let audio_duration_ms = loop_poll(client, api_key, &transcription_id).await?;

    // 4. Fetch the transcript tokens.
    let transcript_resp = client
        .get(format!(
            "{SONIOX_BASE}/transcriptions/{transcription_id}/transcript"
        ))
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|e| format!("Fetch transcript failed: {e}"))?;
    let transcript: TranscriptResponse = read_json(transcript_resp, "fetch transcript").await?;

    // Diagnostics: surface how well Soniox actually diarized, so a real
    // diarization problem (few/empty distinct speakers) can be told apart from a
    // grouping/labeling one on our side.
    {
        let toks = &transcript.tokens;
        let with_spk = toks.iter().filter(|t| t.speaker.is_some()).count();
        let mut speakers: std::collections::BTreeSet<i64> = std::collections::BTreeSet::new();
        for t in toks {
            if let Some(s) = t.speaker.as_ref() {
                speakers.insert(s.to_i64());
            }
        }
        eprintln!(
            "[replay] diarization: {} tokens, {} with speaker, distinct speakers={:?}",
            toks.len(),
            with_spk,
            speakers
        );
    }

    // 5. Best-effort cleanup of the uploaded file + transcription on Soniox.
    let _ = client
        .delete(format!("{SONIOX_BASE}/transcriptions/{transcription_id}"))
        .bearer_auth(api_key)
        .send()
        .await;
    let _ = client
        .delete(format!("{SONIOX_BASE}/files/{file_id}"))
        .bearer_auth(api_key)
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
        // Tokens without a speaker (e.g. some punctuation/spacing tokens) should
        // stay in the CURRENT speaker's run — snapping them to speaker 0 would
        // close the run and fragment the transcript into spurious extra speakers.
        let spk = match tok.speaker.as_ref() {
            Some(s) => s.to_i64(),
            None if cur_speaker >= 0 => cur_speaker,
            None => 0,
        };

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
