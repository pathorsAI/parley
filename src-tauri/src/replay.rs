//! Batch (async) transcription for uploaded recordings — the "replay" feature.
//!
//! Unlike the realtime adapters in `transcription/`, this hits each provider's
//! pre-recorded/batch API and returns ready-to-render, diarized-where-supported
//! segments. `transcribe_file` dispatches by provider: Soniox (upload → job →
//! poll → diarized tokens) is the reference; Deepgram / AssemblyAI / OpenAI /
//! Gemini adapters live alongside it but are GATED OFF in the STT registry
//! (`supportsFileUpload: false`) until each is smoke-tested against its live API.
//! The wrapper (compression, acoustic speech-rate, per-provider caching) is
//! provider-independent.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::transcription::common::ensure_crypto_provider;

const SONIOX_BASE: &str = "https://api.soniox.com/v1";
/// Async batch model (distinct from the realtime `stt-rt-v5`).
const DEFAULT_ASYNC_MODEL: &str = "stt-async-v5";
/// How long to wait between status polls.
const POLL_INTERVAL: Duration = Duration::from_millis(1500);
/// Safety cap so a stuck job can't poll forever (~20 min at 1.5s/poll).
const MAX_POLLS: u32 = 800;

/// A finished, diarized transcript segment handed to the frontend. Serializes to
/// camelCase so it matches the TS `TranscriptSegment` shape directly. Also
/// Deserialize so it can be read back from the on-disk transcription cache.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplaySegment {
    id: String,
    /// Always 0-based diarized speaker; the source is fixed to "them" in JS.
    speaker: i64,
    text: String,
    start_ms: u64,
    end_ms: u64,
}

/// Cache payload persisted per uploaded file (keyed by name+size). Holds the
/// successful transcription so an identical re-upload skips Soniox (and billing).
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedTranscription {
    segments: Vec<ReplaySegment>,
    duration_ms: u64,
    /// Measured articulation rate; `default` so caches written before this field
    /// existed still deserialize (they just read back as 0.0).
    #[serde(default)]
    speech_rate_hz: f32,
}

/// Result of `transcribe_file` — segments plus the overall duration. `cached` is
/// true when this came from the on-disk cache (no Soniox call, so the frontend
/// must NOT record STT usage for it).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionResult {
    segments: Vec<ReplaySegment>,
    duration_ms: u64,
    cached: bool,
    /// Acoustically measured articulation rate (syllable nuclei per second of
    /// voiced speech) over the whole recording — the post-call pace read, anchored
    /// to the audio rather than guessed from STT-timed text. 0.0 if unmeasurable.
    speech_rate_hz: f32,
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
    app: AppHandle,
    path: String,
    provider: String,
    api_key: String,
    model: Option<String>,
    language_hints: Vec<String>,
    diarization: bool,
) -> Result<TranscriptionResult, String> {
    ensure_crypto_provider();

    // File (batch) transcription is dispatched by `provider` at the transcription
    // call below. The frontend only offers providers whose `supportsFileUpload`
    // flag is on (transcription/providers.ts); the backend is the source of truth,
    // so an unknown/unimplemented provider is rejected in the match's fallthrough.
    // Adding a provider: implement its `*_batch` adapter, add a match arm below,
    // and flip its flag in the registry — only after a live smoke test.
    let provider = provider.trim().to_ascii_lowercase();

    if api_key.trim().is_empty() {
        log::warn!("replay: missing api key provider={}", provider);
        return Err("Missing transcription API key".to_string());
    }

    // Cache: an identical re-upload (same file name + byte size, same provider)
    // reuses the prior SUCCESSFUL transcription — no compression, no provider
    // call, no billing. Failures are never cached, so a previously-failed file
    // re-transcribes.
    let cache_path = cache_file_path(&app, &path, &provider);
    if let Some(cp) = &cache_path {
        if let Some(cached) = try_read_cache(cp).await {
            log::info!(
                "replay: cache hit segments={} path={}",
                cached.segments.len(),
                cp.display()
            );
            return Ok(TranscriptionResult {
                segments: cached.segments,
                duration_ms: cached.duration_ms,
                cached: true,
                speech_rate_hz: cached.speech_rate_hz,
            });
        }
    }

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
                (Some(orig), Some(comp)) => log::info!(
                    "replay: compressed audio origBytes={} compBytes={} pct={:.1}",
                    orig,
                    comp,
                    if orig > 0 {
                        comp as f64 / orig as f64 * 100.0
                    } else {
                        0.0
                    }
                ),
                _ => log::info!("replay: compressed audio (sizes unavailable)"),
            }
            let p = temp.to_string_lossy().into_owned();
            compressed_temp = Some(temp);
            p
        }
        Err(e) => {
            log::warn!("replay: compression failed, uploading original error={}", e);
            path.clone()
        }
    };

    // Measure the speaker's articulation rate acoustically over the audio we're
    // about to transcribe, so the post-call pace read is a real measurement — not
    // an LLM guess from STT-timed text. Done while the (compressed) temp still
    // exists; best-effort (0.0 on any decode failure, so it can never block STT).
    let speech_rate_hz = measure_speech_rate_blocking(upload_path.clone()).await;

    // Run the rest of the flow, ensuring the temp file is cleaned up afterward.
    // Dispatch on the provider — each `*_batch` returns the same
    // `TranscriptionResult` shape (segments + duration); the acoustic speech-rate
    // is grafted on afterward since it's provider-independent.
    let result = match provider.as_str() {
        "soniox" => run_upload_and_transcribe(
            &client,
            &api_key,
            &upload_path,
            model.as_deref().unwrap_or(DEFAULT_ASYNC_MODEL),
            &language_hints,
            diarization,
        )
        .await,
        "deepgram" => {
            deepgram_batch(&client, &api_key, &upload_path, &language_hints, diarization).await
        }
        "assemblyai" => {
            assemblyai_batch(&client, &api_key, &upload_path, &language_hints, diarization).await
        }
        "openai" => {
            openai_batch(&client, &api_key, &upload_path, model.as_deref(), &language_hints).await
        }
        "gemini" => {
            gemini_batch(&client, &api_key, &upload_path, model.as_deref(), &language_hints).await
        }
        other => Err(format!(
            "File transcription for '{other}' is not supported yet — switch to Soniox in Settings."
        )),
    }
    .map(|mut r| {
        r.speech_rate_hz = speech_rate_hz;
        r
    });

    if let Some(temp) = compressed_temp.take() {
        let _ = tokio::fs::remove_file(&temp).await;
    }

    // Cache a successful transcription so an identical re-upload is free next time.
    if let (Ok(r), Some(cp)) = (&result, &cache_path) {
        write_cache(cp, r).await;
    }

    result
}

/// Cache file path for an uploaded recording, keyed by file name + byte size (per
/// the user's "same name, same size" rule) and the provider (so a Soniox result
/// isn't served for, say, a Deepgram request — different diarization). Lives in
/// the app cache dir. `None` if the file can't be stat'd or there's no cache dir.
fn cache_file_path(app: &AppHandle, path: &str, provider: &str) -> Option<std::path::PathBuf> {
    let size = std::fs::metadata(path).ok()?.len();
    let name = std::path::Path::new(path)
        .file_name()?
        .to_string_lossy()
        .into_owned();
    // Sanitize the name to a safe single filename component.
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let dir = app.path().app_cache_dir().ok()?.join("transcriptions");
    // Soniox keeps its original (provider-less) filename so existing caches stay
    // valid; new providers get a suffixed key.
    let file = if provider == "soniox" {
        format!("{safe}-{size}.json")
    } else {
        format!("{safe}-{size}-{provider}.json")
    };
    Some(dir.join(file))
}

/// Read a cached transcription if present and parseable; otherwise `None`.
async fn try_read_cache(path: &std::path::Path) -> Option<CachedTranscription> {
    let bytes = tokio::fs::read(path).await.ok()?;
    serde_json::from_slice::<CachedTranscription>(&bytes).ok()
}

/// Persist a successful transcription to the cache. Best-effort: a failure here
/// is logged and ignored (never breaks the transcription that already succeeded).
async fn write_cache(path: &std::path::Path, result: &TranscriptionResult) {
    // Borrowing writer so we don't need to clone the segments.
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct CacheWrite<'a> {
        segments: &'a [ReplaySegment],
        duration_ms: u64,
        speech_rate_hz: f32,
    }
    let payload = CacheWrite {
        segments: &result.segments,
        duration_ms: result.duration_ms,
        speech_rate_hz: result.speech_rate_hz,
    };
    let json = match serde_json::to_vec_pretty(&payload) {
        Ok(j) => j,
        Err(e) => {
            log::warn!(
                "replay: failed to serialize transcription cache error={}",
                e
            );
            return;
        }
    };
    if let Some(parent) = path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    match tokio::fs::write(path, json).await {
        Ok(()) => log::debug!("replay: cached transcription path={}", path.display()),
        Err(e) => log::warn!("replay: failed to write transcription cache error={}", e),
    }
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

/// Measure the articulation rate (syllables/sec) of a recording already on disk.
/// Used by the LIVE-meeting save path so its post-call pace is the *same* quantity
/// as the upload path's — both decode the stored 16 kHz mono audio and run the
/// identical DSP, rather than the live windowed speaking-rate (which includes
/// pauses and would read systematically lower). Returns 0.0 if unmeasurable.
#[tauri::command]
pub async fn measure_audio_speech_rate(path: String) -> f32 {
    measure_speech_rate_blocking(path).await
}

/// Decode `path` to 16 kHz mono and measure the speaker's articulation rate off
/// the async runtime (CPU-bound decode + DSP). Best-effort: any decode failure or
/// task panic resolves to 0.0 so it can never block a transcription.
async fn measure_speech_rate_blocking(path: String) -> f32 {
    tokio::task::spawn_blocking(move || {
        match crate::replay_audio::decode_to_16k_mono(std::path::Path::new(&path)) {
            Ok(pcm) => crate::audio::prosody::measure_speech_rate_hz(&pcm, 16_000),
            Err(e) => {
                log::warn!("replay: speech-rate measure failed error={e}");
                0.0
            }
        }
    })
    .await
    .unwrap_or(0.0)
}

/// Upload `upload_path` to Soniox, create + poll the transcription job, fetch the
/// transcript, and group it into segments. Split out from `transcribe_file` so
/// the caller can guarantee temp-file cleanup regardless of outcome.
async fn run_upload_and_transcribe(
    client: &reqwest::Client,
    api_key: &str,
    upload_path: &str,
    model: &str,
    language_hints: &[String],
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
    log::info!(
        "replay: uploading to soniox fileName={} bytes={}",
        file_name,
        bytes.len()
    );
    // Clone for the multipart part so `file_name` stays available for the
    // diagnostic log written after transcription.
    let part = reqwest::multipart::Part::bytes(bytes).file_name(file_name.clone());
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
    log::debug!("replay: upload ok fileId={}", file_id);

    // 2. Create the async transcription job → transcription id.
    // Clone for the request body so the original `language_hints` stays available
    // for the diagnostic log written after the transcript is fetched.
    let hints = if language_hints.is_empty() {
        None
    } else {
        Some(language_hints.to_vec())
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
    log::info!(
        "replay: transcription job created transcriptionId={} model={} diarization={}",
        transcription_id,
        model,
        diarization
    );

    // 3. Poll until completed or error.
    let audio_duration_ms = loop_poll(client, api_key, &transcription_id).await?;

    // 4. Fetch the transcript tokens. We capture the RAW response body text (not
    // just the parsed struct) so we can write it verbatim to a diagnostic log
    // below — this lets the user inspect exactly what Soniox returned (per-token
    // speaker labels, distinct speaker count, …) when diarization looks wrong.
    let transcript_resp = client
        .get(format!(
            "{SONIOX_BASE}/transcriptions/{transcription_id}/transcript"
        ))
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|e| format!("Fetch transcript failed: {e}"))?;
    let (raw_transcript, transcript): (String, TranscriptResponse) =
        read_json_with_raw(transcript_resp, "fetch transcript").await?;

    // Diagnostics: surface how well Soniox actually diarized, so a real
    // diarization problem (few/empty distinct speakers) can be told apart from a
    // grouping/labeling one on our side.
    let (token_count, tokens_with_speaker, distinct_speakers) = {
        let toks = &transcript.tokens;
        let with_spk = toks.iter().filter(|t| t.speaker.is_some()).count();
        let mut speakers: std::collections::BTreeSet<i64> = std::collections::BTreeSet::new();
        for t in toks {
            if let Some(s) = t.speaker.as_ref() {
                speakers.insert(s.to_i64());
            }
        }
        log::info!(
            "replay: diarization tokens={} tokensWithSpeaker={} distinctSpeakers={:?}",
            toks.len(),
            with_spk,
            speakers
        );
        (toks.len(), with_spk, speakers)
    };

    // Persist a reviewable log of the raw Soniox response + request context.
    // Best-effort: never let a logging failure abort the transcription.
    write_soniox_log(SonioxLogContext {
        model,
        enable_speaker_diarization: diarization,
        language_hints,
        file_name: &file_name,
        audio_duration_ms,
        token_count,
        tokens_with_speaker,
        distinct_speakers: &distinct_speakers,
        raw_transcript: &raw_transcript,
    });

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
        cached: false,
        // Filled in by the caller (`transcribe_file`), which has the audio path.
        speech_rate_hz: 0.0,
    })
}

/// Poll the transcription status until it completes (returns the reported audio
/// duration) or errors. Surfaces a timeout if it never settles.
async fn loop_poll(
    client: &reqwest::Client,
    api_key: &str,
    transcription_id: &str,
) -> Result<u64, String> {
    for poll in 1..=MAX_POLLS {
        tokio::time::sleep(POLL_INTERVAL).await;

        let status_resp = client
            .get(format!("{SONIOX_BASE}/transcriptions/{transcription_id}"))
            .bearer_auth(api_key)
            .send()
            .await
            .map_err(|e| format!("Poll request failed: {e}"))?;
        let status: TranscriptionStatus = read_json(status_resp, "poll status").await?;

        match status.status.as_str() {
            "completed" => {
                let audio_duration_ms = status.audio_duration_ms.unwrap_or(0);
                log::info!(
                    "replay: transcription completed audioDurationMs={} polls={}",
                    audio_duration_ms,
                    poll
                );
                return Ok(audio_duration_ms);
            }
            "error" => {
                let msg = status
                    .error_message
                    .unwrap_or_else(|| "unknown error".into());
                log::error!("replay: transcription job error errorMessage={}", msg);
                return Err(format!("Transcription failed: {msg}"));
            }
            // "queued" | "processing" | anything else → keep polling.
            _ => continue,
        }
    }
    log::error!("replay: transcription timed out maxPolls={}", MAX_POLLS);
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

// ── Other batch providers ─────────────────────────────────────────────────────
// Each mirrors Soniox's contract: read the (already compressed) upload file, call
// the provider's pre-recorded/batch API, and return diarized-where-supported
// `ReplaySegment`s plus a duration. They're wired into the `transcribe_file`
// dispatch but GATED OFF in the registry (`supportsFileUpload: false`) until each
// is smoke-tested against the live API with a real key — the request/response
// shapes below come from each vendor's docs and are NOT yet verified end-to-end.
//
// NEEDS LIVE SMOKE TEST before flipping any `supportsFileUpload` flag on.

/// A speaker-tagged word with millisecond timings — the common currency for the
/// word-stream providers (Deepgram). Grouped into speaker-runs by `group_words`.
struct BatchWord {
    speaker: Option<i64>,
    text: String,
    start_ms: u64,
    end_ms: u64,
}

/// Group a flat word stream into speaker-runs, joining words with single spaces
/// (mirrors `group_tokens`, but for providers that return separate words rather
/// than Soniox's already-spaced tokens). A speaker change closes the current run;
/// a word with no speaker stays in the current run.
fn group_words(words: &[BatchWord]) -> Vec<ReplaySegment> {
    let mut segments: Vec<ReplaySegment> = Vec::new();
    let mut seg_index: u64 = 0;
    let mut cur_speaker: i64 = -1;
    let mut cur_text = String::new();
    let mut cur_start: u64 = 0;
    let mut cur_end: u64 = 0;

    for w in words {
        let spk = match w.speaker {
            Some(s) => s,
            None if cur_speaker >= 0 => cur_speaker,
            None => 0,
        };
        if cur_speaker == -1 {
            cur_speaker = spk;
            cur_start = w.start_ms;
        } else if spk != cur_speaker {
            if !cur_text.trim().is_empty() {
                segments.push(ReplaySegment {
                    id: format!("them-{seg_index}"),
                    speaker: cur_speaker,
                    text: cur_text.trim().to_string(),
                    start_ms: cur_start,
                    end_ms: cur_end,
                });
                seg_index += 1;
            }
            cur_speaker = spk;
            cur_text.clear();
            cur_start = w.start_ms;
        }
        if !cur_text.is_empty() {
            cur_text.push(' ');
        }
        cur_text.push_str(w.text.trim());
        cur_end = w.end_ms;
    }
    if !cur_text.trim().is_empty() {
        segments.push(ReplaySegment {
            id: format!("them-{seg_index}"),
            speaker: cur_speaker.max(0),
            text: cur_text.trim().to_string(),
            start_ms: cur_start,
            end_ms: cur_end,
        });
    }
    segments
}

/// Best-effort audio MIME from the file extension, for providers that want a
/// Content-Type on a raw upload (Deepgram) or inline data (Gemini). We compress to
/// Ogg/Opus before upload, so `.ogg`/`.opus` is the common case.
fn guess_audio_mime(path: &str) -> &'static str {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "ogg" | "opus" => "audio/ogg",
        "mp3" | "mpga" | "mpeg" => "audio/mpeg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "m4a" | "mp4" | "aac" => "audio/mp4",
        "webm" => "audio/webm",
        _ => "application/octet-stream",
    }
}

// --- Deepgram (pre-recorded) --------------------------------------------------

#[derive(Deserialize, Default)]
struct DgResponse {
    #[serde(default)]
    metadata: DgMeta,
    #[serde(default)]
    results: DgResults,
}
#[derive(Deserialize, Default)]
struct DgMeta {
    #[serde(default)]
    duration: f64,
}
#[derive(Deserialize, Default)]
struct DgResults {
    #[serde(default)]
    channels: Vec<DgChannel>,
}
#[derive(Deserialize, Default)]
struct DgChannel {
    #[serde(default)]
    alternatives: Vec<DgAlt>,
}
#[derive(Deserialize, Default)]
struct DgAlt {
    #[serde(default)]
    words: Vec<DgWord>,
}
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

/// Deepgram pre-recorded API: POST the raw (compressed) bytes to /v1/listen and
/// group the returned diarized word stream. NEEDS LIVE SMOKE TEST.
async fn deepgram_batch(
    client: &reqwest::Client,
    api_key: &str,
    upload_path: &str,
    language_hints: &[String],
    diarization: bool,
) -> Result<TranscriptionResult, String> {
    let bytes = tokio::fs::read(upload_path)
        .await
        .map_err(|e| format!("Failed to read file: {e}"))?;
    let mut url = format!(
        "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true&diarize={diarization}"
    );
    // One language hint pins the language; otherwise let Deepgram auto-detect.
    match language_hints.first() {
        Some(lang) => url.push_str(&format!("&language={lang}")),
        None => url.push_str("&detect_language=true"),
    }
    let resp = client
        .post(url)
        .header("Authorization", format!("Token {api_key}"))
        .header("Content-Type", guess_audio_mime(upload_path))
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("Deepgram request failed: {e}"))?;
    let dg: DgResponse = read_json(resp, "deepgram transcribe").await?;
    let words: Vec<BatchWord> = dg
        .results
        .channels
        .first()
        .and_then(|c| c.alternatives.first())
        .map(|a| a.words.as_slice())
        .unwrap_or(&[])
        .iter()
        .map(|w| BatchWord {
            speaker: w.speaker,
            text: w.punctuated_word.clone().unwrap_or_else(|| w.word.clone()),
            start_ms: (w.start * 1000.0) as u64,
            end_ms: (w.end * 1000.0) as u64,
        })
        .collect();
    let segments = group_words(&words);
    let duration_ms = ((dg.metadata.duration * 1000.0) as u64)
        .max(segments.iter().map(|s| s.end_ms).max().unwrap_or(0));
    Ok(TranscriptionResult {
        segments,
        duration_ms,
        cached: false,
        speech_rate_hz: 0.0,
    })
}

// --- AssemblyAI (upload → transcript → poll) ----------------------------------

#[derive(Deserialize, Default)]
struct AaiUpload {
    #[serde(default)]
    upload_url: String,
}
#[derive(Deserialize, Default)]
struct AaiTranscript {
    #[serde(default)]
    id: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    audio_duration: Option<f64>,
    #[serde(default)]
    utterances: Option<Vec<AaiUtterance>>,
}
#[derive(Deserialize, Default)]
struct AaiUtterance {
    #[serde(default)]
    speaker: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    start: u64,
    #[serde(default)]
    end: u64,
}

/// AssemblyAI speaker labels are letters ("A", "B", …); map to a 0-based index.
fn assemblyai_speaker_index(s: &str) -> i64 {
    let s = s.trim();
    if let Some(c) = s.chars().next() {
        if c.is_ascii_alphabetic() {
            return (c.to_ascii_uppercase() as i64) - ('A' as i64);
        }
    }
    s.parse::<i64>().unwrap_or(0)
}

/// AssemblyAI batch: upload the bytes, create a transcript job (optionally with
/// speaker labels), poll to completion, then map utterances to speaker-runs.
/// NEEDS LIVE SMOKE TEST.
async fn assemblyai_batch(
    client: &reqwest::Client,
    api_key: &str,
    upload_path: &str,
    language_hints: &[String],
    diarization: bool,
) -> Result<TranscriptionResult, String> {
    let bytes = tokio::fs::read(upload_path)
        .await
        .map_err(|e| format!("Failed to read file: {e}"))?;
    // 1. Upload the raw bytes → a temporary upload_url.
    let up_resp = client
        .post("https://api.assemblyai.com/v2/upload")
        .header("authorization", api_key)
        .header("content-type", "application/octet-stream")
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("AssemblyAI upload failed: {e}"))?;
    let up: AaiUpload = read_json(up_resp, "assemblyai upload").await?;

    // 2. Create the transcript job. speaker_labels ⇒ diarization; the language is
    // auto-detected unless a single hint pins it.
    let mut body = serde_json::Map::new();
    body.insert("audio_url".into(), serde_json::Value::String(up.upload_url));
    body.insert(
        "speaker_labels".into(),
        serde_json::Value::Bool(diarization),
    );
    match language_hints.first() {
        Some(lang) => {
            body.insert("language_code".into(), serde_json::Value::String(lang.clone()));
        }
        None => {
            body.insert("language_detection".into(), serde_json::Value::Bool(true));
        }
    }
    let create_resp = client
        .post("https://api.assemblyai.com/v2/transcript")
        .header("authorization", api_key)
        .json(&serde_json::Value::Object(body))
        .send()
        .await
        .map_err(|e| format!("AssemblyAI create failed: {e}"))?;
    let created: AaiTranscript = read_json(create_resp, "assemblyai create").await?;
    let id = created.id.clone();
    if id.is_empty() {
        return Err("AssemblyAI: no transcript id returned".to_string());
    }

    // 3. Poll until completed or error.
    let final_t: AaiTranscript = {
        let mut done: Option<AaiTranscript> = None;
        for _ in 0..MAX_POLLS {
            tokio::time::sleep(POLL_INTERVAL).await;
            let poll_resp = client
                .get(format!("https://api.assemblyai.com/v2/transcript/{id}"))
                .header("authorization", api_key)
                .send()
                .await
                .map_err(|e| format!("AssemblyAI poll failed: {e}"))?;
            let t: AaiTranscript = read_json(poll_resp, "assemblyai poll").await?;
            match t.status.as_str() {
                "completed" => {
                    done = Some(t);
                    break;
                }
                "error" => {
                    return Err(format!(
                        "AssemblyAI transcription failed: {}",
                        t.error.unwrap_or_else(|| "unknown error".into())
                    ));
                }
                _ => continue,
            }
        }
        done.ok_or_else(|| "AssemblyAI transcription timed out".to_string())?
    };

    // 4. Prefer diarized utterances; fall back to the flat transcript text.
    let duration_ms_meta = final_t.audio_duration.map(|d| (d * 1000.0) as u64).unwrap_or(0);
    let segments: Vec<ReplaySegment> = match final_t.utterances {
        Some(utts) if !utts.is_empty() => utts
            .into_iter()
            .filter(|u| !u.text.trim().is_empty())
            .enumerate()
            .map(|(i, u)| ReplaySegment {
                id: format!("them-{i}"),
                speaker: assemblyai_speaker_index(&u.speaker),
                text: u.text.trim().to_string(),
                start_ms: u.start,
                end_ms: u.end,
            })
            .collect(),
        _ => {
            let text = final_t.text.clone().unwrap_or_default();
            if text.trim().is_empty() {
                Vec::new()
            } else {
                vec![ReplaySegment {
                    id: "them-0".to_string(),
                    speaker: 0,
                    text: text.trim().to_string(),
                    start_ms: 0,
                    end_ms: duration_ms_meta,
                }]
            }
        }
    };
    let duration_ms = duration_ms_meta.max(segments.iter().map(|s| s.end_ms).max().unwrap_or(0));
    Ok(TranscriptionResult {
        segments,
        duration_ms,
        cached: false,
        speech_rate_hz: 0.0,
    })
}

// --- OpenAI (/v1/audio/transcriptions) ----------------------------------------

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

/// OpenAI transcription with `verbose_json` for segment timestamps. No
/// diarization → a single speaker. 25 MB request limit (compression helps).
/// NEEDS LIVE SMOKE TEST.
async fn openai_batch(
    client: &reqwest::Client,
    api_key: &str,
    upload_path: &str,
    model: Option<&str>,
    language_hints: &[String],
) -> Result<TranscriptionResult, String> {
    let bytes = tokio::fs::read(upload_path)
        .await
        .map_err(|e| format!("Failed to read file: {e}"))?;
    let file_name = std::path::Path::new(upload_path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "recording.ogg".to_string());
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(file_name)
        .mime_str(guess_audio_mime(upload_path))
        .map_err(|e| format!("openai: bad mime: {e}"))?;
    // whisper-1 returns verbose_json segments with timestamps; the gpt-4o
    // transcribe models don't, so default to whisper-1 for the replay path.
    let model = model.unwrap_or("whisper-1");
    let mut form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", model.to_string())
        .text("response_format", "verbose_json");
    if let Some(lang) = language_hints.first() {
        form = form.text("language", lang.clone());
    }
    let resp = client
        .post("https://api.openai.com/v1/audio/transcriptions")
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("OpenAI request failed: {e}"))?;
    let v: OaiVerbose = read_json(resp, "openai transcribe").await?;
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
    let duration_ms =
        ((v.duration * 1000.0) as u64).max(segments.iter().map(|s| s.end_ms).max().unwrap_or(0));
    Ok(TranscriptionResult {
        segments,
        duration_ms,
        cached: false,
        speech_rate_hz: 0.0,
    })
}

// --- Gemini (generateContent with inline audio) -------------------------------

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

/// Gemini transcription via generateContent with inline audio. No timestamps or
/// diarization, so the whole transcript is a single segment spanning the file
/// (its length is measured by decoding). NEEDS LIVE SMOKE TEST.
async fn gemini_batch(
    client: &reqwest::Client,
    api_key: &str,
    upload_path: &str,
    model: Option<&str>,
    _language_hints: &[String],
) -> Result<TranscriptionResult, String> {
    use base64::Engine as _;
    let bytes = tokio::fs::read(upload_path)
        .await
        .map_err(|e| format!("Failed to read file: {e}"))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let model = model.unwrap_or("gemini-2.5-flash");
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    );
    let body = serde_json::json!({
        "contents": [{
            "parts": [
                { "inline_data": { "mime_type": guess_audio_mime(upload_path), "data": b64 } },
                { "text": "Transcribe this audio verbatim. Output only the transcript text, with no commentary, labels, or timestamps." }
            ]
        }]
    });
    let resp = client
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
    let path = upload_path.to_string();
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
    Ok(TranscriptionResult {
        segments,
        duration_ms,
        cached: false,
        speech_rate_hz: 0.0,
    })
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
        log::error!("replay: {} http error status={}", ctx, status);
        return Err(format!("{ctx}: HTTP {status}: {text}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("{ctx}: bad response JSON: {e} — {text}"))
}

/// Like `read_json`, but also returns the RAW response body text alongside the
/// parsed struct. Used for the transcript fetch so the exact bytes Soniox sent
/// can be written to a diagnostic log. Error handling matches `read_json`: HTTP
/// status + body are surfaced on failure.
async fn read_json_with_raw<T: serde::de::DeserializeOwned>(
    resp: reqwest::Response,
    ctx: &str,
) -> Result<(String, T), String> {
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("{ctx}: failed to read response: {e}"))?;
    if !status.is_success() {
        log::error!("replay: {} http error status={}", ctx, status);
        return Err(format!("{ctx}: HTTP {status}: {text}"));
    }
    let parsed = serde_json::from_str(&text)
        .map_err(|e| format!("{ctx}: bad response JSON: {e} — {text}"))?;
    Ok((text, parsed))
}

/// Inputs for the Soniox diagnostic log. Bundled into one struct so the call
/// site stays readable and the writer can stay best-effort.
struct SonioxLogContext<'a> {
    model: &'a str,
    enable_speaker_diarization: bool,
    language_hints: &'a [String],
    file_name: &'a str,
    audio_duration_ms: u64,
    token_count: usize,
    tokens_with_speaker: usize,
    distinct_speakers: &'a std::collections::BTreeSet<i64>,
    /// The full, verbatim transcript JSON body returned by Soniox.
    raw_transcript: &'a str,
}

/// Write a reviewable JSON log of the raw Soniox transcript response plus the
/// request context to `~/Documents/Parley/logs/soniox-<timestamp>.json`.
///
/// Best-effort: any failure (no HOME, IO error, …) is reported via `log::warn!`
/// and swallowed — logging must NEVER fail the transcription.
fn write_soniox_log(ctx: SonioxLogContext) {
    if let Err(e) = try_write_soniox_log(&ctx) {
        log::warn!("replay: failed to write soniox response log error={}", e);
    }
}

/// Fallible inner half of `write_soniox_log`. Returns the absolute path written.
fn try_write_soniox_log(ctx: &SonioxLogContext) -> Result<(), String> {
    // Mirror commands.rs::save_transcript's ~/Documents/Parley layout, under a
    // dedicated `logs/` subdirectory.
    let home = std::env::var("HOME").map_err(|_| "no HOME dir".to_string())?;
    let dir = std::path::Path::new(&home)
        .join("Documents")
        .join("Parley")
        .join("logs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // Unique, human-readable file name: a UTC timestamp (seconds since the Unix
    // epoch — no wall-clock formatting dependency) plus a short uuid suffix so
    // two uploads in the same second never collide.
    let unix_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let suffix = &suffix[..8];
    let path = dir.join(format!("soniox-{unix_secs}-{suffix}.json"));

    // Embed the raw transcript as parsed JSON when it parses, else keep it as a
    // string so nothing is ever lost.
    let raw_value: serde_json::Value = serde_json::from_str(ctx.raw_transcript)
        .unwrap_or_else(|_| serde_json::Value::String(ctx.raw_transcript.to_string()));

    let distinct: Vec<i64> = ctx.distinct_speakers.iter().copied().collect();
    let log = serde_json::json!({
        "request": {
            "model": ctx.model,
            "enable_speaker_diarization": ctx.enable_speaker_diarization,
            "language_hints": ctx.language_hints,
            "file_name": ctx.file_name,
        },
        "audio_duration_ms": ctx.audio_duration_ms,
        "diarization_summary": {
            "token_count": ctx.token_count,
            "tokens_with_speaker": ctx.tokens_with_speaker,
            "distinct_speakers": distinct,
            "distinct_speaker_count": distinct.len(),
        },
        "raw_transcript": raw_value,
    });

    let pretty = serde_json::to_string_pretty(&log).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty).map_err(|e| e.to_string())?;

    // Surface the absolute path in the dev log so the user can find the file.
    log::info!("replay: saved soniox log path={}", path.to_string_lossy());
    Ok(())
}
