//! Batch (upload) transcription plumbing shared by the providers' batch
//! adapters: the request every adapter is handed ([`BatchRequest`]), the result
//! shape the frontend renders ([`TranscriptionResult`]), and the pieces every
//! adapter used to write for itself — HTTP body reading, job polling, and
//! grouping tokens or words into speaker-runs.
//!
//! An adapter is one `transcribe_file` function in its provider's module,
//! registered as the provider's [`super::provider::Batch::Upload`] entry. The
//! replay command (`crate::replay`) owns everything provider-independent
//! around it: credential checks, compression, the upload cache, speech rate.

use std::future::Future;
use std::time::Duration;

use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};

/// How long to wait between status polls.
const POLL_INTERVAL: Duration = Duration::from_millis(1500);
/// Safety cap so a stuck job can't poll forever (~20 min at 1.5s/poll).
const MAX_POLLS: u32 = 800;

/// How a batch adapter polls a job: the production cadence is
/// [`PollPolicy::DEFAULT`]; tests shorten it so a polled job settles at once.
#[derive(Clone, Copy, Debug)]
pub struct PollPolicy {
    pub interval: Duration,
    pub max_polls: u32,
}

impl PollPolicy {
    pub const DEFAULT: Self = Self {
        interval: POLL_INTERVAL,
        max_polls: MAX_POLLS,
    };
}

/// A finished, diarized transcript segment handed to the frontend. Serializes to
/// camelCase so it matches the TS `TranscriptSegment` shape directly. Also
/// Deserialize so it can be read back from the on-disk transcription cache.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaySegment {
    pub id: String,
    /// Always 0-based diarized speaker; the source is fixed to "them" in JS.
    pub speaker: i64,
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

/// Result of `transcribe_file` — segments plus the overall duration. `cached` is
/// true when this came from the on-disk cache (no provider call, so the frontend
/// must NOT record STT usage for it).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionResult {
    pub segments: Vec<ReplaySegment>,
    pub duration_ms: u64,
    pub cached: bool,
    /// Acoustically measured articulation rate (syllable nuclei per second of
    /// voiced speech) over the whole recording — the post-call pace read, anchored
    /// to the audio rather than guessed from STT-timed text. 0.0 if unmeasurable.
    pub speech_rate_hz: f32,
}

impl TranscriptionResult {
    /// A provider's fresh answer. The speech rate is grafted on afterwards by
    /// the replay command, which has the audio.
    pub fn fresh(segments: Vec<ReplaySegment>, duration_ms: u64) -> Self {
        Self {
            segments,
            duration_ms,
            cached: false,
            speech_rate_hz: 0.0,
        }
    }
}

/// Where an adapter may write a verbatim copy of a provider response for
/// diagnosis (in the app: a JSON file under Documents/Parley/logs). Writing is
/// best-effort; an adapter never fails because of it.
pub trait ResponseLog: Sync {
    /// Persist `entry` as `{provider}`'s diagnostic log.
    fn write(&self, provider: &str, entry: serde_json::Value);
}

/// A [`ResponseLog`] that drops everything.
#[cfg(test)]
pub struct NoLog;

#[cfg(test)]
impl ResponseLog for NoLog {
    fn write(&self, _provider: &str, _entry: serde_json::Value) {}
}

/// Everything a batch adapter is handed for one upload.
pub struct BatchRequest<'a> {
    pub client: &'a reqwest::Client,
    /// The cloud batch base URL for a [`super::Credential::CloudSession`]
    /// provider (required). For a BYOK vendor, an override of its API base —
    /// `None` in the app, where every adapter addresses its vendor itself.
    pub endpoint: Option<&'a str>,
    pub poll: PollPolicy,
    /// The vendor key, or the cloud session token in hosted mode.
    pub credential: &'a str,
    /// The (compressed) file being uploaded, and its bytes.
    pub upload_path: &'a str,
    pub audio: Vec<u8>,
    /// The caller's model choice; each adapter has its own batch default.
    pub model: Option<&'a str>,
    pub language_hints: &'a [String],
    pub diarization: bool,
    pub vocabulary: &'a [String],
    pub log: &'a dyn ResponseLog,
}

impl<'a> BatchRequest<'a> {
    /// The base URL to address: the override when set, else `default`.
    pub fn base_or(&self, default: &'a str) -> &'a str {
        self.endpoint.unwrap_or(default)
    }

    /// The upload's file name, or `fallback` when the path has none.
    pub fn file_name_or(&self, fallback: &str) -> String {
        std::path::Path::new(self.upload_path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| fallback.to_string())
    }
}

/// A provider's batch adapter (see [`BatchRequest`]).
pub type BatchFn =
    for<'a> fn(BatchRequest<'a>) -> BoxFuture<'a, Result<TranscriptionResult, String>>;

/// Read the file to upload.
pub async fn read_upload(path: &str) -> Result<Vec<u8>, String> {
    tokio::fs::read(path)
        .await
        .map_err(|e| format!("Failed to read file: {e}"))
}

/// A response's body text, or an error carrying the HTTP status and the body
/// when it is not a success.
async fn read_body(resp: reqwest::Response, ctx: &str) -> Result<String, String> {
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("{ctx}: failed to read response: {e}"))?;
    if !status.is_success() {
        log::error!("replay: {} http error status={}", ctx, status);
        return Err(format!("{ctx}: HTTP {status}: {text}"));
    }
    Ok(text)
}

fn parse_body<T: serde::de::DeserializeOwned>(text: &str, ctx: &str) -> Result<T, String> {
    serde_json::from_str(text).map_err(|e| format!("{ctx}: bad response JSON: {e} — {text}"))
}

/// Turn a reqwest Response into a deserialized body, surfacing the HTTP status +
/// body text on failure so callers get a useful error message.
pub async fn read_json<T: serde::de::DeserializeOwned>(
    resp: reqwest::Response,
    ctx: &str,
) -> Result<T, String> {
    let text = read_body(resp, ctx).await?;
    parse_body(&text, ctx)
}

/// Like [`read_json`], but also returns the RAW response body text alongside
/// the parsed struct, for a diagnostic log of exactly what the provider sent.
pub async fn read_json_with_raw<T: serde::de::DeserializeOwned>(
    resp: reqwest::Response,
    ctx: &str,
) -> Result<(String, T), String> {
    let text = read_body(resp, ctx).await?;
    let parsed = parse_body(&text, ctx)?;
    Ok((text, parsed))
}

/// One status check of a polled job.
pub enum JobState<T> {
    /// Still queued or processing (or a status we don't recognize).
    Pending,
    /// Settled; the value the adapter needs from the final status.
    Done(T),
    /// The provider failed the job; the adapter's error for it.
    Failed(String),
}

/// Poll a job with `check` until it settles, sleeping `policy.interval` before
/// every check and giving up after `policy.max_polls`. Returns the settled
/// value and how many checks it took, or `None` when the cap ran out (each
/// adapter words its own timeout). A check that errors, or a failed job, ends
/// the polling with that error.
pub async fn poll_job<T, F, Fut>(
    policy: PollPolicy,
    mut check: F,
) -> Result<Option<(T, u32)>, String>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<JobState<T>, String>>,
{
    for attempt in 1..=policy.max_polls {
        tokio::time::sleep(policy.interval).await;
        match check().await? {
            JobState::Pending => continue,
            JobState::Done(value) => return Ok(Some((value, attempt))),
            JobState::Failed(msg) => return Err(msg),
        }
    }
    Ok(None)
}

/// One token as the run grouper takes it — the common shape every token-based
/// batch response is mapped onto before grouping.
pub struct RunToken<'a> {
    pub text: &'a str,
    pub speaker: Option<i64>,
    pub start_ms: u64,
    pub end_ms: u64,
}

/// The speaker a token joins: its own, else the open run's (tokens without a
/// speaker — some punctuation/spacing tokens — stay in the CURRENT speaker's
/// run; snapping them to speaker 0 would close the run and fragment the
/// transcript into spurious extra speakers), else 0.
fn run_speaker(speaker: Option<i64>, cur_speaker: i64) -> i64 {
    match speaker {
        Some(s) => s,
        None if cur_speaker >= 0 => cur_speaker,
        None => 0,
    }
}

/// Group a flat token stream into speaker-runs. A change of speaker closes the
/// current run and starts a new one; whitespace is preserved as the provider
/// supplies it. Empty / whitespace-only runs are dropped.
pub fn group_runs<'a>(tokens: impl IntoIterator<Item = RunToken<'a>>) -> Vec<ReplaySegment> {
    let mut segments: Vec<ReplaySegment> = Vec::new();
    let mut seg_index: u64 = 0;

    let mut cur_speaker: i64 = -1;
    let mut cur_text = String::new();
    let mut cur_start: u64 = 0;
    let mut cur_end: u64 = 0;

    for tok in tokens {
        let spk = run_speaker(tok.speaker, cur_speaker);
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
        cur_text.push_str(tok.text);
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

/// A speaker-tagged word with millisecond timings — the common currency for the
/// word-stream providers (Deepgram). Grouped into speaker-runs by [`group_words`].
pub struct BatchWord {
    pub speaker: Option<i64>,
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

/// Group a flat word stream into speaker-runs, joining words with single spaces
/// (mirrors [`group_runs`], but for providers that return separate words rather
/// than already-spaced tokens). A speaker change closes the current run; a word
/// with no speaker stays in the current run.
pub fn group_words(words: &[BatchWord]) -> Vec<ReplaySegment> {
    let mut segments: Vec<ReplaySegment> = Vec::new();
    let mut seg_index: u64 = 0;
    let mut cur_speaker: i64 = -1;
    let mut cur_text = String::new();
    let mut cur_start: u64 = 0;
    let mut cur_end: u64 = 0;

    for w in words {
        let spk = run_speaker(w.speaker, cur_speaker);
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

/// The latest segment end, or 0 without segments.
pub fn last_end(segments: &[ReplaySegment]) -> u64 {
    segments.iter().map(|s| s.end_ms).max().unwrap_or(0)
}

/// Best-effort audio MIME from the file extension, for providers that want a
/// Content-Type on a raw upload (Deepgram) or inline data (Gemini). We compress to
/// Ogg/Opus before upload, so `.ogg`/`.opus` is the common case.
pub fn guess_audio_mime(path: &str) -> &'static str {
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

#[cfg(test)]
#[path = "batch_tests.rs"]
mod tests;
