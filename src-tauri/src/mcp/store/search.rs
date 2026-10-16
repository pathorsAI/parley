//! Full-text search across the saved recordings (`search_meetings`).

use serde_json::{json, Value};

use super::transcript::estimated_starts;
use super::{in_scope, read_entry_files};

/// Where a search hit landed. Ordered by how much a reader trusts it: a line
/// somebody actually said outranks a conclusion drawn from it.
const SEARCH_FIELDS: [&str; 5] = ["transcript", "brief", "finding", "actionItem", "context"];

/// Characters of surrounding text returned with each hit.
const SNIPPET_PAD: usize = 60;

/// One match, with enough context to read it without opening the recording.
fn hit(field: &str, text: &str, at: usize, query_len: usize, at_ms: Option<i64>) -> Value {
    // Slice on char boundaries — transcripts are mostly CJK here, so byte math
    // would panic mid-character.
    let chars: Vec<char> = text.chars().collect();
    let start = at.saturating_sub(SNIPPET_PAD);
    let end = (at + query_len + SNIPPET_PAD).min(chars.len());
    let mut snippet = chars[start..end].iter().collect::<String>();
    if start > 0 {
        snippet.insert(0, '…');
    }
    if end < chars.len() {
        snippet.push('…');
    }
    let mut out = json!({ "field": field, "snippet": snippet.trim() });
    if let Some(ms) = at_ms {
        out["atMs"] = json!(ms);
    }
    out
}

/// Case-insensitive char-index search (`str::find` returns a BYTE offset, which
/// the char-based snippet window can't use).
fn find_ci(haystack: &str, needle: &str) -> Option<usize> {
    let h: Vec<char> = haystack.to_lowercase().chars().collect();
    let n: Vec<char> = needle.chars().collect();
    if n.is_empty() || n.len() > h.len() {
        return None;
    }
    (0..=h.len() - n.len()).find(|&i| h[i..i + n.len()] == n[..])
}

/// Full-text search across saved recordings — the thing `list_recordings`'s
/// `query` can't do, since that only ever saw the title and the transcript's
/// FIRST line. Scans what was said (segments) plus what the analysis concluded
/// (brief, findings, action items, meeting context).
///
/// Reads every entry's `meta.json` per call rather than maintaining an index:
/// a personal library is hundreds of recordings at most, and a stale index that
/// silently misses a meeting is worse than a scan that takes a moment.
pub(in crate::mcp) fn search_meetings(
    history_dir: &std::path::Path,
    args: &Value,
) -> anyhow::Result<Value> {
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|q| !q.is_empty())
        .ok_or_else(|| anyhow::anyhow!("query is required"))?
        .to_lowercase();
    let folder = args.get("folderId").and_then(Value::as_str);
    let since = args.get("since").and_then(Value::as_i64).unwrap_or(0);
    let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(20) as usize;
    let per_recording = args
        .get("hitsPerRecording")
        .and_then(Value::as_u64)
        .unwrap_or(5) as usize;
    let qlen = query.chars().count();

    let mut results: Vec<Value> = Vec::new();
    let mut scanned = 0usize;
    for meta in read_entry_files(history_dir, "meta.json") {
        if !in_scope(&meta, folder, since) {
            continue;
        }
        scanned += 1;
        let mut hits = segment_hits(&meta, &query, qlen);
        hits.extend(summary_field_hits(&meta, &query, qlen));
        hits.extend(list_field_hits(&meta, &query, qlen));
        if hits.is_empty() {
            continue;
        }
        results.push(recording_hits(&meta, hits, per_recording));
    }
    // Recordings with the most to say about the query first; ties break newest.
    results.sort_by_key(|r| {
        (
            std::cmp::Reverse(r.get("hitCount").and_then(Value::as_i64).unwrap_or(0)),
            std::cmp::Reverse(r.get("createdAt").and_then(Value::as_i64).unwrap_or(0)),
        )
    });
    let matched = results.len();
    results.truncate(limit);
    Ok(json!({
        "query": query,
        "scanned": scanned,
        "matched": matched,
        "returned": results.len(),
        "recordings": results,
    }))
}

/// What was said. Segment-level so each hit carries a seek target.
pub(super) fn segment_hits(meta: &Value, query: &str, qlen: usize) -> Vec<Value> {
    let Some(segs) = meta.get("segments").and_then(Value::as_array) else {
        return Vec::new();
    };
    // An untimed transcript (#576) would put every hit at 0; use the same
    // estimate the app shows, so the seek target matches its clock.
    let estimated = estimated_starts(meta, segs);
    segs.iter()
        .enumerate()
        .filter_map(|(i, s)| {
            let text = s.get("text").and_then(Value::as_str).unwrap_or("");
            let at = find_ci(text, query)?;
            let at_ms = match &estimated {
                Some(starts) => Some(starts[i]),
                None => s.get("startMs").and_then(Value::as_i64),
            };
            Some(hit("transcript", text, at, qlen, at_ms))
        })
        .collect()
}

/// What the analysis concluded, in the single-string fields.
fn summary_field_hits(meta: &Value, query: &str, qlen: usize) -> Vec<Value> {
    [
        ("brief", meta.get("brief").and_then(Value::as_str)),
        (
            "context",
            meta.get("meetingContext").and_then(Value::as_str),
        ),
    ]
    .into_iter()
    .filter_map(|(field, text)| {
        let text = text?;
        let at = find_ci(text, query)?;
        Some(hit(field, text, at, qlen, None))
    })
    .collect()
}

/// What the analysis concluded, in the list fields (findings, action items).
/// Each item's parts are joined so a query spanning title and detail still hits.
fn list_field_hits(meta: &Value, query: &str, qlen: usize) -> Vec<Value> {
    let mut hits: Vec<Value> = Vec::new();
    // Slices, not fixed-size arrays: the two entries no longer search the same
    // number of fields (an action item is just its text now).
    for (field, key, parts) in [
        ("finding", "findings", &["title", "detail"][..]),
        ("actionItem", "actionItems", &["text"][..]),
    ] {
        for item in meta
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let text = parts
                .iter()
                .filter_map(|p| item.get(*p).and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(" — ");
            if let Some(at) = find_ci(&text, query) {
                hits.push(hit(
                    field,
                    &text,
                    at,
                    qlen,
                    item.get("atMs").and_then(Value::as_i64),
                ));
            }
        }
    }
    hits
}

/// One recording's search result: its identity plus the best `per_recording`
/// hits, most-trusted field first and chronological within a field.
fn recording_hits(meta: &Value, mut hits: Vec<Value>, per_recording: usize) -> Value {
    let total = hits.len();
    hits.sort_by_key(|h| {
        let f = h.get("field").and_then(Value::as_str).unwrap_or("");
        let rank = SEARCH_FIELDS.iter().position(|x| *x == f).unwrap_or(9);
        (rank, h.get("atMs").and_then(Value::as_i64).unwrap_or(0))
    });
    hits.truncate(per_recording);
    json!({
        "id": meta.get("id").cloned().unwrap_or(Value::Null),
        "title": meta.get("title").cloned().unwrap_or(Value::Null),
        "createdAt": meta.get("createdAt").cloned().unwrap_or(Value::Null),
        "folderId": meta.get("folderId").cloned().unwrap_or(Value::Null),
        "hitCount": total,
        "hits": hits,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_ci_is_case_insensitive_and_char_indexed() {
        assert_eq!(find_ci("Hello World", "world"), Some(6));
        // CJK: the index must be in CHARS, not bytes — the snippet window
        // slices on it, and byte math would land mid-character and panic.
        assert_eq!(find_ci("我們聊到東森的席數", "東森"), Some(4));
        assert_eq!(find_ci("nothing here", "absent"), None);
        assert_eq!(find_ci("short", "a much longer needle"), None);
        assert_eq!(find_ci("anything", ""), None);
    }

    #[test]
    fn hit_windows_around_the_match_without_splitting_characters() {
        let text = "前".repeat(100) + "東森" + &"後".repeat(100);
        let at = find_ci(&text, "東森").unwrap();
        let h = hit("transcript", &text, at, 2, Some(1500));
        let snippet = h["snippet"].as_str().unwrap();
        assert!(snippet.contains("東森"));
        assert!(snippet.starts_with('…') && snippet.ends_with('…'));
        assert_eq!(h["atMs"], json!(1500));
        assert_eq!(h["field"], json!("transcript"));
    }

    #[test]
    fn hit_omits_ellipsis_at_the_text_edges_and_atms_when_absent() {
        let h = hit("brief", "東森 outbound", 0, 2, None);
        let snippet = h["snippet"].as_str().unwrap();
        assert!(
            !snippet.starts_with('…'),
            "no leading … at the start of the text"
        );
        assert!(
            !snippet.ends_with('…'),
            "no trailing … at the end of the text"
        );
        assert!(h.get("atMs").is_none());
    }

    #[test]
    fn search_requires_a_non_empty_query() {
        let dir = std::path::Path::new("/nonexistent");
        assert!(search_meetings(dir, &json!({})).is_err());
        assert!(search_meetings(dir, &json!({ "query": "   " })).is_err());
    }
}
