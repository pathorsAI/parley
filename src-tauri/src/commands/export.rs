//! Files the user keeps outside the app: saved transcripts (Documents/Parley),
//! a recording's audio exported where they chose, and the cleanup of a live
//! recording the frontend decided not to save.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// The app's folder inside the user's Documents directory — where the
/// human-readable artifacts (saved transcripts, batch-transcription diagnostic logs) go.
///
/// Resolved through Tauri's path API rather than `$HOME`, which Windows does
/// not set: reading it there failed every save and every diagnostic log with
/// "no HOME dir", so the one artifact support asks for never existed.
pub(crate) fn documents_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let docs = app.path().document_dir().map_err(|e| e.to_string())?;
    Ok(docs.join("Parley"))
}

/// Save a meeting transcript (markdown) to the Documents/Parley folder and
/// return the absolute path written. Creates the folder if needed.
#[tauri::command]
pub fn save_transcript(
    app: AppHandle,
    filename: String,
    contents: String,
) -> Result<String, String> {
    save_into(&documents_dir(&app)?, &filename, &contents)
}

/// Write `contents` as `filename` in `dir` (created if needed), with the name
/// flattened to a single path component; returns the path written.
fn save_into(dir: &Path, filename: &str, contents: &str) -> Result<String, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    // Sanitize the filename to a single path component.
    let safe = filename.replace(['/', '\\'], "-");
    let path = dir.join(safe);
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Copy a recording's audio file to a user-chosen destination (the replay
/// "Save audio…" action — the frontend picks `dst` via the save dialog).
///
/// Copied on a blocking worker rather than inline: a sync command runs on the
/// main thread, where a multi-GB copy would freeze every window and stall every
/// other command until it finished (see `save_history_entry`).
#[tauri::command]
pub async fn export_recording(src: String, dst: String) -> Result<(), String> {
    if !std::path::Path::new(&src).exists() {
        return Err(format!("source recording not found: {src}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::copy(&src, &dst)
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("export task panicked: {e}"))?
}

/// Delete a freshly-encoded live recording the frontend decided NOT to save —
/// e.g. an empty meeting with no transcript (likely an accidental Start/Stop).
/// `save_history_entry` removes the temp source when it moves it into an entry
/// folder; this is the matching cleanup for the skip path so the `.ogg` doesn't
/// orphan in the temp dir.
///
/// Guarded: only removes a file under the OS temp dir whose name matches our own
/// `parley-recording-*.ogg`, so it can never be coerced into deleting an
/// arbitrary path.
#[tauri::command]
pub fn discard_recording(path: String) {
    let p = std::path::Path::new(&path);
    let in_temp = p.starts_with(std::env::temp_dir());
    let looks_like_ours = p
        .file_name()
        .and_then(|f| f.to_str())
        .is_some_and(|f| f.starts_with("parley-recording-") && f.ends_with(".ogg"));
    if in_temp && looks_like_ours {
        match std::fs::remove_file(p) {
            Ok(()) => log::info!("recording: discarded unsaved {path}"),
            Err(e) => log::warn!("recording: discard failed for {path}: {e}"),
        }
    } else {
        log::warn!("recording: refused to discard non-recording path {path}");
    }
}

#[cfg(test)]
mod tests {
    use super::{discard_recording, save_into};

    #[test]
    fn a_transcript_is_saved_under_a_single_component_name() {
        let dir = std::env::temp_dir().join(format!("parley-save-{}", uuid::Uuid::new_v4()));
        let written = save_into(&dir, "../a/b\\c.md", "# hi").unwrap();
        assert_eq!(written, dir.join("..-a-b-c.md").to_string_lossy());
        assert_eq!(std::fs::read_to_string(&written).unwrap(), "# hi");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn discard_recording_removes_only_our_temp_recordings() {
        let ours = std::env::temp_dir().join(format!(
            "parley-recording-test-{}.ogg",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&ours, b"ogg").unwrap();
        discard_recording(ours.to_string_lossy().into_owned());
        assert!(!ours.exists());

        // Right folder, wrong name: refused.
        let other = std::env::temp_dir().join(format!("not-ours-{}.ogg", uuid::Uuid::new_v4()));
        std::fs::write(&other, b"keep").unwrap();
        discard_recording(other.to_string_lossy().into_owned());
        assert!(other.exists());
        let _ = std::fs::remove_file(&other);

        // Right name, outside the temp dir: refused.
        let dir = std::env::current_dir()
            .unwrap()
            .join("target")
            .join(format!("discard-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let outside = dir.join("parley-recording-1.ogg");
        std::fs::write(&outside, b"keep").unwrap();
        discard_recording(outside.to_string_lossy().into_owned());
        assert!(outside.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
