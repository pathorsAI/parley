//! Personal recordings: the local library (read here, from disk), the
//! personal cloud mirror, and edits to a recording (made by the frontend,
//! which owns the library's index).

use serde_json::{json, Value};

use super::finding_schema;
use crate::mcp::context::required_str;
use crate::mcp::registry::{tool, Domain, Field, Handler};
use crate::mcp::store;

pub(super) const DOMAIN: Domain = Domain {
    schemas,
    handlers: &[
        (
            "list_recordings",
            Handler::Local(|state, args| store::list_recordings(&state.history_dir, &args)),
        ),
        // The personal cloud mirror lives behind the account's bearer token, which
        // only the frontend holds — so both of these are RPCs into the app.
        (
            "list_cloud_recordings",
            Handler::Forward(&[
                Field::Optional("query"),
                Field::Optional("since"),
                Field::Optional("limit"),
                Field::Optional("pending"),
            ]),
        ),
        (
            "download_cloud_recording",
            Handler::Forward(&[Field::Required("id")]),
        ),
        (
            "search_meetings",
            Handler::Local(|state, args| store::search_meetings(&state.history_dir, &args)),
        ),
        (
            "get_recording",
            Handler::Local(|state, args| {
                store::get_recording(&state.history_dir, required_str(&args, "id")?)
            }),
        ),
        (
            "rename_recording",
            Handler::Forward(&[Field::Required("id"), Field::Required("title")]),
        ),
        // The frontend validates the rest of the patch.
        ("update_recording_meta", Handler::ForwardWith(with_id)),
        // The frontend normalizes findings/actionItems.
        ("set_recording_analysis", Handler::ForwardWith(with_id)),
    ],
};

/// The arguments untouched, once they name a recording.
fn with_id(args: Value) -> anyhow::Result<Value> {
    required_str(&args, "id")?;
    Ok(args)
}

fn schemas() -> Vec<Value> {
    vec![
        tool(
            "list_recordings",
            "List saved recordings (history)",
            "List the user's locally saved recordings (the personal history library), \
             newest first, as summary cards: { id, title, source, createdAt, durationMs, \
             speakerCount, findingsCount, actionItemsCount, hasAudio, analyzed?, snippet, \
             folderId }. `analyzed` mirrors the entry's pipeline-complete flag (absent on \
             cards saved before it existed = state unknown). Optional text query filters by \
             title + transcript snippet; `since` keeps only recordings created at/after that \
             epoch-ms timestamp — the cheap way for an external analyst to poll for new \
             recordings. This is THIS DEVICE only: recordings made on the user's other \
             devices sit in the cloud until pulled down — find those with \
             list_cloud_recordings. Org-shared recordings live in the cloud too — list \
             those with list_org_recordings.",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Case-insensitive text filter over title + snippet." },
                    "folderId": { "type": "string", "description": "Only recordings in this personal folder (get ids from list_folders)." },
                    "since": { "type": "number", "description": "Only recordings with createdAt >= this epoch-ms timestamp." },
                    "limit": { "type": "number", "description": "Max results (default 50)." }
                }
            }),
        ),
        tool(
            "list_cloud_recordings",
            "List the account's recordings across all devices",
            "List the signed-in account's PERSONAL cloud mirror — including recordings \
             made on the user's other devices, which never appear in list_recordings \
             until downloaded. Same summary cards as list_recordings plus `sync`: \
             \"cloud\" (only on another device — not on this one yet), \"stale\" (a local \
             copy exists but the cloud one is newer, e.g. another device re-analyzed \
             it), or \"synced\" (this device is current). Pass pending: true for exactly \
             the set this device is missing or behind on. Pull one down with \
             download_cloud_recording. Requires the user to be signed in with sync \
             enabled. This is the personal library — an org's shared space is \
             list_org_recordings.",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Case-insensitive text filter over title + snippet." },
                    "since": { "type": "number", "description": "Only recordings with createdAt >= this epoch-ms timestamp." },
                    "limit": { "type": "number", "description": "Max results (default 50)." },
                    "pending": { "type": "boolean", "description": "Only what this device lacks: sync is \"cloud\" or \"stale\"." }
                }
            }),
        ),
        tool(
            "download_cloud_recording",
            "Download one of the account's cloud recordings to this device",
            "Pull a recording from the account's personal cloud onto THIS device — the \
             transcript, the saved analysis, and the audio when the cloud copy has it. \
             Afterwards it is a normal local recording: it shows up in list_recordings, \
             is readable with get_recording, searchable with search_meetings, and \
             openable in replay. Re-downloading a \"stale\" entry refreshes the local \
             copy from the cloud. Get ids from list_cloud_recordings. This is the \
             personal library — the org equivalent is copy_org_recording_to_personal.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Cloud recording id (from list_cloud_recordings)." }
                },
                "required": ["id"]
            }),
        ),
        tool(
            "search_meetings",
            "Search across saved recordings",
            "Full-text search over the saved recordings: what was SAID (every \
             transcript line, each hit carrying an `atMs` seek target) plus what \
             the analysis CONCLUDED (brief, findings, action items, meeting \
             context). This is the tool for questions that span meetings — \
             'when did we discuss pricing', 'which calls mention 東森', 'what did \
             I promise this customer' — and the only way to reach words spoken \
             mid-meeting: list_recordings' `query` sees only the title and the \
             transcript's first line. Scope it with `folderId` to search one \
             customer's folder (get ids from list_folders). Returns recordings \
             ranked by hit count, each with its matching snippets. Read the full \
             recording with get_recording once you know which one you want.",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Text to find (case-insensitive substring)." },
                    "folderId": { "type": "string", "description": "Only search recordings in this personal folder — e.g. one customer's folder." },
                    "since": { "type": "number", "description": "Only recordings created at/after this epoch-ms timestamp." },
                    "limit": { "type": "number", "description": "Max recordings returned (default 20)." },
                    "hitsPerRecording": { "type": "number", "description": "Max snippets per recording (default 5)." }
                },
                "required": ["query"]
            }),
        ),
        tool(
            "get_recording",
            "Read one saved recording",
            "Read a locally saved recording in full: title, dates, speaker names, the \
             complete timestamped transcript, plus everything Parley's analysis saved with \
             it (findings, action items, study brief, delivery assessment). \
             The saved analysis is CONTEXT — you're encouraged to form your own view from \
             the transcript and disagree where warranted. Use this (over several ids) as \
             the basis for cross-meeting advice or comparisons. Get ids from \
             list_recordings.",
            json!({ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }),
        ),
        tool(
            "rename_recording",
            "Rename a saved recording",
            "Rename a locally saved recording. Applied by the app (which also syncs the \
             new title to the cloud); waits for the app to confirm.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "title": { "type": "string" }
                },
                "required": ["id", "title"]
            }),
        ),
        tool(
            "update_recording_meta",
            "Update a saved recording's meeting frame",
            "Update a saved recording's FRAME by id: `meetingContext` (free text) and/or \
             `speakerNames` (merged per key, e.g. {\"them-1\": \"Jamie\"}; an empty string \
             removes that custom name). `meetingContext` is where you say WHAT KIND OF \
             MEETING this was and WHAT MATTERS in it — who was in the room, what was at \
             stake, and what the analysis should look for. It is fed verbatim into every \
             analysis prompt for this recording, so writing it (and then regenerating) is \
             how you re-aim the analysis. Use `speakerNames` to fix a wrong me/them \
             mapping. Applied by the app (which also syncs to cloud); waits for the app to \
             confirm.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "meetingContext": { "type": "string", "description": "Free-text description of what this meeting was and what the analysis should look for. Goes verbatim into every analysis prompt for this recording." },
                    "speakerNames": {
                        "type": "object",
                        "description": "Speaker-key → display-name patch, merged per key (empty string removes). Keys look like 'me-1' / 'them-1' / 'mix-2' — see speakerNames on get_recording.",
                        "additionalProperties": { "type": "string" }
                    }
                },
                "required": ["id"]
            }),
        ),
        tool(
            "set_recording_analysis",
            "Write analysis results onto a saved recording",
            "The write-back surface for an EXTERNAL analyst: write analysis results onto a \
             saved recording by id. Each provided field REPLACES that whole field — \
             `findings` (timeline markers; stamp `author`, e.g. 'claude', so they stay \
             distinguishable from Parley's own pass), `actionItems`, `brief` (markdown \
             debrief), `analyzed` (mark the recording analyzed so list_recordings filtering \
             can skip it). Omitted fields are left untouched. Read get_recording FIRST and \
             carry forward anything worth keeping — findings you omit from the new list are \
             gone. If the recording is open in replay the UI updates immediately. Applied by \
             the app (which also syncs to cloud); waits for the app to confirm.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "findings": {
                        "type": "array",
                        "description": "Full replacement findings list (see finding fields).",
                        "items": finding_schema()
                    },
                    "actionItems": {
                        "type": "array",
                        "description": "Full replacement action-item list.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": { "type": "string", "description": "Stable id; omit to mint a new one." },
                                "text": { "type": "string", "description": "The concrete next step / follow-up." },
                                "done": { "type": "boolean" },
                                "linkedEventId": { "type": "string", "description": "The finding this derives from, if any." },
                                "atMs": { "type": "number", "description": "Seek target on the recording, if any." },
                                "severity": { "type": "string", "enum": ["info", "warn", "critical"] }
                            },
                            "required": ["text"]
                        }
                    },
                    "brief": { "type": "string", "description": "Markdown debrief / meeting notes (the 重點 brief)." },
                    "analyzed": { "type": "boolean", "description": "Mark the analysis pipeline complete for this recording." }
                },
                "required": ["id"]
            }),
        ),
    ]
}
