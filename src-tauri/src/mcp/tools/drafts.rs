//! Meeting drafts — the meetings prepared ahead of time that 總覽 lists as
//! upcoming. RPCs into the frontend, which owns the saved drafts.

use serde_json::{json, Value};

use crate::mcp::registry::{tool, Domain, Field, Handler};

pub(super) const DOMAIN: Domain = Domain {
    schemas,
    handlers: &[
        ("list_meeting_drafts", Handler::Forward(&[Field::Optional("includeRemoved")])),
        ("create_meeting_draft", Handler::ForwardWith(draft_args)),
        ("update_meeting_draft", Handler::ForwardWith(draft_patch_args)),
        ("delete_meeting_draft", Handler::Forward(&[Field::Required("id")])),
        ("restore_meeting_draft", Handler::Forward(&[Field::Required("id")])),
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
/// `questions` (an alias the frontend appends to the agenda), `topics` and
/// `smallTalk`, when given, must be arrays of strings, and `branches` an array
/// of `{ when, then }` string pairs.
fn draft_args(args: Value) -> anyhow::Result<Value> {
    let agenda = list_arg(&args, "agenda", Value::is_string, "strings")?;
    let questions = list_arg(&args, "questions", Value::is_string, "strings")?;
    let branches = list_arg(&args, "branches", is_branch, "{ when, then } objects with string values")?;
    let topics = list_arg(&args, "topics", Value::is_string, "strings")?;
    let small_talk = list_arg(&args, "smallTalk", Value::is_string, "strings")?;
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
        "topics": topics,
        "opening": field("opening"),
        "smallTalk": small_talk
    }))
}

/// A list argument's key, the check each item must pass, and how to describe
/// the expected shape.
type ListRule = (&'static str, fn(&Value) -> bool, &'static str);

/// An update's arguments: the draft's `id`, and only the fields the call
/// carries, so the frontend can tell "leave as is" (absent) from "clear"
/// (`null`). The lists are checked as `draft_args` checks them; a `null` list
/// counts as absent.
fn draft_patch_args(args: Value) -> anyhow::Result<Value> {
    let id = args
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| anyhow::anyhow!("id is required"))?;
    let mut out = serde_json::Map::new();
    out.insert("id".to_string(), json!(id));
    for key in ["title", "startAt", "endAt", "reminderLeadMin", "context", "folderId", "opening"] {
        if let Some(value) = args.get(key) {
            out.insert(key.to_string(), value.clone());
        }
    }
    let lists: [ListRule; 5] = [
        ("agenda", Value::is_string, "strings"),
        ("questions", Value::is_string, "strings"),
        ("branches", is_branch, "{ when, then } objects with string values"),
        ("topics", Value::is_string, "strings"),
        ("smallTalk", Value::is_string, "strings"),
    ];
    for (key, ok, shape) in lists {
        let list = list_arg(&args, key, ok, shape)?;
        if !list.is_null() {
            out.insert(key.to_string(), list);
        }
    }
    Ok(Value::Object(out))
}

/// The playbook's `branches` schema, shared by create and update.
fn branches_schema(description: &str) -> Value {
    json!({
        "type": "array",
        "items": {
            "type": "object",
            "properties": {
                "when": { "type": "string", "description": "What the other side says." },
                "then": { "type": "string", "description": "Where to steer the conversation when they do." }
            },
            "required": ["when", "then"]
        },
        "description": description
    })
}

/// One property of a tool's input schema.
fn prop(kind: Value, description: &str) -> Value {
    json!({ "type": kind, "description": description })
}

/// A property holding a list of strings.
fn strings(description: &str) -> Value {
    json!({ "type": "array", "items": { "type": "string" }, "description": description })
}

/// How to write `opening`, shared by create and update.
const OPENING_HELP: &str = "The standard opening, one passage the user can read aloud as is in the first \
     minute: thank them for the time, say how long the meeting runs, name the two or three things to cover, \
     and ask whether that works (e.g. '謝謝今天撥空，我們大概三十分鐘，想先聊導入進度、再看報價，\
     最後確認下一步，這樣可以嗎？'). Written in the language the meeting is held in, in the user's own \
     voice, up to 600 characters. Parley shows it word for word from the first second of the meeting. On \
     update it replaces the current text; an empty string clears it.";

/// How to write `smallTalk`, shared by create and update.
const SMALL_TALK_HELP: &str = "Small talk for before the opening: up to 8 lines, each one complete sentence \
     the user could say as is, specific to the people in this meeting — something they mentioned last time \
     (a trip, a launch, a busy season), not a generic greeting (e.g. '上次說要去北海道，後來去了嗎？'). \
     Shown above the opening. Leave out anything sensitive (health, family trouble). On update it replaces \
     the whole list; an empty array clears it.";

/// The input of a tool that takes one draft's `id` and nothing else.
fn id_schema(description: &str) -> Value {
    json!({ "type": "object", "properties": { "id": prop(json!("string"), description) }, "required": ["id"] })
}

/// `update_meeting_draft`'s input: the draft's `id`, and any field to change.
fn update_schema() -> Value {
    let text = || json!("string");
    let clearable = || json!(["string", "null"]);
    let properties: [(&str, Value); 13] = [
        ("id", prop(text(), "The draft to change (see list_meeting_drafts).")),
        ("title", prop(text(), "Meeting name.")),
        ("startAt", prop(clearable(), "Start time, ISO 8601 with a UTC offset (e.g. 2026-11-03T14:00:00+08:00). null makes the draft untimed.")),
        ("endAt", prop(clearable(), "End time, ISO 8601. Must be after the start.")),
        ("reminderLeadMin", prop(json!("number"), "Minutes before the start to remind the user.")),
        ("context", prop(text(), "Background for the analysis, including any BATNA / target / bottom line. Replaces the current text.")),
        ("folderId", prop(clearable(), "Personal folder to file the recording into (see list_folders); null for none.")),
        ("agenda", strings("The whole agenda: the things to ask or cover in the meeting.")),
        ("questions", strings("Items to add to the agenda (skipping any already there).")),
        ("branches", branches_schema("Playbook: if they say `when`, steer with `then`. Replaces the whole list.")),
        ("topics", strings("Playbook: what to bring up when the conversation runs dry, each one complete sentence the user could say as is. Replaces the whole list.")),
        ("opening", prop(text(), OPENING_HELP)),
        ("smallTalk", strings(SMALL_TALK_HELP)),
    ];
    let properties: serde_json::Map<String, Value> =
        properties.into_iter().map(|(key, schema)| (key.to_string(), schema)).collect();
    json!({ "type": "object", "properties": properties, "required": ["id"] })
}

fn schemas() -> Vec<Value> {
    vec![
        tool(
            "list_meeting_drafts",
            "List meeting drafts",
            "List the saved meeting drafts — the upcoming meetings the user has \
             prepared — as { id, title, startAt, endAt, reminderLeadMin, context, \
             folderId, agenda, branches, topics, opening, smallTalk }. Times \
             are ISO 8601 strings, or null for a draft with no time yet. \
             `agenda` is the things to ask or cover in the meeting; `branches` \
             ({ when, then }) and `topics` are the draft's playbook. Live \
             suggestions pick from all three during the meeting. `opening` \
             (the standard opening) and `smallTalk` are shown from the \
             meeting's first second. A draft whose time has passed stays \
             listed until it is recorded or deleted. A draft LEAVES this list \
             when the user starts recording from it (its preparation moves \
             into that meeting), when it is deleted, or when another device \
             does either; pass includeRemoved: true to also get those, each \
             with `removedAt` and `removedReason` ('recorded', 'deleted' or \
             'elsewhere'), and bring one back with restore_meeting_draft.",
            json!({
                "type": "object",
                "properties": {
                    "includeRemoved": { "type": "boolean", "description": "Also list the drafts that recently left the list (the last 20)." }
                }
            }),
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
             ({ when: what they say, then: where to steer }), and `topics`, each a full \
             sentence the user could say as is, to \
             bring up when the conversation runs dry. Up to 30 items each. \
             EVERY draft should also carry how the meeting starts: `opening`, \
             the standard opening to read aloud, and `smallTalk`, a few lines \
             of small talk for before it. Before writing `smallTalk`, look up \
             what is known about the attendees — search_meetings for their \
             names and read the recent recordings with them — and build each \
             line on something they actually said. \
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
                    "branches": branches_schema("Playbook: if they say `when`, steer with `then`."),
                    "topics": { "type": "array", "items": { "type": "string" }, "description": "Playbook: what to bring up when the conversation runs dry, each written as one complete sentence the user could say as is (e.g. '最近洗碗機旺季，你們晚上的電話是不是也變多了？'), not a bare topic — Parley shows it word for word mid-meeting." },
                    "opening": { "type": "string", "description": OPENING_HELP },
                    "smallTalk": { "type": "array", "items": { "type": "string" }, "description": SMALL_TALK_HELP }
                }
            }),
        ),
        tool(
            "update_meeting_draft",
            "Update a meeting draft",
            "Change a saved meeting draft (id from list_meeting_drafts). Only \
             the fields you pass change. `agenda` replaces the whole checklist; \
             an item whose text is unchanged keeps its checked state. \
             `questions` (an alias) adds items to the agenda instead. \
             `branches` and `topics` each replace that whole playbook list; \
             pass an empty array to clear one. `opening` replaces the \
             standard opening and `smallTalk` the small-talk lines. Moving `startAt` without `endAt` \
             keeps the meeting's length; `startAt: null` makes the draft \
             untimed. Returns the updated draft. Safe to call while a meeting \
             is recording. A draft the user has already started recording \
             from is no longer in the list: the error says so, and \
             restore_meeting_draft brings it back.",
            update_schema(),
        ),
        tool(
            "delete_meeting_draft",
            "Delete a meeting draft",
            "Delete a saved meeting draft (id from list_meeting_drafts). It \
             leaves 即將開始 and its reminder is cancelled. Recordings are not \
             affected. It can be brought back with restore_meeting_draft.",
            id_schema("The draft to delete (see list_meeting_drafts)."),
        ),
        tool(
            "restore_meeting_draft",
            "Restore a meeting draft",
            "Bring back a meeting draft that left the list — recorded from, \
             deleted, or removed on another device (ids from \
             list_meeting_drafts with includeRemoved: true). It returns to \
             即將開始 with the preparation it had, on every device the user \
             syncs. Returns the restored draft.",
            id_schema("The removed draft to bring back."),
        ),
    ]
}
