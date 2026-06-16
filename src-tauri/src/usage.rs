//! Local usage/cost log. Every LLM call and transcription session appends one
//! JSON line to `<appConfigDir>/usage.jsonl`. Cost is computed on the frontend
//! (single source of truth for pricing) and stored alongside the raw usage, so
//! historical cost stays frozen even when prices later change.
//!
//! The frontend owns the schema; Rust only appends opaque lines and reads them
//! back, keeping pricing logic in one place (src/lib/usage/pricing.ts).

use tauri::{AppHandle, Manager};

/// Path to the append-only usage log (same config dir as templates.json).
fn usage_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("usage.jsonl"))
}

/// Append one usage record (a single JSON object, already serialized) as a line.
/// Creates the config dir and file on first write.
#[tauri::command]
pub fn append_usage_event(app: AppHandle, line: String) -> Result<(), String> {
    use std::io::Write;
    let path = usage_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    // Store one record per line; callers pass a single-line JSON object.
    writeln!(file, "{}", line.trim_end()).map_err(|e| e.to_string())?;
    Ok(())
}

/// Read the whole usage log (empty string if it doesn't exist yet). The
/// frontend parses it line-by-line.
#[tauri::command]
pub fn read_usage_events(app: AppHandle) -> Result<String, String> {
    let path = usage_path(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(_) => Ok(String::new()),
    }
}
