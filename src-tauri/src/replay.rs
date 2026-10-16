//! Batch (async) transcription for uploaded recordings — the "replay" feature.
//!
//! Unlike the realtime adapters, this hits each provider's pre-recorded/batch
//! API and returns ready-to-render, diarized-where-supported segments. Which
//! adapter serves a provider is its registry row's `batch` entry
//! (`transcription::provider`); the adapters themselves live in the provider
//! modules and share `transcription::batch`. The BYOK adapters — Soniox
//! (upload → job → poll → diarized tokens), Deepgram, AssemblyAI, OpenAI and
//! Gemini — talk to their vendor with the user's own key; Gemini is still
//! GATED OFF in the frontend's STT registry (`supportsFileUpload: false`) until
//! it's smoke-tested against its live API. Hosted "parley" posts to Parley
//! Cloud's batch routes and reads back Parley's own token shape
//! (`docs/design/stt-protocol.md`); it authenticates with the cloud session
//! token exactly like the live hosted stream does. This module is the
//! provider-independent wrapper: credential checks, compression, acoustic
//! speech-rate, the per-provider cache, and the diagnostic response log.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::transcription::batch::{
    read_upload, BatchFn, BatchRequest, PollPolicy, ReplaySegment, ResponseLog, TranscriptionResult,
};
use crate::transcription::common::ensure_crypto_provider;
use crate::transcription::provider::{self, Batch, Credential};
use crate::transcription::{Entry, SessionRequest, SttProvider};

/// Cache payload persisted per uploaded file (keyed by name+size). Holds the
/// successful transcription so an identical re-upload skips the provider (and billing).
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

/// What the frontend asked to transcribe, as the dispatch below needs it.
struct Upload<'a> {
    /// The normalized (trimmed, lowercase) provider id, and its registry row
    /// when it has one.
    id: &'a str,
    provider: Option<SttProvider>,
    path: &'a str,
    credential: &'a str,
    model: Option<&'a str>,
    language_hints: &'a [String],
    diarization: bool,
    batch_url: Option<&'a str>,
    vocabulary: &'a [String],
}

/// Transcribe an audio file via the selected provider's batch API and return
/// diarized segments.
///
/// `language_hints` may be empty (providers auto-detect). `diarization` toggles
/// speaker separation. The `api_key` is supplied by the frontend and never leaves
/// the Rust side beyond the provider request — for hosted "parley" it is the
/// cloud session token, and `batch_url` is the cloud batch endpoint.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn transcribe_file(
    app: AppHandle,
    path: String,
    provider: String,
    api_key: String,
    model: Option<String>,
    language_hints: Vec<String>,
    diarization: bool,
    // Hosted "parley" mode: the cloud batch endpoint's `https://` base URL. When
    // set, `api_key` is the cloud Bearer token (not a vendor key). Absent for
    // BYOK providers, which address their vendor from the adapter itself.
    batch_url: Option<String>,
    // The phrase dictionary's phrases, biased into recognition by whichever
    // batch API is used (see `TranscribeConfig::vocabulary` for the live twin).
    // Optional so a caller that predates the dictionary still works.
    vocabulary: Option<Vec<String>>,
) -> Result<TranscriptionResult, String> {
    ensure_crypto_provider();
    let vocabulary = vocabulary.unwrap_or_default();

    // File (batch) transcription is dispatched by the provider's registry row.
    // The frontend only offers providers whose `supportsFileUpload` flag is on
    // (transcription/providers.ts); the backend is the source of truth, so an
    // unknown/unimplemented provider is rejected at dispatch.
    let provider = provider.trim().to_ascii_lowercase();
    let upload = Upload {
        id: &provider,
        provider: SttProvider::from_id(&provider).ok(),
        path: &path,
        credential: &api_key,
        model: model.as_deref(),
        language_hints: &language_hints,
        diarization,
        batch_url: batch_url.as_deref(),
        vocabulary: &vocabulary,
    };
    // The start checks are the live ones, run where each one used to happen
    // on this path: the credential first, the on-device model after the
    // cache (a cached result needs no model), the cloud URL at dispatch.
    upload
        .request()
        .check_credential(Entry::Upload)
        .inspect_err(|_| {
            log::warn!("replay: missing api key provider={}", provider);
        })?;

    // Cache: an identical re-upload (same file name + byte size, same provider)
    // reuses the prior SUCCESSFUL transcription — no compression, no provider
    // call, no billing. Failures are never cached, so a previously-failed file
    // re-transcribes.
    let suffix = cache_suffix(&provider, upload.model);
    let cache_path = cache_file_path(&app, &path, suffix.as_deref());
    if let Some(cached) = read_cached(cache_path.as_deref()).await {
        return Ok(cached);
    }

    let batch = upload.provider.and_then(|p| p.spec().batch.as_ref());
    // On-device: no upload, so no compression either — decode the original
    // file directly. Checked before any work so a missing model fails fast.
    if let Some(Batch::OnDevice) = batch {
        return local_transcribe(&app, &upload, cache_path).await;
    }
    let adapter = match batch {
        Some(Batch::Upload(adapter)) => Some(*adapter),
        _ => None,
    };
    let result = transcribe_upload(&app, &upload, adapter).await;

    // Cache a successful transcription so an identical re-upload is free next time.
    if let (Ok(r), Some(cp)) = (&result, &cache_path) {
        write_cache(cp, r).await;
    }
    result
}

impl Upload<'_> {
    /// The upload as the shared start checks see it (the batch URL trimmed).
    fn request(&self) -> SessionRequest<'_> {
        SessionRequest::new(
            self.provider,
            self.credential,
            self.batch_url.map(str::trim),
            self.model,
        )
    }
}

/// The endpoint a batch adapter is handed: the cloud batch URL for a hosted
/// upload (refused when missing), `None` for a vendor the adapter addresses
/// itself.
fn batch_endpoint<'a>(request: &SessionRequest<'a>) -> Result<Option<&'a str>, String> {
    request.check_endpoint(Entry::Upload)?;
    Ok(match request.credential {
        Credential::CloudSession => request.endpoint,
        _ => None,
    })
}

/// The error for a provider id without a batch adapter. Only an
/// unknown/misspelled id gets here — naming a specific replacement would go
/// stale the way "switch to Soniox" did.
fn unsupported_batch_provider(provider: &str) -> String {
    format!(
        "File transcription for '{provider}' is not supported yet — switch to another transcription provider in Settings."
    )
}

/// The provider part of an upload's cache file name, from its registry row
/// (see `provider::UploadCache`); an id without a row keys by the id itself.
fn cache_suffix(provider: &str, model: Option<&str>) -> Option<String> {
    match provider::spec(provider) {
        Some(spec) => spec.upload_cache_suffix(model),
        None => Some(provider.to_string()),
    }
}

/// Compress the recording, measure its speech rate, hand it to the provider's
/// batch adapter, and clean the compressed temp file up whatever happens.
async fn transcribe_upload(
    app: &AppHandle,
    upload: &Upload<'_>,
    adapter: Option<BatchFn>,
) -> Result<TranscriptionResult, String> {
    let (upload_path, compressed_temp) = compress_upload(upload.path).await;

    // Measure the speaker's articulation rate acoustically over the audio we're
    // about to transcribe, so the post-call pace read is a real measurement — not
    // an LLM guess from STT-timed text. Done while the (compressed) temp still
    // exists; best-effort (0.0 on any decode failure, so it can never block STT).
    let speech_rate_hz = measure_speech_rate_blocking(upload_path.clone()).await;

    // Every adapter returns the same `TranscriptionResult` shape (segments +
    // duration); the acoustic speech-rate is grafted on afterward since it's
    // provider-independent.
    let result = match adapter {
        Some(adapter) => run_adapter(app, upload, adapter, &upload_path).await,
        None => Err(unsupported_batch_provider(upload.id)),
    }
    .map(|mut r| {
        r.speech_rate_hz = speech_rate_hz;
        r
    });

    if let Some(temp) = compressed_temp {
        let _ = tokio::fs::remove_file(&temp).await;
    }
    result
}

/// Run one provider's batch adapter over the (compressed) upload. The BYOK
/// adapters address their vendor themselves; the hosted one talks only to
/// Parley Cloud, whose endpoint has to be handed in from the frontend.
async fn run_adapter(
    app: &AppHandle,
    upload: &Upload<'_>,
    adapter: BatchFn,
    upload_path: &str,
) -> Result<TranscriptionResult, String> {
    let endpoint = batch_endpoint(&upload.request())?;
    let audio = read_upload(upload_path).await?;
    let client = reqwest::Client::new();
    adapter(BatchRequest {
        client: &client,
        endpoint,
        poll: PollPolicy::DEFAULT,
        credential: upload.credential,
        upload_path,
        audio,
        model: upload.model,
        language_hints: upload.language_hints,
        diarization: upload.diarization,
        vocabulary: upload.vocabulary,
        log: &DocumentsLog(app),
    })
    .await
}

/// Try to compress the recording to a much smaller Opus/Ogg file before
/// uploading. This is best-effort: any failure (unsupported codec, encode
/// error, …) falls back to uploading the original file so it never blocks an
/// upload. Returns the path to upload and, when a temp file was produced, that
/// file so the caller can delete it afterward (even on error).
async fn compress_upload(path: &str) -> (String, Option<std::path::PathBuf>) {
    let original_size = tokio::fs::metadata(path).await.map(|m| m.len()).ok();
    match compress_for_upload_blocking(path.to_string()).await {
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
            (temp.to_string_lossy().into_owned(), Some(temp))
        }
        Err(e) => {
            log::warn!("replay: compression failed, uploading original error={}", e);
            (path.to_string(), None)
        }
    }
}

/// The on-device arm of [`transcribe_file`]: whisper.cpp on this machine (see
/// `transcription::local::transcribe_file_blocking`). Speaker 0 throughout —
/// the app re-diarizes uploads from the audio separately (diarize.rs).
async fn local_transcribe(
    app: &AppHandle,
    upload: &Upload<'_>,
    cache_path: Option<std::path::PathBuf>,
) -> Result<TranscriptionResult, String> {
    upload
        .request()
        .check_model(|model| crate::local_stt::ensure_installed(app, model))?;
    let model = upload.model.unwrap_or_default().to_string();
    let app_for_task = app.clone();
    let audio_path = std::path::PathBuf::from(upload.path);
    let hints = upload.language_hints.to_vec();
    let vocab = upload.vocabulary.to_vec();
    let (decoded, duration_ms) = tauri::async_runtime::spawn_blocking(move || {
        crate::transcription::local::transcribe_file_blocking(
            &app_for_task,
            &audio_path,
            &model,
            &hints,
            &vocab,
        )
    })
    .await
    .map_err(|e| format!("Local transcription failed: {e}"))??;
    let segments: Vec<ReplaySegment> = decoded
        .into_iter()
        .enumerate()
        .map(|(i, d)| ReplaySegment {
            id: format!("them-{i}"),
            speaker: 0,
            text: d.text,
            start_ms: d.start_ms,
            end_ms: d.end_ms,
        })
        .collect();
    let speech_rate_hz = measure_speech_rate_blocking(upload.path.to_string()).await;
    let result = TranscriptionResult {
        segments,
        duration_ms,
        cached: false,
        speech_rate_hz,
    };
    if let Some(cp) = &cache_path {
        write_cache(cp, &result).await;
    }
    Ok(result)
}

/// Cache file path for an uploaded recording, keyed by file name + byte size (per
/// the user's "same name, same size" rule) and the provider (so a Soniox result
/// isn't served for, say, a Deepgram request — different diarization). Lives in
/// the app cache dir. `None` if the file can't be stat'd or there's no cache dir.
fn cache_file_path(
    app: &AppHandle,
    path: &str,
    suffix: Option<&str>,
) -> Option<std::path::PathBuf> {
    let size = std::fs::metadata(path).ok()?.len();
    let name = std::path::Path::new(path)
        .file_name()?
        .to_string_lossy()
        .into_owned();
    let dir = app
        .path()
        .app_cache_dir()
        .ok()?
        .join(crate::cache::TRANSCRIPTIONS_DIR);
    Some(dir.join(cache_file_name(&name, size, suffix)))
}

/// The cache file name for an upload named `name` of `size` bytes, with the
/// provider's [`cache_suffix`].
fn cache_file_name(name: &str, size: u64, suffix: Option<&str>) -> String {
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
    match suffix {
        None => format!("{safe}-{size}.json"),
        Some(suffix) => format!("{safe}-{size}-{suffix}.json"),
    }
}

/// The cached transcription at `cache_path`, as a cache-hit result.
async fn read_cached(cache_path: Option<&std::path::Path>) -> Option<TranscriptionResult> {
    let cp = cache_path?;
    let cached = try_read_cache(cp).await?;
    log::info!(
        "replay: cache hit segments={} path={}",
        cached.segments.len(),
        cp.display()
    );
    Some(TranscriptionResult {
        segments: cached.segments,
        duration_ms: cached.duration_ms,
        cached: true,
        speech_rate_hz: cached.speech_rate_hz,
    })
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

/// The app's [`ResponseLog`]: a reviewable JSON file per logged response at
/// `<Documents>/Parley/logs/<provider>-<timestamp>-<suffix>.json`.
struct DocumentsLog<'a>(&'a AppHandle);

impl ResponseLog for DocumentsLog<'_> {
    /// Best-effort: any failure (unresolvable Documents dir, IO error, …) is
    /// reported via `log::warn!` and swallowed — logging must NEVER fail the
    /// transcription.
    fn write(&self, provider: &str, entry: serde_json::Value) {
        if let Err(e) = write_response_log(self.0, provider, &entry) {
            log::warn!(
                "replay: failed to write {provider} response log error={}",
                e
            );
        }
    }
}

/// Fallible half of [`DocumentsLog::write`].
fn write_response_log(
    app: &AppHandle,
    provider: &str,
    entry: &serde_json::Value,
) -> Result<(), String> {
    // Mirror commands.rs::save_transcript's Documents/Parley layout, under a
    // dedicated `logs/` subdirectory — same `documents_dir` resolver, so both
    // land in the same place on every platform.
    let dir = crate::commands::documents_dir(app)?.join("logs");
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
    let path = dir.join(format!("{provider}-{unix_secs}-{suffix}.json"));

    let pretty = serde_json::to_string_pretty(entry).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty).map_err(|e| e.to_string())?;

    // Surface the absolute path in the dev log so the user can find the file.
    log::info!(
        "replay: saved {provider} log path={}",
        path.to_string_lossy()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn upload<'a>(id: &'a str, key: &'a str, batch_url: Option<&'a str>) -> Upload<'a> {
        Upload {
            id,
            provider: SttProvider::from_id(id).ok(),
            path: "rec.ogg",
            credential: key,
            model: None,
            language_hints: &[],
            diarization: true,
            batch_url,
            vocabulary: &[],
        }
    }

    #[test]
    fn an_upload_without_a_credential_is_refused_unless_on_device() {
        let missing = "Missing transcription credential — add the provider's API key in Settings, or sign in to Parley Cloud.";
        for provider in [
            "soniox",
            "deepgram",
            "assemblyai",
            "openai",
            "gemini",
            "parley",
            "nope",
        ] {
            let check = |key| {
                upload(provider, key, None)
                    .request()
                    .check_credential(Entry::Upload)
            };
            assert_eq!(check(" "), Err(missing.to_string()), "{provider}");
            assert_eq!(check("k"), Ok(()));
        }
        assert_eq!(
            upload("local", "", None)
                .request()
                .check_credential(Entry::Upload),
            Ok(())
        );
    }

    #[test]
    fn hosted_uploads_need_the_batch_url() {
        let missing = Err("hosted transcription requires the cloud batch URL".to_string());
        let endpoint = |id, url| {
            batch_endpoint(&upload(id, "k", url).request()).map(|e| e.map(str::to_string))
        };
        assert_eq!(endpoint("parley", None), missing);
        assert_eq!(endpoint("parley", Some("  ")), missing);
        assert_eq!(
            endpoint("parley", Some(" https://x/stt/batch ")),
            Ok(Some("https://x/stt/batch".to_string()))
        );
        // A vendor's adapter addresses the vendor itself.
        assert_eq!(endpoint("deepgram", Some("https://x")), Ok(None));
        assert_eq!(endpoint("nope", None), Ok(None));
        assert_eq!(
            unsupported_batch_provider("whisperx"),
            "File transcription for 'whisperx' is not supported yet — switch to another transcription provider in Settings."
        );
    }

    #[test]
    fn cache_file_names_stay_stable() {
        // Existing caches on users' disks are found by exactly these names.
        let name = |file: &str, size: u64, provider: &str, model: Option<&str>| {
            cache_file_name(file, size, cache_suffix(provider, model).as_deref())
        };
        assert_eq!(
            name("rec.ogg", 42, "soniox", Some("stt-async-v5")),
            "rec.ogg-42.json"
        );
        for provider in ["deepgram", "assemblyai", "openai", "gemini", "parley"] {
            assert_eq!(
                name("rec.ogg", 42, provider, Some("m")),
                format!("rec.ogg-42-{provider}.json")
            );
        }
        assert_eq!(
            name("會議 #1.m4a", 7, "parley", None),
            "會議__1.m4a-7-parley.json"
        );
        assert_eq!(
            name("a/b.wav", 1, "local", Some("whisper-small-q5_1")),
            "a_b.wav-1-local-whisper-small-q5_1.json"
        );
        assert_eq!(
            name("a.wav", 1, "local", None),
            format!("a.wav-1-local-{}.json", crate::local_stt::DEFAULT_MODEL_ID)
        );
        // An id without a registry row still keys by the id.
        assert_eq!(name("a.wav", 1, "retired", None), "a.wav-1-retired.json");
    }
}
