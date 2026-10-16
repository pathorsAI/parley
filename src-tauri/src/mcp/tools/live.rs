//! The live meeting's checklist, evaluations and timeline findings. Reads come
//! from the session snapshot; every change is a command queued for the
//! frontend, which owns that state and applies it on its next poll.

use serde_json::{json, Value};

use super::app_context::read_session;
use super::finding_schema;
use crate::mcp::bridge::append_command;
use crate::mcp::context::{required_str, McpContext};
use crate::mcp::registry::{tool, Domain, Handler};

pub(super) const DOMAIN: Domain = Domain {
    schemas,
    handlers: &[
        (
            "list_todos",
            Handler::Local(|state, _| Ok(snapshot_list(state, "todos"))),
        ),
        (
            "list_evaluations",
            Handler::Local(|state, _| Ok(snapshot_list(state, "evaluations"))),
        ),
        (
            "add_todo",
            Handler::Local(|state, args| {
                append_command(
                    state,
                    "add_todo",
                    json!({ "text": required_str(&args, "text")? }),
                )
            }),
        ),
        (
            "check_todo",
            Handler::Local(|state, args| {
                append_command(
                    state,
                    "check_todo",
                    json!({
                        "id": required_str(&args, "id")?,
                        "done": args.get("done").and_then(Value::as_bool).unwrap_or(true)
                    }),
                )
            }),
        ),
        (
            "remove_todo",
            Handler::Local(|state, args| {
                append_command(
                    state,
                    "remove_todo",
                    json!({ "id": required_str(&args, "id")? }),
                )
            }),
        ),
        (
            "add_evaluation",
            Handler::Local(|state, args| {
                append_command(
                    state,
                    "add_evaluation",
                    json!({
                        "name": required_str(&args, "name")?,
                        "description": args.get("description").and_then(Value::as_str).unwrap_or(""),
                        "prompt": required_str(&args, "prompt")?
                    }),
                )
            }),
        ),
        (
            "remove_evaluation",
            Handler::Local(|state, args| {
                append_command(
                    state,
                    "remove_evaluation",
                    json!({ "id": required_str(&args, "id")? }),
                )
            }),
        ),
        (
            "list_findings",
            Handler::Local(|state, _| Ok(snapshot_list(state, "findings"))),
        ),
        (
            "add_finding",
            Handler::Local(|state, args| append_command(state, "add_finding", args)),
        ),
        (
            "set_findings",
            Handler::Local(|state, args| {
                append_command(
                    state,
                    "set_findings",
                    json!({ "events": args.get("events").cloned().unwrap_or_else(|| json!([])) }),
                )
            }),
        ),
        (
            "update_finding",
            Handler::Local(|state, args| {
                required_str(&args, "id")?; // validate before queueing the raw patch
                append_command(state, "update_finding", args)
            }),
        ),
        (
            "remove_finding",
            Handler::Local(|state, args| {
                append_command(
                    state,
                    "remove_finding",
                    json!({ "id": required_str(&args, "id")? }),
                )
            }),
        ),
    ],
};

/// One list from the session snapshot (empty when absent).
fn snapshot_list(state: &McpContext, key: &str) -> Value {
    read_session(&state.session_path)
        .get(key)
        .cloned()
        .unwrap_or_else(|| json!([]))
}

fn schemas() -> Vec<Value> {
    vec![
        tool(
            "list_todos",
            "List live todos",
            "List the current meeting's checklist items as { id, text, done }.",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "list_evaluations",
            "List live evaluations",
            "List the current meeting's evaluations with their latest results: \
             { id, name, description, status, lastRunAt, result }. Results are Parley's \
             own automated reads of the transcript — context you may second-guess, not \
             verdicts.",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "add_todo",
            "Add a live todo",
            "Add a checklist item to the current meeting. Applied within ~1.5s.",
            json!({ "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] }),
        ),
        tool(
            "check_todo",
            "Check or uncheck a live todo",
            "Mark a checklist item done (or not) by id. Get ids from list_todos.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "done": { "type": "boolean", "description": "true to check, false to uncheck (default true)" }
                },
                "required": ["id"]
            }),
        ),
        tool(
            "remove_todo",
            "Remove a live todo",
            "Remove a checklist item from the current meeting by id.",
            json!({ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }),
        ),
        tool(
            "add_evaluation",
            "Add a live evaluation",
            "Add an evaluation to the current meeting so it runs on the transcript. \
             Provide a short name, a description, and the prompt describing what to watch for.",
            json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "description": { "type": "string" },
                    "prompt": { "type": "string" }
                },
                "required": ["name", "prompt"]
            }),
        ),
        tool(
            "remove_evaluation",
            "Remove a live evaluation",
            "Remove an evaluation from the current meeting by id. Get ids from list_evaluations.",
            json!({ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }),
        ),
        tool(
            "list_findings",
            "List timeline-analysis findings",
            "List the loaded session's timeline-analysis findings (the markers on the \
             replay timeline) as TimelineEvent objects: \
             { id, atMs, side, severity, source, title, detail, quotes?, evalIds?, resolved?, resolution? }. \
             These come from Parley's own analysis pass — treat them as context to build \
             on or challenge, not as settled conclusions.",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "add_finding",
            "Add one timeline-analysis finding",
            "Insert a SINGLE finding without touching the rest of the list (unlike set_findings, \
             which replaces everything). The new marker is placed in chronological order by atMs. \
             Applied within ~1.5s. Omit id to mint a new one.",
            finding_schema(),
        ),
        tool(
            "set_findings",
            "Overwrite timeline-analysis findings",
            "Replace the ENTIRE timeline-analysis findings list with the provided events \
             (the markers shown on the replay timeline). Applied within ~1.5s. Use list_findings \
             first to see the current set. Omit an event id to mint a new one.",
            json!({
                "type": "object",
                "properties": {
                    "events": {
                        "type": "array",
                        "description": "The full findings list to render on the timeline.",
                        "items": finding_schema()
                    }
                },
                "required": ["events"]
            }),
        ),
        tool(
            "update_finding",
            "Edit one timeline-analysis finding",
            "Patch a single timeline-analysis finding by id. Pass the id plus only the fields to \
             change; the id itself cannot be changed. Get ids from list_findings.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "atMs": { "type": "number", "description": "Moment on the recording timeline (ms)." },
                    "side": { "type": "string", "enum": ["me", "them"] },
                    "category": { "type": "string", "enum": ["decision", "open", "fact"] },
                    "severity": { "type": "string", "enum": ["info", "warn", "critical"] },
                    "source": { "type": "string", "enum": ["eval", "extra"] },
                    "title": { "type": "string" },
                    "detail": { "type": "string" },
                    "quotes": { "type": "array", "items": { "type": "string" } },
                    "evalIds": { "type": "array", "items": { "type": "string" } },
                    "resolved": { "type": "boolean" },
                    "resolution": { "type": "string" },
                    "author": { "type": "string" }
                },
                "required": ["id"]
            }),
        ),
        tool(
            "remove_finding",
            "Remove one timeline-analysis finding",
            "Delete a single timeline-analysis finding by id. Get ids from list_findings.",
            json!({ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }),
        ),
    ]
}
