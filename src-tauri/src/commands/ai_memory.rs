//! Onboarding's "read what your AI already knows about you": the memory files
//! Claude Code keeps on this machine. Only ever read when the user presses the
//! button on the context step; the text goes back to the webview, which hands
//! it to the user's own LLM to boil down into speaker-background lines.
//!
//! Sources (all optional, missing ones are skipped):
//! - `~/.claude/CLAUDE.md` — the user-level memory every session loads.
//! - `~/.claude/projects/<project>/memory/*.md` — Claude Code's auto memory.
//!
//! ChatGPT keeps its memory server-side with no API to read it, so that path is
//! a copy/paste in the UI and never touches this module.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// One file is cut here: a memory file is notes, not a document, and anything
/// longer is almost certainly something else that happens to end in `.md`.
const MAX_FILE_BYTES: usize = 16 * 1024;
/// The whole read stops here, newest files first, so one prolific project can't
/// crowd the prompt.
const MAX_TOTAL_BYTES: usize = 64 * 1024;
/// Auto-memory files considered per run, newest first.
const MAX_FILES: usize = 40;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFile {
    /// Where the file came from, for the UI: `"global"` or the project folder name.
    pub label: String,
    pub text: String,
}

/// Read Claude Code's memory files from the user's home directory.
#[tauri::command]
pub fn read_claude_memory(app: AppHandle) -> Result<Vec<MemoryFile>, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    Ok(collect_claude_memory(&home))
}

/// The memory files under `home/.claude`, global first, then auto memory newest
/// first, capped by [`MAX_FILE_BYTES`], [`MAX_FILES`] and [`MAX_TOTAL_BYTES`].
pub(crate) fn collect_claude_memory(home: &Path) -> Vec<MemoryFile> {
    let root = home.join(".claude");
    let mut out = Vec::new();
    let mut total = 0usize;

    let mut push = |label: String, path: &Path, out: &mut Vec<MemoryFile>| -> bool {
        let Some(text) = read_capped(path) else { return true };
        if total + text.len() > MAX_TOTAL_BYTES {
            return false;
        }
        total += text.len();
        out.push(MemoryFile { label, text });
        true
    };

    if !push("global".into(), &root.join("CLAUDE.md"), &mut out) {
        return out;
    }

    let mut auto: Vec<(std::time::SystemTime, String, PathBuf)> = Vec::new();
    if let Ok(projects) = std::fs::read_dir(root.join("projects")) {
        for project in projects.flatten() {
            let label = project.file_name().to_string_lossy().into_owned();
            let Ok(files) = std::fs::read_dir(project.path().join("memory")) else { continue };
            for file in files.flatten() {
                let path = file.path();
                if path.extension().and_then(|e| e.to_str()) != Some("md") {
                    continue;
                }
                let modified = file
                    .metadata()
                    .and_then(|m| m.modified())
                    .unwrap_or(std::time::UNIX_EPOCH);
                auto.push((modified, label.clone(), path));
            }
        }
    }
    auto.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, label, path) in auto.into_iter().take(MAX_FILES) {
        if !push(label, &path, &mut out) {
            break;
        }
    }
    out
}

/// A file's text cut to [`MAX_FILE_BYTES`] on a char boundary; `None` when it
/// is missing, unreadable, not UTF-8 or blank.
fn read_capped(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let mut end = text.len().min(MAX_FILE_BYTES);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Some(text[..end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("parley-ai-memory-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_claude_dir_reads_nothing() {
        let home = temp_home("missing");
        assert!(collect_claude_memory(&home).is_empty());
    }

    #[test]
    fn reads_global_then_auto_memory_and_skips_blank_and_non_md() {
        let home = temp_home("reads");
        let claude = home.join(".claude");
        std::fs::create_dir_all(claude.join("projects/-work-parley/memory")).unwrap();
        std::fs::write(claude.join("CLAUDE.md"), "  I design Parley.\n").unwrap();
        std::fs::write(claude.join("projects/-work-parley/memory/MEMORY.md"), "Team: Joe").unwrap();
        std::fs::write(claude.join("projects/-work-parley/memory/blank.md"), "   ").unwrap();
        std::fs::write(claude.join("projects/-work-parley/memory/notes.txt"), "skip").unwrap();

        let files = collect_claude_memory(&home);
        assert_eq!(
            files,
            vec![
                MemoryFile { label: "global".into(), text: "I design Parley.".into() },
                MemoryFile { label: "-work-parley".into(), text: "Team: Joe".into() },
            ]
        );
    }

    #[test]
    fn long_file_is_cut_on_a_char_boundary() {
        let home = temp_home("long");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(home.join(".claude/CLAUDE.md"), "語".repeat(MAX_FILE_BYTES)).unwrap();
        let files = collect_claude_memory(&home);
        assert_eq!(files.len(), 1);
        assert!(files[0].text.len() <= MAX_FILE_BYTES);
        assert!(files[0].text.chars().all(|c| c == '語'));
    }
}
