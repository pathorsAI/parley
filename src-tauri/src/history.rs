//! Local history of finished meetings — recording + analysis, saved on disk so
//! the user can reopen any past session and replay it.
//!
//! Layout: `<app_data_dir>/history/<id>/` holds three files:
//!
//! - `meta.json` — the full `HistoryEntry` (segments, findings, action items,
//!   negotiation context). Written verbatim by the frontend so the schema lives
//!   in one place (TypeScript).
//! - `summary.json` — a lightweight card for the history grid, so listing never
//!   has to parse every full entry.
//! - `audio.ogg` — Ogg/Opus recording (live: encoded from the captured mix;
//!   upload: the source file compressed). Optional.
//!
//! The frontend owns the JSON shapes; Rust only does file I/O + audio placement.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Base directory for all history entries (`<app_data_dir>/history`). Also used
/// by the MCP server (mcp.rs) for its read-only recording tools.
pub(crate) fn history_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("history"))
}

/// Reduce an id to a single safe path component (it's a minted UUID, but guard
/// against separators/traversal regardless).
pub(crate) fn safe_id(id: &str) -> String {
    id.replace(['/', '\\', '.'], "-")
}

/// Move a file, falling back to copy+remove across filesystems (the temp dir and
/// the app-data dir are often different mounts, where `rename` fails with EXDEV).
fn move_file(src: &Path, dest: &Path) -> Result<(), String> {
    if std::fs::rename(src, dest).is_ok() {
        return Ok(());
    }
    std::fs::copy(src, dest).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(src);
    Ok(())
}

/// Result of `read_history_entry`: the raw `meta.json` plus the resolved absolute
/// path to the recording (if the file exists), which the frontend turns into an
/// `asset://` URL with `convertFileSrc`.
#[derive(Serialize)]
pub struct HistoryRead {
    meta: serde_json::Value,
    #[serde(rename = "audioPath")]
    audio_path: Option<String>,
}

/// Save (or overwrite) a history entry. `meta_json` / `summary_json` are written
/// verbatim. If `audio_source_path` is given it becomes `audio.ogg`:
///   - `compress = true`  (upload): re-encode the source to Opus (fall back to a
///     raw copy if compression fails for an odd codec).
///   - `compress = false` (live): the source is already an encoded temp `.ogg`,
///     so just move it into place.
/// Returns the absolute entry directory.
#[tauri::command]
pub fn save_history_entry(
    app: AppHandle,
    id: String,
    summary_json: String,
    meta_json: String,
    audio_source_path: Option<String>,
    compress: bool,
) -> Result<String, String> {
    let dir = history_dir(&app)?.join(safe_id(&id));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    if let Some(src) = audio_source_path.filter(|s| !s.trim().is_empty()) {
        let src = PathBuf::from(src);
        let dest = dir.join("audio.ogg");
        if compress {
            match crate::replay_audio::compress_for_upload(&src) {
                Ok(tmp) => move_file(&tmp, &dest)?,
                Err(e) => {
                    log::warn!("history: compress failed ({e}); copying raw source");
                    std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
                }
            }
        } else {
            move_file(&src, &dest)?;
        }
    }

    std::fs::write(dir.join("summary.json"), summary_json).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("meta.json"), meta_json).map_err(|e| e.to_string())?;
    log::info!("history: saved entry {}", dir.to_string_lossy());
    Ok(dir.to_string_lossy().into_owned())
}

/// Save an entry pulled from the cloud: when `audio_url` is given, fetch the
/// recording HERE (reqwest, bearer auth — off the JS↔Rust IPC, no `number[]`
/// round-trip) and write `audio.ogg` plus the meta/summary JSON, so a cloud-only
/// recording becomes an ordinary local entry that loads into replay unchanged.
///
/// The audio is fetched BEFORE anything is written, so a failed download leaves
/// nothing partial for a new entry and doesn't disturb the existing files for a
/// "stale" re-pull (the on-disk invariant: a summary claiming `hasAudio` always
/// has `audio.ogg`). Mirrors pushLocalEntry's "audio first, then commit".
#[tauri::command]
pub async fn save_remote_history_entry(
    app: AppHandle,
    id: String,
    summary_json: String,
    meta_json: String,
    audio_url: Option<String>,
    token: Option<String>,
) -> Result<String, String> {
    // Fetch the audio first — bail (writing nothing) if it fails.
    let audio_bytes = match (audio_url, token) {
        (Some(url), Some(token)) => {
            let res = reqwest::Client::new()
                .get(&url)
                .bearer_auth(&token)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !res.status().is_success() {
                return Err(format!("audio download failed: {}", res.status()));
            }
            Some(res.bytes().await.map_err(|e| e.to_string())?)
        }
        _ => None,
    };
    let dir = history_dir(&app)?.join(safe_id(&id));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if let Some(bytes) = &audio_bytes {
        std::fs::write(dir.join("audio.ogg"), bytes).map_err(|e| e.to_string())?;
    }
    std::fs::write(dir.join("summary.json"), summary_json).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("meta.json"), meta_json).map_err(|e| e.to_string())?;
    log::info!("history: saved remote entry {}", dir.to_string_lossy());
    Ok(dir.to_string_lossy().into_owned())
}

/// Download a cloud audio file to a temp cache path and return it, so an ORG
/// recording can be replayed WITHOUT persisting it under the personal `history/`
/// dir (org recordings must never pollute the local history list). Fetched here
/// (reqwest, bearer auth) so the multi-MB blob never crosses the JS↔Rust IPC. The
/// file lands in `<app_cache_dir>/org-audio/<id>.ogg`; replay reads it via
/// `convertFileSrc`. Re-downloaded on each open (a cache, not a record).
#[tauri::command]
pub async fn download_remote_audio(
    app: AppHandle,
    id: String,
    url: String,
    token: String,
) -> Result<String, String> {
    let res = reqwest::Client::new()
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("audio download failed: {}", res.status()));
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("org-audio");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.ogg", safe_id(&id)));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// List every entry's `summary.json` (raw strings; the frontend parses + sorts).
/// Missing/corrupt summaries are skipped rather than failing the whole list.
#[tauri::command]
pub fn list_history(app: AppHandle) -> Result<Vec<String>, String> {
    let base = history_dir(&app)?;
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(&base) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e.to_string()),
    };
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        if let Ok(s) = std::fs::read_to_string(entry.path().join("summary.json")) {
            out.push(s);
        }
    }
    Ok(out)
}

/// Read one full entry (`meta.json` + resolved audio path) for loading into replay.
#[tauri::command]
pub fn read_history_entry(app: AppHandle, id: String) -> Result<HistoryRead, String> {
    let dir = history_dir(&app)?.join(safe_id(&id));
    let raw = std::fs::read_to_string(dir.join("meta.json")).map_err(|e| e.to_string())?;
    let meta: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let audio = dir.join("audio.ogg");
    let audio_path = audio.exists().then(|| audio.to_string_lossy().into_owned());
    Ok(HistoryRead { meta, audio_path })
}

/// Rename an entry: patch `title` in both `meta.json` and `summary.json` (leaving
/// the recording + analysis untouched).
#[tauri::command]
pub fn rename_history_entry(app: AppHandle, id: String, title: String) -> Result<(), String> {
    let dir = history_dir(&app)?.join(safe_id(&id));
    for file in ["meta.json", "summary.json"] {
        let path = dir.join(file);
        let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let mut value: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        if let Some(obj) = value.as_object_mut() {
            obj.insert("title".into(), serde_json::Value::String(title.clone()));
        }
        let out = serde_json::to_string(&value).map_err(|e| e.to_string())?;
        std::fs::write(&path, out).map_err(|e| e.to_string())?;
    }
    log::info!("history: renamed entry {id}");
    Ok(())
}

/// Delete an entry's folder and everything in it.
#[tauri::command]
pub fn delete_history_entry(app: AppHandle, id: String) -> Result<(), String> {
    let dir = history_dir(&app)?.join(safe_id(&id));
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// A plain-text transcript read for import (issue #130's text-ingest path).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptFile {
    pub text: String,
    /// File mtime as epoch ms — the entry's default `createdAt` when the file
    /// name carries no date. None when the filesystem can't say.
    pub modified_ms: Option<f64>,
}

/// Read a `.txt` transcript for the import dialog. Guarded to the one extension
/// the picker offers and a generous size cap, since the path arrives from the
/// webview.
#[tauri::command]
pub fn read_transcript_file(path: String) -> Result<TranscriptFile, String> {
    const MAX_BYTES: u64 = 20 * 1024 * 1024;
    let p = PathBuf::from(&path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext != "txt" {
        return Err("only .txt transcripts can be imported".into());
    }
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if meta.len() > MAX_BYTES {
        return Err("transcript file is too large (max 20 MB)".into());
    }
    let text = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64);
    Ok(TranscriptFile { text, modified_ms })
}
