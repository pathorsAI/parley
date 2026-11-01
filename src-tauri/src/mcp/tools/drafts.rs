//! Meeting drafts — the meetings prepared ahead of time that 總覽 lists as
//! upcoming. RPCs into the frontend, which owns the saved drafts.

use serde_json::{json, Value};

use crate::mcp::registry::{tool, Domain, Handler};

pub(super) const DOMAIN: Domain = Domain {
    schemas,
    handlers: &[
        ("list_meeting_drafts", Handler::Forward(&[])),
        ("create_meeting_draft", Handler::ForwardWith(draft_args)),
    ],
};

/// The draft's fields, each passed on as given (`null` when absent); `agenda`,
/// when given, must be an array of strings.
fn draft_args(args: Value) -> anyhow::Result<Value> {
    let agenda = match args.get("agenda") {
        None | Some(Value::Null) => Value::Null,
        Some(Value::Array(items)) if items.iter().all(Value::is_string) => {
            Value::Array(items.clone())
        }
        Some(_) => anyhow::bail!("agenda must be an array of strings"),
    };
    let field = |key: &str| args.get(key).cloned().unwrap_or(Value::Null);
    Ok(json!({
        "title": field("title"),
        "startAt": field("startAt"),
        "endAt": field("endAt"),
        "reminderLeadMin": field("reminderLeadMin"),
        "context": field("context"),
        "folderId": field("folderId"),
        "agenda": agenda
    }))
}

fn schemas() -> Vec<Value> {
    vec![
        tool(
            "list_meeting_drafts",
            "List meeting drafts",
            "List the saved meeting drafts — the upcoming meetings the user has \
             prepared — as { id, title, startAt, endAt, reminderLeadMin, context, \
             folderId, agenda }. Times are ISO 8601 strings, or null for a draft \
             with no time yet.",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "create_meeting_draft",
            "Create a meeting draft",
            "Save a draft for an upcoming meeting. It appears under 即將開始 on \
             the home screen, reminds the user before its start time, and one \
             click starts recording with this preparation loaded. \
             Put everything the analysis should know into `context`: who attends \
             and their roles, the goal, history with this party. When the meeting \
             is a negotiation or a deal, ALWAYS also write the user's BATNA (best \
             alternative if no deal), target and bottom line into `context` as \
             plain lines, e.g. 'BATNA: …', 'Target: …', 'Bottom line: …' — \
             Parley has no separate fields for them. \
             `title` may be left out: a draft with a start time is then named \
             after it. Safe to call while a meeting is recording.",
            json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Meeting name. Optional." },
                    "startAt": { "type": "string", "description": "Start time, ISO 8601 with a UTC offset (e.g. 2026-11-03T14:00:00+08:00). Omit for an untimed draft." },
                    "endAt": { "type": "string", "description": "End time, ISO 8601. Defaults to one hour after startAt." },
                    "reminderLeadMin": { "type": "number", "description": "Minutes before the start to remind the user (default 5)." },
                    "context": { "type": "string", "description": "Background for the analysis, including any BATNA / target / bottom line." },
                    "folderId": { "type": "string", "description": "Personal folder to file the recording into (see list_folders)." },
                    "agenda": { "type": "array", "items": { "type": "string" }, "description": "Checklist items to cover in the meeting." }
                }
            }),
        ),
    ]
}
