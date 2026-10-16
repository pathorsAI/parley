//! On-device speech recognition models for the "local" STT provider.
//!
//! The provider runs whisper.cpp (via `whisper-rs`) entirely on this machine,
//! so the only network traffic is the one-time model download handled here.
//! This module owns:
//! - the model catalog ([`CATALOG`]): one row per downloadable GGML model;
//! - where models live (`app_data_dir()/models/stt/` — deliberately NOT the app
//!   cache dir, whose "Clear all" must never delete a gigabyte of model);
//! - the download flow (stream to `<file>.part`, verify size + SHA-256, then an
//!   atomic rename), its progress events and cancellation;
//! - the loaded-model cache shared by every session (meeting mic + system audio,
//!   voice typing, file transcription), and the leases that keep a model from
//!   being deleted while a session uses it.
//!
//! The recognizer itself lives in `transcription/local.rs`.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use whisper_rs::{WhisperContext, WhisperContextParameters};

/// Event the Settings UI listens on for download progress.
pub const PROGRESS_EVENT: &str = "local-stt://progress";

/// The model used when a caller does not name one.
pub const DEFAULT_MODEL_ID: &str = "whisper-large-v3-turbo-q5_0";

/// Which model family a catalog entry belongs to. Drives prompting: Breeze is
/// a Taiwanese-Mandarin fine-tune and is always steered toward Traditional
/// Chinese output (see `transcription/local.rs`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelFamily {
    Whisper,
    Breeze,
}

/// One downloadable model. `sha256` is the Hugging Face LFS oid, which is the
/// SHA-256 of the file itself.
#[derive(Debug)]
pub struct CatalogEntry {
    pub id: &'static str,
    pub family: ModelFamily,
    /// Hugging Face repository (`owner/name`).
    pub repo: &'static str,
    /// File name inside the repository, also the name on disk.
    pub file: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
}

impl CatalogEntry {
    pub fn url(&self) -> String {
        format!(
            "https://huggingface.co/{}/resolve/main/{}",
            self.repo, self.file
        )
    }
}

/// Every model the app offers. Adding a model is one row here (plus its
/// display strings in the frontend).
pub const CATALOG: &[CatalogEntry] = &[
    CatalogEntry {
        id: "whisper-small-q5_1",
        family: ModelFamily::Whisper,
        repo: "ggerganov/whisper.cpp",
        file: "ggml-small-q5_1.bin",
        bytes: 190_085_487,
        sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
    },
    CatalogEntry {
        id: "whisper-large-v3-turbo-q5_0",
        family: ModelFamily::Whisper,
        repo: "ggerganov/whisper.cpp",
        file: "ggml-large-v3-turbo-q5_0.bin",
        bytes: 574_041_195,
        sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    },
    CatalogEntry {
        id: "whisper-large-v3-turbo-q8_0",
        family: ModelFamily::Whisper,
        repo: "ggerganov/whisper.cpp",
        file: "ggml-large-v3-turbo-q8_0.bin",
        bytes: 874_188_075,
        sha256: "317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1",
    },
    CatalogEntry {
        id: "breeze-asr-25-q5_0",
        family: ModelFamily::Breeze,
        repo: "shdennlin/breeze-asr-25-ggml",
        file: "ggml-breeze-asr-25-q5_0.bin",
        bytes: 1_080_732_091,
        sha256: "f51573bd6ef9b1fac0bd09a1652eda58a1a638d824a08771ccdee1102fe5990a",
    },
];

/// Look a model up by id.
pub fn entry(id: &str) -> Option<&'static CatalogEntry> {
    CATALOG.iter().find(|e| e.id == id)
}

/// The id a session should use: the caller's, or [`DEFAULT_MODEL_ID`].
pub fn resolve_model_id(model: &str) -> &str {
    let model = model.trim();
    if model.is_empty() {
        DEFAULT_MODEL_ID
    } else {
        model
    }
}

/// The error a session or command returns for a model that is not on disk.
/// Starts with "Local transcription" so the session error classifier treats it
/// as final rather than as a dropped connection to redial.
pub fn not_downloaded_error(id: &str) -> String {
    format!(
        "Local transcription model '{id}' is not downloaded. Download it in Settings › Transcription."
    )
}

fn unknown_model_error(id: &str) -> String {
    format!("Local transcription model '{id}' is unknown.")
}

// --- Paths --------------------------------------------------------------------

/// `app_data_dir()/models/stt/`.
pub fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app data dir: {e}"))?
        .join("models")
        .join("stt"))
}

/// The in-progress download next to the final file: `<file>.part`.
fn part_path(final_path: &Path) -> PathBuf {
    let mut name = final_path.as_os_str().to_owned();
    name.push(".part");
    PathBuf::from(name)
}

/// Whether `entry` is installed in `dir`: the final file exists with exactly the
/// expected size. The hash was verified before the file got its final name, so
/// it is not re-hashed here (this runs on every Settings render).
fn is_installed_in(dir: &Path, entry: &CatalogEntry) -> bool {
    std::fs::metadata(dir.join(entry.file)).is_ok_and(|m| m.is_file() && m.len() == entry.bytes)
}

/// The on-disk path of an installed model, or the error a session should fail
/// with (unknown id, or not downloaded).
pub fn installed_model_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    let entry = entry(id).ok_or_else(|| unknown_model_error(id))?;
    let dir = models_dir(app)?;
    if !is_installed_in(&dir, entry) {
        return Err(not_downloaded_error(id));
    }
    Ok(dir.join(entry.file))
}

/// Fail-fast check for the start commands: `Ok` only when the model is ready.
pub fn ensure_installed(app: &AppHandle, model: &str) -> Result<(), String> {
    installed_model_path(app, resolve_model_id(model)).map(|_| ())
}

// --- Loaded-model cache and leases --------------------------------------------

/// The one loaded model, keyed by id. Loading a different model replaces it, so
/// at most one model's weights are resident (the old one is freed once the last
/// session holding its `Arc` ends).
type LoadedSlot = Mutex<Option<(String, Arc<WhisperContext>)>>;

fn loaded() -> &'static LoadedSlot {
    static LOADED: OnceLock<LoadedSlot> = OnceLock::new();
    LOADED.get_or_init(|| Mutex::new(None))
}

/// Serializes model loads, so the mic and system-audio sessions of one meeting
/// starting together load the model once rather than twice.
fn load_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// How many sessions currently use each model id.
fn leases() -> &'static Mutex<HashMap<String, usize>> {
    static LEASES: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();
    LEASES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Marks a model as in use for as long as it lives; [`local_stt_delete`]
/// refuses to delete a leased model.
pub struct ModelLease {
    id: String,
}

impl ModelLease {
    pub fn new(id: &str) -> Self {
        *leases().lock().unwrap().entry(id.to_string()).or_insert(0) += 1;
        Self { id: id.to_string() }
    }
}

impl Drop for ModelLease {
    fn drop(&mut self) {
        let mut leases = leases().lock().unwrap();
        if let Some(n) = leases.get_mut(&self.id) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                leases.remove(&self.id);
            }
        }
    }
}

fn is_leased(id: &str) -> bool {
    leases().lock().unwrap().get(id).is_some_and(|n| *n > 0)
}

/// Threads whisper.cpp uses for its CPU work.
pub fn thread_count() -> i32 {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(8) as i32
}

/// The shared context for model `id`, loading it on first use. Blocking (a
/// large model takes seconds to load): call it from `spawn_blocking`.
pub fn load_context(app: &AppHandle, id: &str) -> Result<Arc<WhisperContext>, String> {
    let _serial = load_lock().lock().unwrap_or_else(|e| e.into_inner());
    if let Some((loaded_id, ctx)) = loaded().lock().unwrap().as_ref() {
        if loaded_id == id {
            return Ok(ctx.clone());
        }
    }
    let path = installed_model_path(app, id)?;
    // Drop the previous model before loading the next one, so two large models
    // are never resident at once on behalf of the cache.
    *loaded().lock().unwrap() = None;

    whisper_rs::install_logging_hooks();
    let mut params = WhisperContextParameters::default();
    // Metal on macOS (the `metal` feature is only enabled there); CPU elsewhere.
    params.use_gpu(cfg!(target_os = "macos"));
    params.flash_attn(cfg!(target_os = "macos"));
    let started = Instant::now();
    let path_str = path
        .to_str()
        .ok_or_else(|| "Local transcription model path is not valid UTF-8".to_string())?;
    let ctx = WhisperContext::new_with_params(path_str, params)
        .map_err(|e| format!("Local transcription model '{id}' failed to load: {e}"))?;
    log::info!(
        "local-stt: loaded {id} in {}ms",
        started.elapsed().as_millis()
    );
    let ctx = Arc::new(ctx);
    *loaded().lock().unwrap() = Some((id.to_string(), ctx.clone()));
    Ok(ctx)
}

/// Drop the cached context if it is model `id` (sessions still holding it keep
/// their `Arc` until they end).
fn unload(id: &str) {
    let mut slot = loaded().lock().unwrap();
    if slot.as_ref().is_some_and(|(loaded_id, _)| loaded_id == id) {
        *slot = None;
    }
}

// --- Downloads ------------------------------------------------------------------

/// Cancel flags of the downloads in flight, by model id. Presence = in flight.
fn downloads() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static DOWNLOADS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    DOWNLOADS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn is_downloading(id: &str) -> bool {
    downloads().lock().unwrap().contains_key(id)
}

/// Removes a download's registry entry however its task ends.
struct DownloadSlot {
    id: String,
}

impl Drop for DownloadSlot {
    fn drop(&mut self) {
        downloads().lock().unwrap().remove(&self.id);
    }
}

/// Stage of a download, as sent in [`Progress::stage`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    Downloading,
    Verifying,
    Done,
    Error,
    Cancelled,
}

/// `local-stt://progress` payload.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    model_id: String,
    stage: Stage,
    received: u64,
    total: u64,
    message: Option<String>,
}

/// Rate-limits progress events: one per [`Throttle::INTERVAL`] or per percent of
/// progress, whichever comes first — a gigabyte arrives in tens of thousands of
/// chunks, and an event per chunk would flood the webview.
struct Throttle {
    last_at: Option<Instant>,
    last_received: u64,
}

impl Throttle {
    const INTERVAL: Duration = Duration::from_millis(100);

    fn new() -> Self {
        Self {
            last_at: None,
            last_received: 0,
        }
    }

    fn should_emit(&mut self, now: Instant, received: u64, total: u64) -> bool {
        let step = (total / 100).max(1);
        let due = match self.last_at {
            None => true,
            Some(at) => {
                now.duration_since(at) >= Self::INTERVAL
                    || received.saturating_sub(self.last_received) >= step
            }
        };
        if due {
            self.last_at = Some(now);
            self.last_received = received;
        }
        due
    }
}

/// Why a download did not produce a verified file.
#[derive(Debug, PartialEq, Eq)]
enum DownloadError {
    Cancelled,
    Failed(String),
}

/// Stream `url` into `dest` via `<dest>.part`: hash while writing, check the
/// byte count and SHA-256, then rename into place. The `.part` file is removed
/// on every failure and on cancel, so a half-written model never sits under its
/// final name. `progress(stage, received)` reports the downloading and
/// verifying stages.
async fn download_verified(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    expected_bytes: u64,
    expected_sha256: &str,
    cancel: &AtomicBool,
    mut progress: impl FnMut(Stage, u64),
) -> Result<(), DownloadError> {
    use futures_util::StreamExt;

    let part = part_path(dest);
    let fail = |part: &Path, e: DownloadError| {
        let _ = std::fs::remove_file(part);
        Err(e)
    };
    let resp = match client.get(url).send().await {
        Ok(r) => r,
        Err(e) => return Err(DownloadError::Failed(format!("request failed: {e}"))),
    };
    let resp = match resp.error_for_status() {
        Ok(r) => r,
        Err(e) => return Err(DownloadError::Failed(format!("download failed: {e}"))),
    };
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| DownloadError::Failed(format!("create models dir: {e}")))?;
    }
    let mut file = match std::fs::File::create(&part) {
        Ok(f) => std::io::BufWriter::with_capacity(1 << 20, f),
        Err(e) => return Err(DownloadError::Failed(format!("create temp file: {e}"))),
    };
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut stream = resp.bytes_stream();
    progress(Stage::Downloading, 0);
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            drop(file);
            return fail(&part, DownloadError::Cancelled);
        }
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                drop(file);
                return fail(
                    &part,
                    DownloadError::Failed(format!("download interrupted: {e}")),
                );
            }
        };
        received += chunk.len() as u64;
        if received > expected_bytes {
            drop(file);
            return fail(
                &part,
                DownloadError::Failed(format!(
                    "download is larger than expected ({expected_bytes} bytes)"
                )),
            );
        }
        if let Err(e) = file.write_all(&chunk) {
            drop(file);
            return fail(&part, DownloadError::Failed(format!("write failed: {e}")));
        }
        hasher.update(&chunk);
        progress(Stage::Downloading, received);
    }
    if cancel.load(Ordering::SeqCst) {
        drop(file);
        return fail(&part, DownloadError::Cancelled);
    }
    progress(Stage::Verifying, received);
    let flushed = file
        .into_inner()
        .map_err(|e| e.into_error())
        .and_then(|f| f.sync_all());
    if let Err(e) = flushed {
        return fail(&part, DownloadError::Failed(format!("write failed: {e}")));
    }
    if received != expected_bytes {
        return fail(
            &part,
            DownloadError::Failed(format!(
                "download ended early ({received} of {expected_bytes} bytes)"
            )),
        );
    }
    let got = to_hex(&hasher.finalize());
    if !got.eq_ignore_ascii_case(expected_sha256) {
        return fail(
            &part,
            DownloadError::Failed(format!(
                "checksum mismatch (expected {expected_sha256}, got {got})"
            )),
        );
    }
    std::fs::rename(&part, dest).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        DownloadError::Failed(format!("finalize model file: {e}"))
    })
}

fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

// --- Commands -----------------------------------------------------------------

/// A catalog entry as the Settings UI sees it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSttModel {
    id: &'static str,
    family: ModelFamily,
    size_bytes: u64,
    /// The verified file is on disk (exact size; see [`is_installed_in`]).
    installed: bool,
    downloading: bool,
}

#[tauri::command]
pub fn local_stt_models(app: AppHandle) -> Result<Vec<LocalSttModel>, String> {
    let dir = models_dir(&app)?;
    Ok(CATALOG
        .iter()
        .map(|e| LocalSttModel {
            id: e.id,
            family: e.family,
            size_bytes: e.bytes,
            installed: is_installed_in(&dir, e),
            downloading: is_downloading(e.id),
        })
        .collect())
}

/// Download, verify and install a model. Resolves once the verified file is in
/// place (immediately when it already is). Emits `local-stt://progress`
/// throughout; a cancel ([`local_stt_cancel`]) ends it with stage `cancelled`
/// and an `Err("cancelled")`.
#[tauri::command]
pub async fn local_stt_download(app: AppHandle, model_id: String) -> Result<(), String> {
    let entry = entry(&model_id).ok_or_else(|| unknown_model_error(&model_id))?;
    let dir = models_dir(&app)?;
    let emit = |stage: Stage, received: u64, message: Option<String>| {
        let _ = app.emit(
            PROGRESS_EVENT,
            Progress {
                model_id: entry.id.to_string(),
                stage,
                received,
                total: entry.bytes,
                message,
            },
        );
    };
    if is_installed_in(&dir, entry) {
        emit(Stage::Done, entry.bytes, None);
        return Ok(());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut inflight = downloads().lock().unwrap();
        if inflight.contains_key(entry.id) {
            return Err(format!(
                "Local transcription model '{}' is already downloading.",
                entry.id
            ));
        }
        inflight.insert(entry.id.to_string(), cancel.clone());
    }
    let _slot = DownloadSlot {
        id: entry.id.to_string(),
    };

    log::info!(
        "local-stt: downloading {} ({} bytes)",
        entry.id,
        entry.bytes
    );
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        // A stalled transfer fails instead of hanging the progress bar forever.
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let mut throttle = Throttle::new();
    let result = download_verified(
        &client,
        &entry.url(),
        &dir.join(entry.file),
        entry.bytes,
        entry.sha256,
        &cancel,
        |stage, received| {
            if stage != Stage::Downloading
                || throttle.should_emit(Instant::now(), received, entry.bytes)
            {
                emit(stage, received, None);
            }
        },
    )
    .await;
    // Out of the registry before the terminal event: the UI re-reads
    // `local_stt_models` on it and must see `downloading: false`.
    drop(_slot);
    match result {
        Ok(()) => {
            log::info!("local-stt: {} installed", entry.id);
            emit(Stage::Done, entry.bytes, None);
            Ok(())
        }
        Err(DownloadError::Cancelled) => {
            log::info!("local-stt: {} download cancelled", entry.id);
            emit(Stage::Cancelled, 0, None);
            Err("cancelled".to_string())
        }
        Err(DownloadError::Failed(msg)) => {
            log::warn!("local-stt: {} download failed: {msg}", entry.id);
            emit(Stage::Error, 0, Some(msg.clone()));
            Err(format!("Downloading '{}' failed: {msg}", entry.id))
        }
    }
}

/// Cancel an in-flight download (no-op when none). The download task deletes
/// its `.part` file and emits stage `cancelled`.
#[tauri::command]
pub fn local_stt_cancel(model_id: String) {
    if let Some(flag) = downloads().lock().unwrap().get(&model_id) {
        flag.store(true, Ordering::SeqCst);
    }
}

/// Delete an installed model (and any leftover `.part`). Refused while a
/// session is using the model; an in-flight download of it is cancelled.
#[tauri::command]
pub fn local_stt_delete(app: AppHandle, model_id: String) -> Result<(), String> {
    let entry = entry(&model_id).ok_or_else(|| unknown_model_error(&model_id))?;
    if is_leased(entry.id) {
        return Err(format!(
            "Local transcription model '{}' is in use. Stop the meeting or dictation first.",
            entry.id
        ));
    }
    local_stt_cancel(entry.id.to_string());
    unload(entry.id);
    let path = models_dir(&app)?.join(entry.file);
    let _ = std::fs::remove_file(part_path(&path));
    match std::fs::remove_file(&path) {
        Ok(()) => {
            log::info!("local-stt: deleted {}", entry.id);
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Deleting '{}' failed: {e}", entry.id)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_ids_are_unique() {
        for (i, a) in CATALOG.iter().enumerate() {
            for b in &CATALOG[i + 1..] {
                assert_ne!(a.id, b.id);
                assert_ne!(a.file, b.file, "two entries would share one file");
            }
        }
    }

    #[test]
    fn catalog_entries_are_well_formed() {
        for e in CATALOG {
            assert_eq!(e.sha256.len(), 64, "{}", e.id);
            assert!(
                e.sha256.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')),
                "{} sha256 must be lowercase hex",
                e.id
            );
            assert!(e.url().starts_with("https://huggingface.co/"), "{}", e.id);
            assert!(e.url().ends_with(e.file));
            assert!(e.file.ends_with(".bin"));
            assert!(e.bytes > 1_000_000);
        }
    }

    #[test]
    fn the_default_model_is_in_the_catalog() {
        assert!(entry(DEFAULT_MODEL_ID).is_some());
        assert_eq!(resolve_model_id(""), DEFAULT_MODEL_ID);
        assert_eq!(resolve_model_id("  "), DEFAULT_MODEL_ID);
        assert_eq!(resolve_model_id("breeze-asr-25-q5_0"), "breeze-asr-25-q5_0");
    }

    #[test]
    fn breeze_is_its_own_family() {
        assert_eq!(
            entry("breeze-asr-25-q5_0").unwrap().family,
            ModelFamily::Breeze
        );
        assert_eq!(
            serde_json::to_value(ModelFamily::Breeze).unwrap(),
            serde_json::json!("breeze")
        );
    }

    #[test]
    fn the_part_file_sits_next_to_the_model() {
        let p = part_path(Path::new("/x/models/stt/ggml-small-q5_1.bin"));
        assert_eq!(p, PathBuf::from("/x/models/stt/ggml-small-q5_1.bin.part"));
    }

    #[test]
    fn the_not_downloaded_error_classifies_as_local() {
        let msg = not_downloaded_error("whisper-small-q5_1");
        assert!(msg.starts_with("Local transcription"));
        assert!(msg.contains("whisper-small-q5_1"));
    }

    fn scratch_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("parley-local-stt-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn only_an_exact_size_file_counts_as_installed() {
        let dir = scratch_dir("installed");
        let e = CatalogEntry {
            id: "t",
            family: ModelFamily::Whisper,
            repo: "r/r",
            file: "m.bin",
            bytes: 4,
            sha256: "",
        };
        assert!(!is_installed_in(&dir, &e));
        // A leftover .part never reads as installed.
        std::fs::write(part_path(&dir.join("m.bin")), b"abcd").unwrap();
        assert!(!is_installed_in(&dir, &e));
        std::fs::write(dir.join("m.bin"), b"abc").unwrap();
        assert!(!is_installed_in(&dir, &e));
        std::fs::write(dir.join("m.bin"), b"abcd").unwrap();
        assert!(is_installed_in(&dir, &e));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_throttle_emits_per_interval_or_percent() {
        let mut t = Throttle::new();
        let t0 = Instant::now();
        assert!(t.should_emit(t0, 0, 10_000));
        // Same instant, under 1 %: suppressed.
        assert!(!t.should_emit(t0, 50, 10_000));
        // 1 % of progress: emitted even without time passing.
        assert!(t.should_emit(t0, 100, 10_000));
        // Time passing alone also emits.
        assert!(t.should_emit(t0 + Duration::from_millis(150), 101, 10_000));
        assert!(!t.should_emit(t0 + Duration::from_millis(160), 102, 10_000));
    }

    #[test]
    fn leases_count_sessions() {
        let id = "lease-test-model";
        assert!(!is_leased(id));
        let a = ModelLease::new(id);
        let b = ModelLease::new(id);
        drop(a);
        assert!(is_leased(id));
        drop(b);
        assert!(!is_leased(id));
    }

    /// Serve `body` from a throwaway local HTTP server; returns its URL.
    async fn serve(body: Vec<u8>) -> String {
        let app = axum::Router::new().route(
            "/model.bin",
            axum::routing::get(move || {
                let body = body.clone();
                async move { body }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{addr}/model.bin")
    }

    fn sha_hex(data: &[u8]) -> String {
        to_hex(&Sha256::digest(data))
    }

    #[tokio::test]
    async fn a_verified_download_lands_under_its_final_name() {
        let body: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        let url = serve(body.clone()).await;
        let dir = scratch_dir("ok");
        let dest = dir.join("m.bin");
        let mut stages = Vec::new();
        let r = download_verified(
            &reqwest::Client::new(),
            &url,
            &dest,
            body.len() as u64,
            &sha_hex(&body),
            &AtomicBool::new(false),
            |stage, _| stages.push(stage),
        )
        .await;
        assert_eq!(r, Ok(()));
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        assert!(!part_path(&dest).exists());
        assert_eq!(stages.first(), Some(&Stage::Downloading));
        assert_eq!(stages.last(), Some(&Stage::Verifying));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_checksum_mismatch_leaves_nothing_behind() {
        let body = vec![7u8; 10_000];
        let url = serve(body.clone()).await;
        let dir = scratch_dir("bad-sha");
        let dest = dir.join("m.bin");
        let r = download_verified(
            &reqwest::Client::new(),
            &url,
            &dest,
            body.len() as u64,
            &"0".repeat(64),
            &AtomicBool::new(false),
            |_, _| {},
        )
        .await;
        assert!(matches!(r, Err(DownloadError::Failed(m)) if m.contains("checksum")));
        assert!(!dest.exists());
        assert!(!part_path(&dest).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_short_download_is_rejected() {
        let body = vec![1u8; 1_000];
        let url = serve(body.clone()).await;
        let dir = scratch_dir("short");
        let dest = dir.join("m.bin");
        let r = download_verified(
            &reqwest::Client::new(),
            &url,
            &dest,
            2_000,
            &sha_hex(&body),
            &AtomicBool::new(false),
            |_, _| {},
        )
        .await;
        assert!(matches!(r, Err(DownloadError::Failed(m)) if m.contains("ended early")));
        assert!(!dest.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_cancelled_download_deletes_its_part_file() {
        let body = vec![3u8; 50_000];
        let url = serve(body.clone()).await;
        let dir = scratch_dir("cancel");
        let dest = dir.join("m.bin");
        let cancel = AtomicBool::new(false);
        let r = download_verified(
            &reqwest::Client::new(),
            &url,
            &dest,
            body.len() as u64,
            &sha_hex(&body),
            &cancel,
            |_, _| cancel.store(true, Ordering::SeqCst),
        )
        .await;
        assert_eq!(r, Err(DownloadError::Cancelled));
        assert!(!dest.exists());
        assert!(!part_path(&dest).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Real download of the smallest catalog model, skipped by default: run
    /// with PARLEY_LOCAL_STT_DIR set and `-- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn smoke_download_small_model() {
        let dir =
            PathBuf::from(std::env::var("PARLEY_LOCAL_STT_DIR").expect("PARLEY_LOCAL_STT_DIR"));
        let e = entry("whisper-small-q5_1").unwrap();
        let started = Instant::now();
        let mut throttle = Throttle::new();
        let mut events = 0u32;
        download_verified(
            &reqwest::Client::new(),
            &e.url(),
            &dir.join(e.file),
            e.bytes,
            e.sha256,
            &AtomicBool::new(false),
            |stage, received| {
                if stage != Stage::Downloading
                    || throttle.should_emit(Instant::now(), received, e.bytes)
                {
                    events += 1;
                }
            },
        )
        .await
        .unwrap();
        assert!(is_installed_in(&dir, e));
        println!(
            "downloaded in {} s, {events} progress events",
            started.elapsed().as_secs()
        );
    }
}
