//! The local recording store, read-only: `<app_data_dir>/history`, one folder
//! per recording with its `summary.json` and `meta.json` (the layout
//! history.rs documents).

use serde_json::{json, Value};

use super::context::ANALYSIS_NOTE;

mod search;
mod transcript;

pub(super) use search::search_meetings;
use transcript::transcript_text;

/// Read one entry's `meta.json`.
pub(super) fn read_meta(history_dir: &std::path::Path, id: &str) -> anyhow::Result<Value> {
    let path = history_dir
        .join(crate::history::safe_id(id))
        .join("meta.json");
    let raw = std::fs::read_to_string(&path).map_err(|_| {
        anyhow::anyhow!(
            "recording not found: {id} (only locally saved personal recordings are \
             readable here — use list_recordings for valid ids)"
        )
    })?;
    Ok(serde_json::from_str(&raw)?)
}

/// List local recording summaries, newest first, with an optional text filter.
pub(super) fn list_recordings(
    history_dir: &std::path::Path,
    args: &Value,
) -> anyhow::Result<Value> {
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let folder = args.get("folderId").and_then(Value::as_str);
    let since = args.get("since").and_then(Value::as_i64).unwrap_or(0);
    let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(50) as usize;

    let mut items: Vec<Value> = read_entry_files(history_dir, "summary.json")
        .filter(|v| in_scope(v, folder, since) && summary_matches_query(v, &query))
        .collect();
    items.sort_by_key(|v| {
        std::cmp::Reverse(v.get("createdAt").and_then(Value::as_i64).unwrap_or(0))
    });
    let total = items.len();
    items.truncate(limit);
    Ok(json!({ "recordings": items, "total": total, "returned": items.len() }))
}

/// Every entry's `file` (`summary.json` / `meta.json`) in the store, as JSON.
/// Entries that can't be read or parsed are skipped — a half-written recording
/// shouldn't fail the whole listing. Lazy: one entry is held at a time, so a
/// large library's `meta.json` files never all sit in memory at once.
fn read_entry_files<'a>(
    history_dir: &std::path::Path,
    file: &'a str,
) -> impl Iterator<Item = Value> + 'a {
    std::fs::read_dir(history_dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(move |entry| std::fs::read_to_string(entry.path().join(file)).ok())
        .filter_map(|raw| serde_json::from_str::<Value>(&raw).ok())
}

/// Folder + `since` scoping, shared by the listing and the search.
fn in_scope(v: &Value, folder: Option<&str>, since: i64) -> bool {
    if let Some(folder) = folder {
        if v.get("folderId").and_then(Value::as_str) != Some(folder) {
            return false;
        }
    }
    since <= 0 || v.get("createdAt").and_then(Value::as_i64).unwrap_or(0) >= since
}

/// The listing's shallow text filter: title or first-line snippet only (the deep
/// search is `search_meetings`). An empty query matches everything. `query` is
/// already lowercased.
fn summary_matches_query(v: &Value, query: &str) -> bool {
    if query.is_empty() {
        return true;
    }
    let title = v.get("title").and_then(Value::as_str).unwrap_or("");
    let snippet = v.get("snippet").and_then(Value::as_str).unwrap_or("");
    title.to_lowercase().contains(query) || snippet.to_lowercase().contains(query)
}

/// Read one recording in full: curated meta fields + the transcript rebuilt as
/// timestamped, speaker-labelled text (the segments themselves stay on disk).
/// Includes every analysis artifact saved with the entry, labelled as context
/// via `analysisNote`.
pub(super) fn get_recording(history_dir: &std::path::Path, id: &str) -> anyhow::Result<Value> {
    let meta = read_meta(history_dir, id)?;
    let names = meta
        .get("speakerNames")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let transcript = transcript_text(&meta, &names);
    let mut out = serde_json::Map::new();
    out.insert("analysisNote".into(), json!(ANALYSIS_NOTE));
    for key in [
        "id",
        "title",
        "source",
        "createdAt",
        "durationMs",
        "speakerNames",
        "findings",
        "actionItems",
        "brief",
        "deliveryAssessment",
        "meetingContext",
        "folderId",
        "analyzed",
    ] {
        if let Some(v) = meta.get(key) {
            if !v.is_null() {
                out.insert(key.into(), v.clone());
            }
        }
    }
    out.insert("transcript".into(), json!(transcript));
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::search::segment_hits;
    use super::transcript::transcript_text;
    use crate::mcp::tests::untimed_meta;
    use serde_json::json;

    #[test]
    fn untimed_transcript_reads_with_estimated_clocks() {
        let meta = untimed_meta(
            &[
                "你好，今天我們討論報價。",
                "OK, let's go over the price.",
                "好",
                "Sounds good 那就這樣",
            ],
            95_000.0,
        );
        let text = transcript_text(&meta, &json!({}));
        let lines: Vec<&str> = text.lines().collect();
        assert!(lines[0].contains("estimated"));
        assert!(lines[1].starts_with("[0:00]"));
        assert!(lines[2].starts_with("[0:32]"));
        assert!(lines[3].starts_with("[1:00]"));
        assert!(lines[4].starts_with("[1:12]"));
        // Search hits carry the same seek targets.
        let hits = segment_hits(&meta, "price", 5);
        assert_eq!(hits[0]["atMs"], json!(32_801));
    }
}
