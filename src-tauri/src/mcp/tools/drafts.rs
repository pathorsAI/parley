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

/// A list argument, passed on as given when every item passes `ok`; `null`
/// when absent.
fn list_arg(args: &Value, key: &str, ok: fn(&Value) -> bool, shape: &str) -> anyhow::Result<Value> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(Value::Null),
        Some(Value::Array(items)) if items.iter().all(ok) => Ok(Value::Array(items.clone())),
        Some(_) => anyhow::bail!("{key} must be an array of {shape}"),
    }
}

/// A playbook branch: `{ when, then }`, both strings.
fn is_branch(v: &Value) -> bool {
    v.get("when").is_some_and(Value::is_string) && v.get("then").is_some_and(Value::is_string)
}

/// The draft's fields, each passed on as given (`null` when absent); `agenda`,
/// `questions` (an alias the frontend appends to the agenda) and `topics`,
/// when given, must be arrays of strings, and `branches` an array of
/// `{ when, then }` string pairs.
fn draft_args(args: Value) -> anyhow::Result<Value> {
    let agenda = list_arg(&args, "agenda", Value::is_string, "strings")?;
    let questions = list_arg(&args, "questions", Value::is_string, "strings")?;
    let branches = list_arg(&args, "branches", is_branch, "{ when, then } objects with string values")?;
    let topics = list_arg(&args, "topics", Value::is_string, "strings")?;
    let field = |key: &str| args.get(key).cloned().unwrap_or(Value::Null);
    Ok(json!({
        "title": field("title"),
        "startAt": field("startAt"),
        "endAt": field("endAt"),
        "reminderLeadMin": field("reminderLeadMin"),
        "context": field("context"),
        "folderId": field("folderId"),
        "agenda": agenda,
        "questions": questions,
        "branches": branches,
        "topics": topics
    }))
}

fn schemas() -> Vec<Value> {
    vec![
        tool(
            "list_meeting_drafts",
            "List meeting drafts",
            "List the saved meeting drafts — the upcoming meetings the user has \
             prepared — as { id, title, startAt, endAt, reminderLeadMin, context, \
             folderId, agenda, branches, topics }. Times are ISO 8601 strings, \
             or null for a draft with no time yet. `agenda` is the things to ask \
             or cover in the meeting; `branches` ({ when, then }) and `topics` \
             are the draft's playbook. Live suggestions pick from all three \
             during the meeting.",
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
             List what to ask or cover in `agenda`, one item each (a question \
             written the way it would be said works well): the AI ticks items \
             as they come up, and live suggestions pick from the ones still \
             open. Optionally give the meeting a playbook as well: `branches` \
             for steering when the other side says something specific \
             ({ when: what they say, then: where to steer }), and `topics` to \
             bring up when the conversation runs dry. Up to 30 items each. \
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
                    "agenda": { "type": "array", "items": { "type": "string" }, "description": "The things to ask or cover in the meeting; the AI ticks them as they come up and live suggestions pick from the ones still open." },
                    "questions": { "type": "array", "items": { "type": "string" }, "description": "Alias of `agenda`: its items are appended to the agenda (skipping any already there). Prefer `agenda`." },
                    "branches": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "when": { "type": "string", "description": "What the other side says." },
                                "then": { "type": "string", "description": "Where to steer the conversation when they do." }
                            },
                            "required": ["when", "then"]
                        },
                        "description": "Playbook: if they say `when`, steer with `then`."
                    },
                    "topics": { "type": "array", "items": { "type": "string" }, "description": "Playbook: directions to explore when the conversation runs dry." }
                }
            }),
        ),
    ]
}
