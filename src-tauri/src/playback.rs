//! Playback fallback for a recording the webview cannot play.
//!
//! Replay plays `audio.ogg` straight from disk through the asset protocol, and
//! the webview decodes the Ogg/Opus itself. When it can't — an older WebKit
//! without Ogg/Opus, a container the webview doesn't know (an upload whose
//! compression failed is kept as a raw copy) — the play button used to do
//! nothing at all. The frontend now catches the media error and asks for this
//! instead: the same file decoded in Rust (libopus / symphonia, see
//! `replay_audio`) to a plain 16 kHz mono PCM WAV, which every webview plays.
//!
//! The WAVs are a cache under `<app_cache_dir>/playback/`, keyed by the source
//! file's path, size and mtime (a trim rewrites the file, which changes the
//! key), pruned to the few most recent — a long meeting is ~115 MB an hour as
//! WAV — and cleared by "All Caches" (cache.rs).
//!
//! Decodes of the same output are serialized (A → B → A can ask twice while the
//! first is still running): the second caller waits and reuses the first one's
//! WAV instead of decoding into the same file alongside it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, PoisonError, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::cache::PLAYBACK_DIR;

/// Decoded fallbacks kept on disk. One is the recording on screen; a couple
/// more make flipping between recent recordings free.
const KEEP_FILES: usize = 3;

/// A `.part` this old is a leftover from a crashed decode. A younger one may be
/// a decode still writing (each has its own name), so prune leaves it alone.
const STALE_PART_AGE: Duration = Duration::from_secs(10 * 60);

/// Decode `audio_path` to a playable WAV in the playback cache and return its
/// path (reused when the cached copy is still current). `async` +
/// `spawn_blocking`: decoding an hour of audio is seconds of CPU, which must not
/// stall the main thread every window shares.
#[tauri::command]
pub async fn prepare_playback_fallback(
    app: AppHandle,
    audio_path: String,
) -> Result<String, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join(PLAYBACK_DIR);
    tauri::async_runtime::spawn_blocking(move || prepare(&dir, Path::new(&audio_path)))
        .await
        .map_err(|e| format!("playback fallback task panicked: {e}"))?
}

/// One lock per output WAV, held for the check-then-decode below. Entries are
/// weak, so a path nobody is decoding costs nothing once its guard drops.
fn output_lock(out: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if let Some(lock) = locks.get(out).and_then(Weak::upgrade) {
        return lock;
    }
    locks.retain(|_, lock| lock.strong_count() > 0);
    let lock = Arc::new(Mutex::new(()));
    locks.insert(out.to_path_buf(), Arc::downgrade(&lock));
    lock
}

/// The file side of [`prepare_playback_fallback`]. Synchronous.
fn prepare(dir: &Path, src: &Path) -> Result<String, String> {
    let out = cached_wav_path(dir, src)?;
    // A concurrent decode of the same output finishes first; this then finds
    // its WAV below and reuses it.
    let lock = output_lock(&out);
    let _decoding = lock.lock().unwrap_or_else(PoisonError::into_inner);
    if out.is_file() {
        log::info!("playback: reusing decoded fallback {}", out.display());
        return Ok(out.to_string_lossy().into_owned());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let started = Instant::now();
    crate::replay_audio::transcode_to_wav_16k_mono(src, &out).map_err(|e| {
        log::error!("playback: decoding {} failed: {e:#}", src.display());
        format!("could not decode the audio: {e:#}")
    })?;
    log::info!(
        "playback: decoded {} to WAV in {} ms",
        src.display(),
        started.elapsed().as_millis()
    );
    prune(dir, &out);
    Ok(out.to_string_lossy().into_owned())
}

/// `<dir>/<hash>.wav`, where the hash covers the source's path, size and
/// modification time — so a re-encoded (trimmed) recording gets a fresh decode.
fn cached_wav_path(dir: &Path, src: &Path) -> Result<PathBuf, String> {
    let meta = std::fs::metadata(src).map_err(|e| format!("audio file is not readable: {e}"))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    let mut hasher = Sha256::new();
    hasher.update(src.to_string_lossy().as_bytes());
    hasher.update(meta.len().to_le_bytes());
    hasher.update(mtime.to_le_bytes());
    let digest = hasher.finalize();
    let name: String = digest.iter().take(16).map(|b| format!("{b:02x}")).collect();
    Ok(dir.join(format!("{name}.wav")))
}

/// Keep the [`KEEP_FILES`] most recently written WAVs (always including
/// `keep`); delete the rest, plus any `.part` a crashed decode left behind
/// (older than [`STALE_PART_AGE`] — a newer one may still be being written).
fn prune(dir: &Path, keep: &Path) {
    prune_at(dir, keep, SystemTime::now());
}

/// [`prune`] as of `now` (injected in tests).
fn prune_at(dir: &Path, keep: &Path, now: SystemTime) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut wavs: Vec<(SystemTime, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path == keep {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default();
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(UNIX_EPOCH);
        if ext == "part" {
            let age = now.duration_since(modified).unwrap_or_default();
            if age >= STALE_PART_AGE {
                let _ = std::fs::remove_file(&path);
            }
        } else if ext == "wav" {
            wavs.push((modified, path));
        }
    }
    wavs.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    for (_, path) in wavs.into_iter().skip(KEEP_FILES - 1) {
        match std::fs::remove_file(&path) {
            Ok(()) => log::info!("playback: pruned {}", path.display()),
            Err(e) => log::warn!("playback: prune {} failed: {e}", path.display()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("parley-playback-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn cache_key_follows_the_source_file() {
        let dir = temp_dir();
        let src = dir.join("audio.ogg");
        std::fs::write(&src, b"one").unwrap();
        let first = cached_wav_path(&dir, &src).unwrap();
        assert_eq!(
            first,
            cached_wav_path(&dir, &src).unwrap(),
            "stable for the same file"
        );
        std::fs::write(&src, b"longer content").unwrap();
        assert_ne!(
            first,
            cached_wav_path(&dir, &src).unwrap(),
            "a rewritten file decodes afresh"
        );
        assert!(cached_wav_path(&dir, &dir.join("missing.ogg")).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn prune_keeps_the_newest_few_and_the_current_one() {
        let dir = temp_dir();
        for i in 0..5 {
            std::fs::write(dir.join(format!("{i}.wav")), b"x").unwrap();
            // Distinct mtimes so "newest" is well defined.
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
        std::fs::write(dir.join("stale.wav.part"), b"x").unwrap();
        let keep = dir.join("0.wav"); // the oldest, but it is the one just decoded
                                      // As of well after every file was written: the .part is a leftover.
        prune_at(&dir, &keep, SystemTime::now() + STALE_PART_AGE);
        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, vec!["0.wav", "3.wav", "4.wav"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn prune_leaves_a_part_file_that_may_still_be_written() {
        let dir = temp_dir();
        let keep = dir.join("current.wav");
        std::fs::write(&keep, b"x").unwrap();
        std::fs::write(dir.join("other.wav.0123.part"), b"x").unwrap();
        prune(&dir, &keep);
        assert!(
            dir.join("other.wav.0123.part").exists(),
            "a concurrent decode's .part survives"
        );
        prune_at(&dir, &keep, SystemTime::now() + STALE_PART_AGE);
        assert!(!dir.join("other.wav.0123.part").exists(), "an old one goes");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn concurrent_decodes_of_one_output_share_a_lock() {
        let out = temp_dir().join("same.wav");
        let a = output_lock(&out);
        let b = output_lock(&out);
        assert!(Arc::ptr_eq(&a, &b), "same output, same lock");
        let other = output_lock(&out.with_file_name("other.wav"));
        assert!(
            !Arc::ptr_eq(&a, &other),
            "different outputs don't wait on each other"
        );
    }

    /// Two requests for the same recording at once (A → B → A while A still
    /// decodes): one decode, and both get the same playable WAV.
    #[test]
    fn a_second_request_reuses_the_first_decode() {
        let dir = temp_dir();
        let src = dir.join("audio.wav");
        let pcm: Vec<f32> = (0..16_000).map(|i| (i as f32 * 0.05).sin() * 0.5).collect();
        crate::replay_audio::write_wav_16k_mono(&pcm, &src).unwrap();
        let cache = dir.join("playback");
        let results: Vec<String> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..2)
                .map(|_| scope.spawn(|| prepare(&cache, &src).expect("prepare")))
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert_eq!(results[0], results[1]);
        assert!(Path::new(&results[0]).is_file());
        let names: Vec<String> = std::fs::read_dir(&cache)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), 1, "one WAV and no leftover .part: {names:?}");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
