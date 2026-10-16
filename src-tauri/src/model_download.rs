//! Verified model downloads and where models live, shared by every on-device
//! model the app fetches: the local STT provider's whisper models
//! (`local_stt`) and the speaker-diarization model (`diarize`).
//!
//! A download streams to `<file>.part` while hashing, stops on cancel or as
//! soon as it outgrows the expected size, checks the byte count and SHA-256,
//! then renames into place — so a half-written model never sits under its
//! final name. The HTTP client, the destination and the progress callback are
//! all passed in, which is what keeps it testable against a local server.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

/// `app_data_dir()/models/` — deliberately NOT the app cache dir, whose
/// "Clear all" must never delete a downloaded model.
pub fn models_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app data dir: {e}"))?
        .join("models"))
}

/// The in-progress download next to the final file: `<file>.part`.
pub fn part_path(final_path: &Path) -> PathBuf {
    let mut name = final_path.as_os_str().to_owned();
    name.push(".part");
    PathBuf::from(name)
}

/// The client model downloads use: a dial that never answers and a stalled
/// transfer both fail instead of hanging the progress bar forever.
pub fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("http client: {e}"))
}

/// Stage of a download, as reported to the progress callback (and sent as-is
/// in `local-stt://progress`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    Downloading,
    Verifying,
    Done,
    Error,
    Cancelled,
}

/// Rate-limits progress events: one per [`Throttle::INTERVAL`] or per percent of
/// progress, whichever comes first — a gigabyte arrives in tens of thousands of
/// chunks, and an event per chunk would flood the webview.
pub struct Throttle {
    last_at: Option<Instant>,
    last_received: u64,
}

impl Throttle {
    const INTERVAL: Duration = Duration::from_millis(100);

    pub fn new() -> Self {
        Self {
            last_at: None,
            last_received: 0,
        }
    }

    pub fn should_emit(&mut self, now: Instant, received: u64, total: u64) -> bool {
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
pub enum DownloadError {
    Cancelled,
    Failed(String),
}

/// Stream `url` into `dest` via `<dest>.part`: hash while writing, check the
/// byte count and SHA-256, then rename into place. The `.part` file is removed
/// on every failure and on cancel, so a half-written model never sits under its
/// final name. `progress(stage, received)` reports the downloading and
/// verifying stages.
pub async fn download_verified(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    expected_bytes: u64,
    expected_sha256: &str,
    cancel: &AtomicBool,
    mut progress: impl FnMut(Stage, u64),
) -> Result<(), DownloadError> {
    let part = part_path(dest);
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| DownloadError::Failed(format!("request failed: {e}")))?;
    let resp = resp
        .error_for_status()
        .map_err(|e| DownloadError::Failed(format!("download failed: {e}")))?;
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| DownloadError::Failed(format!("create models dir: {e}")))?;
    }
    let file = std::fs::File::create(&part)
        .map_err(|e| DownloadError::Failed(format!("create temp file: {e}")))?;
    let file = std::io::BufWriter::with_capacity(1 << 20, file);
    // `write_part` has closed the file by the time it returns, so a failure
    // can remove it right away.
    let written = write_part(resp, file, expected_bytes, cancel, &mut progress)
        .await
        .and_then(|(received, sha256)| {
            check_download(received, &sha256, expected_bytes, expected_sha256)
        });
    if let Err(e) = written {
        let _ = std::fs::remove_file(&part);
        return Err(e);
    }
    std::fs::rename(&part, dest).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        DownloadError::Failed(format!("finalize model file: {e}"))
    })
}

/// `download_verified`'s streaming half: write the body into `file` while
/// hashing it, stop on cancel, on a stream or write error, or as soon as it
/// grows past `expected_bytes`, then flush it to disk. Returns the byte count
/// and the lowercase hex SHA-256 of what was written.
async fn write_part(
    resp: reqwest::Response,
    mut file: std::io::BufWriter<std::fs::File>,
    expected_bytes: u64,
    cancel: &AtomicBool,
    progress: &mut impl FnMut(Stage, u64),
) -> Result<(u64, String), DownloadError> {
    use futures_util::StreamExt;

    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut stream = resp.bytes_stream();
    progress(Stage::Downloading, 0);
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            return Err(DownloadError::Cancelled);
        }
        let chunk =
            chunk.map_err(|e| DownloadError::Failed(format!("download interrupted: {e}")))?;
        received += chunk.len() as u64;
        if received > expected_bytes {
            return Err(DownloadError::Failed(format!(
                "download is larger than expected ({expected_bytes} bytes)"
            )));
        }
        file.write_all(&chunk)
            .map_err(|e| DownloadError::Failed(format!("write failed: {e}")))?;
        hasher.update(&chunk);
        progress(Stage::Downloading, received);
    }
    if cancel.load(Ordering::SeqCst) {
        return Err(DownloadError::Cancelled);
    }
    progress(Stage::Verifying, received);
    file.into_inner()
        .map_err(|e| e.into_error())
        .and_then(|f| f.sync_all())
        .map_err(|e| DownloadError::Failed(format!("write failed: {e}")))?;
    Ok((received, to_hex(&hasher.finalize())))
}

/// `download_verified`'s verdict on a finished download: the full size and
/// the expected checksum.
fn check_download(
    received: u64,
    sha256: &str,
    expected_bytes: u64,
    expected_sha256: &str,
) -> Result<(), DownloadError> {
    if received != expected_bytes {
        return Err(DownloadError::Failed(format!(
            "download ended early ({received} of {expected_bytes} bytes)"
        )));
    }
    if !sha256.eq_ignore_ascii_case(expected_sha256) {
        return Err(DownloadError::Failed(format!(
            "checksum mismatch (expected {expected_sha256}, got {sha256})"
        )));
    }
    Ok(())
}

/// Lowercase hex of `bytes` (a SHA-256 digest, a cache key).
pub fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "parley-model-download-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_part_file_sits_next_to_the_model() {
        let p = part_path(Path::new("/x/models/stt/ggml-small-q5_1.bin"));
        assert_eq!(p, PathBuf::from("/x/models/stt/ggml-small-q5_1.bin.part"));
        let p = part_path(Path::new("/x/models/campplus_zh_en_16k.onnx"));
        assert_eq!(p, PathBuf::from("/x/models/campplus_zh_en_16k.onnx.part"));
    }

    #[test]
    fn hex_is_lowercase_and_zero_padded() {
        assert_eq!(to_hex(&[0x00, 0x0f, 0xa0, 0xff]), "000fa0ff");
        assert_eq!(to_hex(&[]), "");
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
}
