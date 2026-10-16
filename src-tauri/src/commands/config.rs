//! The small state files the app keeps in its config dir (templates, the
//! phrase dictionary, the folder registry, the session snapshot and command
//! queue, voice-typing history): where each lives, and the IO on them. The
//! IO takes a plain path, so it runs without Tauri.

use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// Path to `name` inside the app config dir, where all of the app's small
/// config/state files (templates, session snapshot, command queue, voice
/// history) live.
pub(crate) fn app_config_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

/// Read an app-config file as a string, treating a missing file as empty (the
/// convention for every optional JSON/JSONL state file).
pub(crate) fn read_config_file(app: &AppHandle, name: &str) -> Result<String, String> {
    Ok(read_or_empty(&app_config_file(app, name)?))
}

/// Write an app-config file, creating the config dir on first use.
pub(crate) fn write_config_file(app: &AppHandle, name: &str, contents: &str) -> Result<(), String> {
    write_creating_dir(&app_config_file(app, name)?, contents)
}

/// A state file's contents, or an empty string when it can't be read — a
/// file that does not exist yet is the usual case.
pub(crate) fn read_or_empty(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

/// Write a state file, creating its directory on first use.
pub(crate) fn write_creating_dir(path: &Path, contents: &str) -> Result<(), String> {
    create_parent(path)?;
    std::fs::write(path, contents).map_err(|e| e.to_string())
}

/// Append `line` and a newline to a JSONL state file, creating the file (and
/// its directory) on first use.
pub(crate) fn append_line(path: &Path, line: &str) -> Result<(), String> {
    create_parent(path)?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    writeln!(file, "{line}").map_err(|e| e.to_string())
}

fn create_parent(path: &Path) -> Result<(), String> {
    match path.parent() {
        Some(parent) => std::fs::create_dir_all(parent).map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::{append_line, read_or_empty, write_creating_dir};

    fn scratch(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("parley-config-{tag}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn a_missing_file_reads_as_empty() {
        let dir = scratch("missing");
        assert_eq!(read_or_empty(&dir.join("templates.json")), "");
        // A directory where the file should be is unreadable too.
        std::fs::create_dir_all(dir.join("folders.json")).unwrap();
        assert_eq!(read_or_empty(&dir.join("folders.json")), "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_write_creates_the_dir_and_replaces_the_contents() {
        let dir = scratch("write");
        let path = dir.join("nested").join("session.json");
        write_creating_dir(&path, "{\"a\":1}").unwrap();
        write_creating_dir(&path, "{}").unwrap();
        assert_eq!(read_or_empty(&path), "{}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn appends_add_one_line_each() {
        let dir = scratch("append");
        let path = dir.join("session_command_results.jsonl");
        append_line(&path, "{\"id\":\"a\"}").unwrap();
        append_line(&path, "{\"id\":\"b\"}").unwrap();
        assert_eq!(read_or_empty(&path), "{\"id\":\"a\"}\n{\"id\":\"b\"}\n");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
