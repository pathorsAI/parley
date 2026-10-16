//! What the user is looking at: the session snapshot the frontend writes to
//! `session.json` (live meeting, post-meeting, replay, library or settings),
//! read as opaque JSON whose schema the frontend owns.

use std::path::PathBuf;

use serde_json::{json, Value};

use crate::mcp::context::{McpContext, ANALYSIS_NOTE};
use crate::mcp::registry::{tool, Domain, Handler};
use crate::mcp::store;

pub(super) const DOMAIN: Domain = Domain {
    schemas,
    handlers: &[
        (
            "get_app_context",
            Handler::Local(|state, _| Ok(focus_context(&read_session(&state.session_path)))),
        ),
        (
            "get_focused_content",
            Handler::Local(|state, _| Ok(focused_content(state))),
        ),
        (
            "get_session_status",
            Handler::Local(|state, _| Ok(session_status(&state.session_path))),
        ),
        (
            "get_transcript",
            Handler::Local(|state, _| Ok(transcript(&state.session_path))),
        ),
    ],
};

fn schemas() -> Vec<Value> {
    vec![
        tool(
            "get_app_context",
            "Get what the user is looking at",
            "ALWAYS CALL THIS FIRST to know what the user is focused on. Returns focus \
             (live / replay / library), meetingStatus, and — when the user is reviewing a \
             recording — which one. IMPORTANT: meetingStatus 'stopped' means the last live \
             meeting ENDED; if focus is 'replay' the user is reviewing a SAVED recording, \
             not sitting in a meeting. Never assume a meeting is happening unless \
             meetingStatus is 'recording'.",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "get_focused_content",
            "Get the content the user is viewing",
            "Get the data behind whatever screen the user is on right now, plus the focus \
             context: the transcript and EVERYTHING Parley's own analysis produced for it \
             (findings, study brief, action items, delivery assessment; live mode adds \
             todos and evaluations). Those analysis artifacts are CONTEXT from \
             Parley's earlier passes, not ground truth — when giving advice, reason from \
             the transcript yourself and feel free to challenge or go beyond them. Use \
             this to give advice about what the user is currently seeing.",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "get_session_status",
            "Get live session status",
            "Get the current Parley meeting state: meetingStatus (idle/recording/stopped), \
             when it was last updated, counts of transcript segments, todos, evaluations, \
             and timeline-analysis findings — plus the focus context (live vs replay). \
             'stopped' = the last meeting has ENDED, not an active meeting.",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "get_transcript",
            "Get the loaded transcript",
            "Get the transcript currently loaded in the app, labelled by speaker. During a \
             live meeting this is the live transcript so far; in replay it is the transcript \
             of the recording being reviewed; after a meeting ends it is the finished \
             meeting's transcript. Check the returned context to know which one you got.",
            json!({ "type": "object", "properties": {} }),
        ),
    ]
}

/// The loaded transcript, with the focus context that says whose it is.
fn transcript(path: &PathBuf) -> Value {
    let s = read_session(path);
    let transcript = s
        .get("transcript")
        .cloned()
        .unwrap_or_else(|| json!({ "text": "", "segmentCount": 0 }));
    json!({ "context": focus_context(&s), "transcript": transcript })
}

/// Read the frontend-written session snapshot as opaque JSON (empty object if
/// no meeting has written one yet). The schema is owned by the frontend.
pub(super) fn read_session(path: &PathBuf) -> Value {
    match std::fs::read_to_string(path) {
        Ok(raw) if !raw.trim().is_empty() => {
            serde_json::from_str(&raw).unwrap_or_else(|_| json!({}))
        }
        _ => json!({}),
    }
}

/// Compact status summary derived from the session snapshot.
fn session_status(path: &PathBuf) -> Value {
    let s = read_session(path);
    let count = |key: &str| s.get(key).and_then(Value::as_array).map_or(0, |a| a.len());
    json!({
        "context": focus_context(&s),
        "meetingStatus": s.get("meetingStatus").cloned().unwrap_or_else(|| json!("idle")),
        "updatedAt": s.get("updatedAt").cloned().unwrap_or(Value::Null),
        "segmentCount": s.pointer("/transcript/segmentCount").cloned().unwrap_or_else(|| json!(0)),
        "todoCount": count("todos"),
        "evalCount": count("evaluations"),
        "findingCount": count("findings"),
    })
}

/// The focus context derived from the snapshot's `context` block (written by the
/// frontend): which screen the user is on, whether a meeting is truly active, and
/// which recording is loaded in replay. `focusSummary` spells out the situation in
/// prose so an MCP client can't misread "stopped + transcript" as a live meeting.
fn focus_context(s: &Value) -> Value {
    let app_mode = s
        .pointer("/context/appMode")
        .and_then(Value::as_str)
        .unwrap_or("live");
    let meeting_status = s
        .get("meetingStatus")
        .and_then(Value::as_str)
        .unwrap_or("idle");
    let replay = s.pointer("/context/replay").cloned().unwrap_or(Value::Null);
    let study_tab = s
        .pointer("/context/studyTab")
        .cloned()
        .unwrap_or(Value::Null);

    let focus = match app_mode {
        "replay" => "replay",
        // Since the app shell landed (#195) the recordings library and settings
        // are routes in the main window rather than separate windows, so they
        // show up here. Neither has content loaded — say so rather than letting
        // them fall through to a meeting-status guess.
        "library" => "library",
        "settings" => "settings",
        _ => match meeting_status {
            // A paused meeting is still THE live meeting (capture held, resume
            // is one click) — same focus, the summary spells out the pause.
            "recording" | "paused" => "live-meeting",
            "stopped" => "live-post-meeting",
            _ => "idle",
        },
    };
    let summary = match focus {
        "replay" => {
            let name = replay
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("(unnamed)");
            let saved = replay.get("savedHistoryId").and_then(Value::as_str);
            format!(
                "The user is REVIEWING a saved recording ('{name}'{}) in the replay/study \
                 screen — they are NOT in a live meeting (the last meeting, if any, already \
                 ended). The transcript and findings in this session snapshot belong to that \
                 recording.",
                match saved {
                    Some(id) => format!(", history id {id}"),
                    None => ", not saved to the local library".to_string(),
                }
            )
        }
        "library" => "The user is browsing the saved-recordings library — no meeting is \
                      active and no recording is loaded."
            .to_string(),
        "settings" => "The user is in Settings — no meeting is active and no recording is \
                       loaded."
            .to_string(),
        "live-meeting" => {
            if meeting_status == "paused" {
                "A live meeting is in progress but PAUSED — audio is not being \
                 transcribed or recorded until the user resumes. The transcript \
                 below covers the meeting so far."
                    .to_string()
            } else {
                "A live meeting is being recorded RIGHT NOW; the transcript below \
                 is growing in real time."
                    .to_string()
            }
        }
        "live-post-meeting" => "No meeting is active: the last live meeting has ENDED and \
                                the user is looking at its post-meeting state. The transcript \
                                and findings below are from that finished meeting — do not \
                                treat it as ongoing."
            .to_string(),
        _ => "Nothing is happening: no meeting is active and no recording is loaded.".to_string(),
    };
    json!({
        "focus": focus,
        "appMode": app_mode,
        "meetingStatus": meeting_status,
        "studyTab": study_tab,
        "replay": replay,
        "updatedAt": s.get("updatedAt").cloned().unwrap_or(Value::Null),
        "focusSummary": summary,
    })
}

/// What the user is looking at, with its content AND everything Parley's own
/// analysis has produced for it. The snapshot fields already track the loaded
/// content (in replay mode the store — and therefore the snapshot — holds the
/// replayed recording's transcript, findings, brief, action items, and
/// delivery assessment), so one read covers live, post-meeting, and replay. For
/// a saved replay, `meta.json` backfills anything the snapshot doesn't carry.
fn focused_content(state: &McpContext) -> Value {
    let s = read_session(&state.session_path);
    let ctx = focus_context(&s);
    let focus = ctx.get("focus").and_then(Value::as_str).unwrap_or("idle");
    let mut out = serde_json::Map::new();
    out.insert("context".into(), ctx.clone());
    out.insert("analysisNote".into(), json!(ANALYSIS_NOTE));
    out.insert(
        "transcript".into(),
        s.get("transcript")
            .cloned()
            .unwrap_or_else(|| json!({ "text": "", "segmentCount": 0 })),
    );
    out.insert(
        "findings".into(),
        s.get("findings").cloned().unwrap_or_else(|| json!([])),
    );
    // Every analysis artifact the app has for the loaded content.
    copy_missing_keys(
        &mut out,
        &s,
        &["brief", "actionItems", "deliveryAssessment"],
    );
    if focus == "live-meeting" || focus == "live-post-meeting" {
        out.insert(
            "todos".into(),
            s.get("todos").cloned().unwrap_or_else(|| json!([])),
        );
        out.insert(
            "evaluations".into(),
            s.get("evaluations").cloned().unwrap_or_else(|| json!([])),
        );
    }
    if focus == "replay" {
        add_replay_extras(&mut out, &ctx, &state.history_dir);
    }
    Value::Object(out)
}

/// Copy each non-null `keys` entry from `src` into `out`, leaving whatever `out`
/// already carries untouched.
fn copy_missing_keys(out: &mut serde_json::Map<String, Value>, src: &Value, keys: &[&str]) {
    for key in keys {
        if out.contains_key(*key) {
            continue;
        }
        if let Some(v) = src.get(*key) {
            if !v.is_null() {
                out.insert((*key).to_string(), v.clone());
            }
        }
    }
}

/// For a replay, backfill from `meta.json` anything the snapshot didn't carry
/// (e.g. a snapshot written by an older app version). A recording that isn't in
/// the local library gets a note saying so instead.
fn add_replay_extras(
    out: &mut serde_json::Map<String, Value>,
    ctx: &Value,
    history_dir: &std::path::Path,
) {
    let Some(id) = ctx
        .pointer("/replay/savedHistoryId")
        .and_then(Value::as_str)
    else {
        out.insert(
            "note".into(),
            json!(
                "This recording is not in the local library (an unsaved upload or an \
                       org recording viewed read-only), so saved extras like action items \
                       are unavailable here."
            ),
        );
        return;
    };
    if let Ok(meta) = store::read_meta(history_dir, id) {
        copy_missing_keys(
            out,
            &meta,
            &["title", "brief", "actionItems", "deliveryAssessment"],
        );
    }
}
