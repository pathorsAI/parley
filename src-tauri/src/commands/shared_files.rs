//! The JSON files the app shares between its windows, its instances and the
//! MCP server: templates, the phrase dictionary and the folder registry.
//! Rust only moves the bytes; the frontend owns every schema.

use std::path::PathBuf;

use tauri::AppHandle;

use super::config::{app_config_file, read_config_file, write_config_file};

/// Path to the shared templates file (app config dir). The local MCP server
/// reads/writes the same file so templates can be managed outside the app.
pub(crate) fn templates_path(app: &AppHandle) -> Result<PathBuf, String> {
    app_config_file(app, "templates.json")
}

/// Read the shared templates JSON (empty string if the file doesn't exist yet).
#[tauri::command]
pub fn read_templates(app: AppHandle) -> Result<String, String> {
    read_config_file(&app, "templates.json")
}

/// Write the shared templates JSON, creating the config dir if needed.
#[tauri::command]
pub fn write_templates(app: AppHandle, json: String) -> Result<(), String> {
    write_config_file(&app, "templates.json", &json)
}

/// Path to the shared voice-typing phrase dictionary (app config dir). The local
/// MCP server reads/writes the same file so phrases can be managed outside the
/// app — same arrangement as [`templates_path`].
pub(crate) fn dictionary_path(app: &AppHandle) -> Result<PathBuf, String> {
    app_config_file(app, "dictionary.json")
}

/// Read the phrase-dictionary JSON verbatim (empty string if the file doesn't
/// exist yet). The frontend owns the schema and does the parsing; Rust only ever
/// moves the bytes, so a dictionary written by a newer app version can't be
/// mangled by an older backend.
#[tauri::command]
pub fn read_dictionary(app: AppHandle) -> Result<String, String> {
    read_config_file(&app, "dictionary.json")
}

/// Write the phrase-dictionary JSON, creating the config dir if needed.
#[tauri::command]
pub fn write_dictionary(app: AppHandle, contents: String) -> Result<(), String> {
    write_config_file(&app, "dictionary.json", &contents)
}

/// Read the shared personal-folder registry JSON (empty string if the file
/// doesn't exist yet). The registry lives on DISK — one file for every window
/// AND every app instance (packaged + `tauri dev` share the config dir) — so
/// the folder list can never fork per webview origin the way the old
/// localStorage registry did.
#[tauri::command]
pub fn read_folders(app: AppHandle) -> Result<String, String> {
    read_config_file(&app, "folders.json")
}

/// Write the shared personal-folder registry JSON, creating the config dir if
/// needed.
#[tauri::command]
pub fn write_folders(app: AppHandle, json: String) -> Result<(), String> {
    write_config_file(&app, "folders.json", &json)
}

/// Get the absolute path to the templates.json file.
#[tauri::command]
pub fn get_templates_path(app: AppHandle) -> Result<String, String> {
    let path = templates_path(&app)?;
    Ok(path.to_string_lossy().into_owned())
}
