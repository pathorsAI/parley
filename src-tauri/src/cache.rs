//! Clearing Parley's caches, shared by the native menu bar and Settings.
//!
//! The Diagnostics → Clear Cache submenu (menu.rs) used to be the only way to
//! do this, and Windows never draws that menu (the main window is
//! undecorated), so there the caches could not be cleared at all. Settings ›
//! MCP Server › Caches now calls [`clear_cache`], which runs exactly what the
//! menu runs — the menu calls [`clear`] too — so the two can never drift.
//!
//! Two kinds of cache live in two places:
//!
//! * On disk, under the OS app-cache dir: `transcriptions/` (STT results for
//!   uploaded files) and `diarizations/` (speaker clusters). Removed here.
//! * In the webview's localStorage: the analysis results and the saved speaker
//!   names (part of the diarization result). Rust cannot reach those, so they
//!   are cleared by the main window on `cache://clear-analysis` and
//!   `cache://clear-speakers` (see src/lib/analysis/engine.ts and
//!   src/lib/speakers/namesCache.ts).

use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// On-disk transcription cache (subdirectory of the app-cache dir).
pub const TRANSCRIPTIONS_DIR: &str = "transcriptions";
/// On-disk diarization cache (subdirectory of the app-cache dir).
pub const DIARIZATIONS_DIR: &str = "diarizations";

/// Which cache to clear.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CacheKind {
    Transcription,
    Diarization,
    Analysis,
    All,
}

/// Clear one cache (or all of them): remove the on-disk directories and emit
/// the events the frontend clears its localStorage caches on.
pub fn clear<R: Runtime>(app: &AppHandle<R>, kind: CacheKind) {
    let (transcription, diarization, analysis) = match kind {
        CacheKind::Transcription => (true, false, false),
        CacheKind::Diarization => (false, true, false),
        CacheKind::Analysis => (false, false, true),
        CacheKind::All => (true, true, true),
    };
    if transcription {
        clear_cache_dir(app, TRANSCRIPTIONS_DIR);
    }
    if diarization {
        clear_cache_dir(app, DIARIZATIONS_DIR);
        // The cluster cache is on disk; the speaker NAMES live in the webview's
        // localStorage, so clear those via an event too.
        let _ = app.emit("cache://clear-speakers", ());
    }
    if analysis {
        let _ = app.emit("cache://clear-analysis", ());
    }
}

/// Remove a subdirectory of the OS app-cache dir (recreated lazily on next write).
fn clear_cache_dir<R: Runtime>(app: &AppHandle<R>, name: &str) {
    if let Ok(cache) = app.path().app_cache_dir() {
        let dir = cache.join(name);
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => log::info!("cache: cleared {}", dir.display()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => log::warn!("cache: clear {} failed: {e}", dir.display()),
        }
    }
}

/// Settings' "Clear" buttons. Same effect as the menu items, minus the native
/// confirmation dialog — Settings reports the result itself.
#[tauri::command]
pub fn clear_cache<R: Runtime>(app: AppHandle<R>, kind: CacheKind) {
    log::info!("cache: clear {kind:?} requested from settings");
    clear(&app, kind);
}

/// Bytes on disk per cache directory, for the Settings list.
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CacheSizes {
    transcription: u64,
    diarization: u64,
}

/// Size of the on-disk caches. Both are flat directories of a few small JSON
/// files per recording, so walking them is cheap; `async` keeps even a large
/// one off the main thread.
#[tauri::command]
pub async fn cache_sizes<R: Runtime>(app: AppHandle<R>) -> Result<CacheSizes, String> {
    let root = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    Ok(CacheSizes {
        transcription: dir_size(&root.join(TRANSCRIPTIONS_DIR)),
        diarization: dir_size(&root.join(DIARIZATIONS_DIR)),
    })
}

/// Total size of the regular files under `dir`, recursively. A missing or
/// unreadable directory counts as empty — this feeds a display, not a decision.
fn dir_size(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| match entry.file_type() {
            Ok(t) if t.is_dir() => dir_size(&entry.path()),
            Ok(t) if t.is_file() => entry.metadata().map(|m| m.len()).unwrap_or(0),
            // Symlinks and anything else are not followed.
            _ => 0,
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dir_size_sums_nested_files_and_treats_missing_as_empty() {
        let root = std::env::temp_dir().join(format!("parley-cache-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("nested")).unwrap();
        std::fs::write(root.join("a.json"), [0u8; 10]).unwrap();
        std::fs::write(root.join("nested").join("b.json"), [0u8; 32]).unwrap();

        assert_eq!(dir_size(&root), 42);
        assert_eq!(dir_size(&root.join("does-not-exist")), 0);

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn cache_kind_deserializes_from_the_frontend_spelling() {
        let kinds: Vec<CacheKind> =
            serde_json::from_str(r#"["transcription","diarization","analysis","all"]"#).unwrap();
        assert_eq!(
            kinds,
            vec![
                CacheKind::Transcription,
                CacheKind::Diarization,
                CacheKind::Analysis,
                CacheKind::All
            ]
        );
    }
}
