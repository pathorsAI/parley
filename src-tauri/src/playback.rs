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

use std::path::{Path, PathBuf};
use std::time::{Instant, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::cache::PLAYBACK_DIR;

/// Decoded fallbacks kept on disk. One is the recording on screen; a couple
/// more make flipping between recent recordings free.
const KEEP_FILES: usize = 3;

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

/// The file side of [`prepare_playback_fallback`]. Synchronous.
fn prepare(dir: &Path, src: &Path) -> Result<String, String> {
    let out = cached_wav_path(dir, src)?;
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
/// `keep`); delete the rest, plus any `.part` a crashed decode left behind.
fn prune(dir: &Path, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut wavs: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path == keep {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default();
        if ext == "part" {
            let _ = std::fs::remove_file(&path);
        } else if ext == "wav" {
            let modified = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(UNIX_EPOCH);
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
        prune(&dir, &keep);
        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, vec!["0.wav", "3.wav", "4.wav"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
