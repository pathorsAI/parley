//! Onboarding's "what your AI already knows about you": the memory files
//! Claude Code keeps on this machine, read when the context step opens. The
//! text goes back to the webview, which masks secrets and hands it to the
//! user's own LLM to condense into a few read-only lines.
//!
//! Sources (all optional, missing ones are skipped), in this order:
//! - `~/.claude/CLAUDE.md` — the user-level memory every session loads.
//! - `~/.claude/projects/<project>/memory/*.md` — Claude Code's auto memory.
//! - `CLAUDE.md` / `.claude/CLAUDE.md` in the projects Claude Code has opened
//!   (the `projects` keys of `~/.claude.json`) — where most people keep theirs.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// One file is cut here: a memory file is notes, not a document, and anything
/// longer is almost certainly something else that happens to end in `.md`.
const MAX_FILE_BYTES: usize = 16 * 1024;
/// The whole read stops here, newest files first, so one prolific project can't
/// crowd the prompt. Matches the frontend's `MAX_MEMORY_CHARS`, so nothing read
/// here is thrown away there; a file that would cross it is skipped whole rather
/// than cut mid-fact.
const MAX_TOTAL_BYTES: usize = 24_000;
/// Auto-memory files considered per run, newest first.
const MAX_FILES: usize = 40;
/// Project CLAUDE.md files considered per run, newest first.
const MAX_PROJECT_FILES: usize = 5;
/// A project's CLAUDE.md is mostly that project's conventions; its start is
/// where the "who / what" usually is, and this keeps one long file from
/// taking the whole budget.
const MAX_PROJECT_FILE_BYTES: usize = 6 * 1024;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFile {
    /// Where the file came from: `"global"` or `"project"`. Never the project
    /// folder's name: Claude Code names it after the project's absolute path,
    /// which carries the username and often a client's name, and this text is
    /// sent to an LLM.
    pub label: String,
    /// Which kind of memory it is, for the onboarding step's reading log:
    /// `"global"`, `"auto"` (Claude Code's auto memory) or `"project"` (a
    /// project's CLAUDE.md).
    pub kind: &'static str,
    /// A short display name for the reading log (`~/.claude/CLAUDE.md`, the
    /// auto-memory file's name, `<folder>/CLAUDE.md`). Shown on this machine
    /// only; never part of the text sent to the LLM.
    pub name: String,
    pub text: String,
}

/// Read Claude Code's memory files from the user's home directory.
#[tauri::command]
pub fn read_claude_memory(app: AppHandle) -> Result<Vec<MemoryFile>, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    Ok(collect_claude_memory(&home))
}

/// Claude Code's memory: the global file, then auto memory newest first, then
/// the CLAUDE.md of the projects it has opened, newest first; capped by
/// [`MAX_FILE_BYTES`] / [`MAX_PROJECT_FILE_BYTES`], [`MAX_FILES`] /
/// [`MAX_PROJECT_FILES`] and [`MAX_TOTAL_BYTES`].
pub(crate) fn collect_claude_memory(home: &Path) -> Vec<MemoryFile> {
    let root = home.join(".claude");
    let mut out = Vec::new();
    let mut total = 0usize;

    let mut push =
        |kind: &'static str, name: String, path: &Path, max: usize, out: &mut Vec<MemoryFile>| {
            let Some(text) = read_capped(path, max) else {
                return;
            };
            if total + text.len() > MAX_TOTAL_BYTES {
                return;
            }
            total += text.len();
            out.push(MemoryFile {
                label: if kind == "global" {
                    "global"
                } else {
                    "project"
                }
                .into(),
                kind,
                name,
                text,
            });
        };

    push(
        "global",
        "~/.claude/CLAUDE.md".into(),
        &root.join("CLAUDE.md"),
        MAX_FILE_BYTES,
        &mut out,
    );

    let mut auto: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    if let Ok(projects) = std::fs::read_dir(root.join("projects")) {
        for project in projects.flatten() {
            let Ok(files) = std::fs::read_dir(project.path().join("memory")) else {
                continue;
            };
            for file in files.flatten() {
                let path = file.path();
                if path.extension().and_then(|e| e.to_str()) != Some("md") {
                    continue;
                }
                auto.push((modified_at(&path), path));
            }
        }
    }
    auto.sort_by_key(|a| std::cmp::Reverse(a.0));
    for (_, path) in auto.into_iter().take(MAX_FILES) {
        push("auto", file_name(&path), &path, MAX_FILE_BYTES, &mut out);
    }

    let mut project_files: Vec<(std::time::SystemTime, PathBuf)> = project_dirs(home)
        .into_iter()
        .flat_map(|dir| [dir.join("CLAUDE.md"), dir.join(".claude").join("CLAUDE.md")])
        .filter(|path| path.is_file())
        .map(|path| (modified_at(&path), path))
        .collect();
    project_files.sort_by_key(|a| std::cmp::Reverse(a.0));
    project_files.dedup_by(|a, b| a.1 == b.1);
    for (_, path) in project_files.into_iter().take(MAX_PROJECT_FILES) {
        push(
            "project",
            project_file_name(&path),
            &path,
            MAX_PROJECT_FILE_BYTES,
            &mut out,
        );
    }
    out
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// `<project folder>/CLAUDE.md`, or `<project folder>/.claude/CLAUDE.md`.
fn project_file_name(path: &Path) -> String {
    let parent = path.parent();
    let (dir, prefix) = match parent {
        Some(p) if p.file_name().is_some_and(|n| n == ".claude") => (p.parent(), ".claude/"),
        _ => (parent, ""),
    };
    let folder = dir
        .and_then(|d| d.file_name())
        .map(|n| n.to_string_lossy().into_owned());
    match folder {
        Some(folder) => format!("{folder}/{prefix}{}", file_name(path)),
        None => file_name(path),
    }
}

/// The project folders Claude Code has opened: the keys of `projects` in
/// `~/.claude.json`, absolute paths only. Empty when the file is missing or
/// isn't the shape expected.
fn project_dirs(home: &Path) -> Vec<PathBuf> {
    let Ok(raw) = std::fs::read_to_string(home.join(".claude.json")) else {
        return Vec::new();
    };
    let Ok(config) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Vec::new();
    };
    config
        .get("projects")
        .and_then(|p| p.as_object())
        .map(|projects| {
            projects
                .keys()
                .map(PathBuf::from)
                .filter(|p| p.is_absolute())
                .collect()
        })
        .unwrap_or_default()
}

fn modified_at(path: &Path) -> std::time::SystemTime {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .unwrap_or(std::time::UNIX_EPOCH)
}

/// A file's text cut to `max` bytes on a char boundary; `None` when it is
/// missing, unreadable, not UTF-8 or blank.
fn read_capped(path: &Path, max: usize) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Some(text[..end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("parley-ai-memory-{name}-{}", std::process::id()));
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
        std::fs::write(
            claude.join("projects/-work-parley/memory/MEMORY.md"),
            "Team: Joe",
        )
        .unwrap();
        std::fs::write(claude.join("projects/-work-parley/memory/blank.md"), "   ").unwrap();
        std::fs::write(
            claude.join("projects/-work-parley/memory/notes.txt"),
            "skip",
        )
        .unwrap();

        let files = collect_claude_memory(&home);
        assert_eq!(
            files,
            vec![
                MemoryFile {
                    label: "global".into(),
                    kind: "global",
                    name: "~/.claude/CLAUDE.md".into(),
                    text: "I design Parley.".into()
                },
                MemoryFile {
                    label: "project".into(),
                    kind: "auto",
                    name: "MEMORY.md".into(),
                    text: "Team: Joe".into()
                },
            ]
        );
    }

    #[test]
    fn a_file_that_would_cross_the_total_is_skipped_whole() {
        let home = temp_home("total");
        let mem = home.join(".claude/projects/p/memory");
        std::fs::create_dir_all(&mem).unwrap();
        std::fs::write(home.join(".claude/CLAUDE.md"), "g".repeat(MAX_FILE_BYTES)).unwrap();
        // Doesn't fit in what's left after the global file: skipped, not cut.
        std::fs::write(
            mem.join("big.md"),
            "b".repeat(MAX_TOTAL_BYTES - MAX_FILE_BYTES + 1),
        )
        .unwrap();
        // Still fits: read even though a file before or after it was skipped.
        std::fs::write(mem.join("small.md"), "s".repeat(100)).unwrap();

        let files = collect_claude_memory(&home);
        let labels: Vec<_> = files
            .iter()
            .map(|f| (f.label.as_str(), f.text.len()))
            .collect();
        assert_eq!(labels, vec![("global", MAX_FILE_BYTES), ("project", 100)]);
    }

    #[test]
    fn reads_the_claude_md_of_projects_listed_in_claude_json() {
        let home = temp_home("projects");
        let work = home.join("work");
        std::fs::create_dir_all(work.join("parley/.claude")).unwrap();
        std::fs::create_dir_all(work.join("site")).unwrap();
        std::fs::write(
            work.join("parley/.claude/CLAUDE.md"),
            "Parley: meeting assistant",
        )
        .unwrap();
        std::fs::write(
            work.join("site/CLAUDE.md"),
            "x".repeat(MAX_PROJECT_FILE_BYTES + 500),
        )
        .unwrap();
        let config = serde_json::json!({
            "projects": {
                work.join("parley").to_string_lossy(): {},
                work.join("site").to_string_lossy(): {},
                work.join("gone").to_string_lossy(): {},
                "relative/path": {}
            }
        });
        std::fs::write(home.join(".claude.json"), config.to_string()).unwrap();

        let mut files = collect_claude_memory(&home);
        files.sort_by_key(|f| f.text.len());
        assert_eq!(files.len(), 2);
        assert!(files
            .iter()
            .all(|f| f.label == "project" && f.kind == "project"));
        assert_eq!(files[0].text, "Parley: meeting assistant");
        assert_eq!(files[0].name, "parley/.claude/CLAUDE.md");
        assert_eq!(files[1].name, "site/CLAUDE.md");
        // A long project file is read only up to its own cap.
        assert_eq!(files[1].text.len(), MAX_PROJECT_FILE_BYTES);
    }

    #[test]
    fn a_broken_claude_json_reads_no_projects() {
        let home = temp_home("broken-json");
        std::fs::write(home.join(".claude.json"), "{ not json").unwrap();
        assert!(collect_claude_memory(&home).is_empty());
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
