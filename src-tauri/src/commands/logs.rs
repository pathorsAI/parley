//! The in-app log viewer's feed: the tail of the rotating field log.

use std::path::Path;

use tauri::{AppHandle, Manager};

/// Read the tail of the rotating field log (`<app_log_dir>/parley.log`) for the
/// live in-app log viewer. Returns at most `max_bytes` from the end; a partial
/// first line (from cutting mid-line) is dropped so callers always get whole
/// lines. Empty string if the file doesn't exist yet.
#[tauri::command]
pub fn read_log_tail(app: AppHandle, max_bytes: u64) -> Result<String, String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    read_tail(&dir.join("parley.log"), max_bytes)
}

/// The last `max_bytes` (at least 1) of `path`, starting at a line boundary
/// when that cut lands mid-line; empty if the file does not exist.
fn read_tail(path: &Path, max_bytes: u64) -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(e.to_string()),
    };
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let cap = max_bytes.max(1);
    let start = len.saturating_sub(cap);
    file.seek(SeekFrom::Start(start))
        .map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| e.to_string())?;

    let mut text = String::from_utf8_lossy(&buf).into_owned();
    // Drop the leading partial line when we started mid-file.
    if start > 0 {
        if let Some(nl) = text.find('\n') {
            text = text.split_off(nl + 1);
        }
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::read_tail;

    fn log_with(contents: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("parley-log-{}.log", uuid::Uuid::new_v4()));
        std::fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn a_missing_log_reads_as_empty() {
        let path = std::env::temp_dir().join(format!("parley-log-{}.log", uuid::Uuid::new_v4()));
        assert_eq!(read_tail(&path, 100).unwrap(), "");
    }

    #[test]
    fn a_short_log_comes_back_whole() {
        let path = log_with("one\ntwo\n");
        assert_eq!(read_tail(&path, 100).unwrap(), "one\ntwo\n");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_cut_mid_line_drops_the_partial_first_line() {
        let path = log_with("first line\nsecond\nthird\n");
        // The last 12 bytes start inside "second".
        assert_eq!(read_tail(&path, 12).unwrap(), "third\n");
        // A cut exactly after a newline still drops up to the next one.
        assert_eq!(read_tail(&path, 13).unwrap(), "third\n");
        let _ = std::fs::remove_file(&path);
        // No newline after the cut: the partial line is all there is.
        let path = log_with("abc\ndefgh");
        assert_eq!(read_tail(&path, 3).unwrap(), "fgh");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_zero_budget_still_reads_one_byte() {
        let path = log_with("abc");
        assert_eq!(read_tail(&path, 0).unwrap(), "c");
        let _ = std::fs::remove_file(&path);
    }
}
