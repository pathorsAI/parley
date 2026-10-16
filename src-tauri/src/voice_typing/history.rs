//! The dictation history file (`voice_typing_history.jsonl` in the app config
//! dir), which the frontend parses and owns.

use tauri::AppHandle;

use crate::commands::{read_config_file, write_config_file};

/// Name of the voice-typing history file (one JSON object per line) in the app
/// config dir.
const HISTORY_FILE: &str = "voice_typing_history.jsonl";

/// Append one history entry (a JSON line: `{ id, text, ts }`).
#[tauri::command]
pub fn append_voice_history(app: AppHandle, line: String) -> Result<(), String> {
    use std::io::Write;
    let path = crate::commands::app_config_file(&app, HISTORY_FILE)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(f, "{line}").map_err(|e| e.to_string())
}

/// Read the whole history file (empty string if none yet). The frontend parses
/// the JSONL and owns filtering for delete/clear (which write the file back).
#[tauri::command]
pub fn read_voice_history(app: AppHandle) -> Result<String, String> {
    read_config_file(&app, HISTORY_FILE)
}

/// Overwrite the history file (used by delete-one / clear-all).
#[tauri::command]
pub fn write_voice_history(app: AppHandle, content: String) -> Result<(), String> {
    write_config_file(&app, HISTORY_FILE, &content)
}
