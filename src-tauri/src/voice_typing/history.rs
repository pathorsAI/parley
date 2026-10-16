//! The dictation history file (`voice_typing_history.jsonl` in the app config
//! dir), which the frontend parses and owns.

use tauri::AppHandle;

use crate::commands::config::{app_config_file, append_line, read_config_file, write_config_file};

/// Name of the voice-typing history file (one JSON object per line) in the app
/// config dir.
const HISTORY_FILE: &str = "voice_typing_history.jsonl";

/// Append one history entry (a JSON line: `{ id, text, ts }`).
#[tauri::command]
pub fn append_voice_history(app: AppHandle, line: String) -> Result<(), String> {
    append_line(&app_config_file(&app, HISTORY_FILE)?, &line)
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
