//! The live session as the MCP server sees it: the snapshot the frontend
//! writes, the queue of commands the server appends for it, and the results
//! the frontend appends back for RPC-style commands.

use std::path::PathBuf;

use tauri::AppHandle;

use super::config::{app_config_file, append_line, read_config_file, write_config_file};

/// Path to the live session snapshot the built-in MCP server reads.
pub(crate) fn session_path(app: &AppHandle) -> Result<PathBuf, String> {
    app_config_file(app, "session.json")
}

/// Write the live session snapshot (meeting status, transcript, todos,
/// evaluations) so MCP clients can read the current meeting state.
#[tauri::command]
pub fn write_session(app: AppHandle, json: String) -> Result<(), String> {
    write_config_file(&app, "session.json", &json)
}

/// Append-only queue of mutation commands the MCP server writes and the
/// frontend applies (add/check/remove todo, add/remove evaluation).
pub(crate) fn session_commands_path(app: &AppHandle) -> Result<PathBuf, String> {
    app_config_file(app, "session_commands.jsonl")
}

/// Read the pending session-command queue (one JSON object per line). The
/// frontend polls this and applies commands it hasn't seen yet.
#[tauri::command]
pub fn read_session_commands(app: AppHandle) -> Result<String, String> {
    read_config_file(&app, "session_commands.jsonl")
}

/// Append-only results file for RPC-style session commands: the MCP server
/// enqueues a command carrying an `id`, the frontend executes it and appends
/// `{ id, ok, data|error }` here, and the MCP handler polls for its id.
pub(crate) fn session_command_results_path(app: &AppHandle) -> Result<PathBuf, String> {
    app_config_file(app, "session_command_results.jsonl")
}

/// Append one RPC command result (a JSON object line) for the MCP server to
/// pick up. Called by the frontend after executing a command that carried an id.
#[tauri::command]
pub fn append_session_command_result(app: AppHandle, json: String) -> Result<(), String> {
    append_line(&session_command_results_path(&app)?, json.trim())
}
