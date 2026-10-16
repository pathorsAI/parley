//! The personal library's folders, transcript imports and deletions — RPCs
//! into the frontend, which owns the folder registry and the library index.

use serde_json::{json, Value};

use crate::mcp::registry::{tool, Domain, Field, Handler};

pub(super) const DOMAIN: Domain = Domain {
    schemas,
    handlers: &[
        ("list_folders", Handler::Forward(&[])),
        (
            "create_folder",
            Handler::Forward(&[Field::Required("name")]),
        ),
        (
            "rename_folder",
            Handler::Forward(&[Field::Required("id"), Field::Required("name")]),
        ),
        ("delete_folder", Handler::Forward(&[Field::Required("id")])),
        ("import_transcript", Handler::ForwardWith(import_args)),
        (
            "move_recording_to_folder",
            Handler::Forward(&[Field::Required("id"), Field::Optional("folderId")]),
        ),
        (
            "delete_recording",
            Handler::Forward(&[Field::Required("id")]),
        ),
    ],
};

/// `paths` (a non-empty array) and the optional target `folder`.
fn import_args(args: Value) -> anyhow::Result<Value> {
    let paths = args
        .get("paths")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
        .ok_or_else(|| anyhow::anyhow!("paths (non-empty array) is required"))?;
    Ok(json!({
        "paths": paths,
        "folder": args.get("folder").cloned().unwrap_or(Value::Null)
    }))
}

fn schemas() -> Vec<Value> {
    vec![
        tool(
            "list_folders",
            "List personal folders",
            "List the personal history folders as { id, name, archived }. Recordings \
             whose folderId is null (or unknown) live at the personal root. An \
             archived folder is one the user has put away: it still holds the \
             recordings already filed in it, but do not file anything new there \
             unless the user names it.",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "create_folder",
            "Create a personal folder",
            "Create a personal history folder and return { id, name, existed }. \
             Idempotent by name: when a folder with that name already exists it is \
             returned (existed: true) instead of duplicated. When cloud sync is on \
             the folder is mirrored to the cloud registry.",
            json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Folder display name." }
                },
                "required": ["name"]
            }),
        ),
        tool(
            "rename_folder",
            "Rename a personal folder",
            "Rename a personal history folder by id. Get ids from list_folders.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "name": { "type": "string", "description": "New display name." }
                },
                "required": ["id", "name"]
            }),
        ),
        tool(
            "delete_folder",
            "Delete a personal folder",
            "Delete a personal history folder by id. The recordings it held are NOT \
             deleted — they fall back to the personal root (the orphan→root rule). \
             Get ids from list_folders.",
            json!({ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }),
        ),
        tool(
            "import_transcript",
            "Import .txt transcripts as recordings",
            "Import plain-text transcript files as audio-less personal recordings \
             (issue #130 text-ingest). Speaker labels ('Speaker 1:' / 'Name: …') and \
             [HH:MM:SS] timestamps are auto-detected; unstructured text is chunked at \
             sentence boundaries with a synthesized timeline. Entries save unanalyzed \
             and run their analysis on first open. `folder` files them into that \
             personal folder BY NAME (created if missing); omit it for the personal \
             root. Requires the Parley app to be running. Import in batches (e.g. one \
             customer folder's files per call) to stay inside the RPC timeout.",
            json!({
                "type": "object",
                "properties": {
                    "paths": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Absolute paths of .txt transcript files."
                    },
                    "folder": {
                        "type": "string",
                        "description": "Target personal folder NAME (created if missing); omit for the personal root."
                    }
                },
                "required": ["paths"]
            }),
        ),
        tool(
            "move_recording_to_folder",
            "Move a recording between personal folders",
            "Move a locally saved recording into a personal folder (or to the personal \
             root by omitting folderId). Get folder ids from list_folders.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "folderId": { "type": "string", "description": "Target folder id; omit for the personal root." }
                },
                "required": ["id"]
            }),
        ),
        tool(
            "delete_recording",
            "Delete a saved recording (DESTRUCTIVE)",
            "Permanently delete a personal recording: its local files AND its personal \
             cloud copy. The cloud id is tombstoned — it can never be re-uploaded, so \
             this CANNOT be undone. Copies previously shared into an org are NOT \
             affected. Prefer move_recording_to_folder for archiving; only delete when \
             the user explicitly wants the recording gone.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Personal recording id (from list_recordings)." }
                },
                "required": ["id"]
            }),
        ),
    ]
}
