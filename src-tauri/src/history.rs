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

/// Base directory for all history entries (`<app_data_dir>/history`).
fn history_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("history"))
}

/// Reduce an id to a single safe path component (it's a minted UUID, but guard
/// against separators/traversal regardless).
fn safe_id(id: &str) -> String {
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
    let audio_path = audio
        .exists()
        .then(|| audio.to_string_lossy().into_owned());
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
