//! Organizations: their recordings and folders, and moving recordings between
//! the personal library and an org — RPCs into the frontend, which holds the
//! account's token (the cloud enforces the org roles).

use serde_json::{json, Value};

use crate::mcp::registry::{tool, Domain, Field, Handler};

/// A personal recording and the org it goes to.
const TO_ORG: &[Field] = &[
    Field::Required("id"),
    Field::Required("orgId"),
    Field::Optional("folderId"),
];

/// One org recording.
const ORG_RECORDING: &[Field] = &[Field::Required("orgId"), Field::Required("id")];

pub(super) const DOMAIN: Domain = Domain {
    schemas,
    handlers: &[
        ("list_orgs", Handler::Forward(&[])),
        (
            "list_org_recordings",
            Handler::Forward(&[Field::Required("orgId")]),
        ),
        (
            "list_org_folders",
            Handler::Forward(&[Field::Required("orgId")]),
        ),
        (
            "create_org_folder",
            Handler::Forward(&[Field::Required("orgId"), Field::Required("name")]),
        ),
        (
            "rename_org_folder",
            Handler::Forward(&[
                Field::Required("orgId"),
                Field::Required("id"),
                Field::Required("name"),
            ]),
        ),
        (
            "delete_org_folder",
            Handler::Forward(&[Field::Required("orgId"), Field::Required("id")]),
        ),
        (
            "move_org_recording_to_folder",
            Handler::Forward(&[
                Field::Required("orgId"),
                Field::Required("id"),
                Field::Optional("folderId"),
            ]),
        ),
        ("share_recording_to_org", Handler::Forward(TO_ORG)),
        ("move_recording_to_org", Handler::Forward(TO_ORG)),
        (
            "copy_org_recording_to_personal",
            Handler::Forward(ORG_RECORDING),
        ),
        ("delete_org_recording", Handler::Forward(ORG_RECORDING)),
    ],
};

fn schemas() -> Vec<Value> {
    vec![
        tool(
            "list_orgs",
            "List organizations",
            "List the organizations the signed-in user belongs to, as { id, name, role }. \
             Requires the user to be signed in to Parley cloud.",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "list_org_recordings",
            "List an org's shared recordings",
            "List the recordings shared into an organization (cloud-hosted). Get org ids \
             from list_orgs.",
            json!({ "type": "object", "properties": { "orgId": { "type": "string" } }, "required": ["orgId"] }),
        ),
        tool(
            "list_org_folders",
            "List an org's folders",
            "List an organization's folders as { id, name }. Get org ids from list_orgs.",
            json!({ "type": "object", "properties": { "orgId": { "type": "string" } }, "required": ["orgId"] }),
        ),
        tool(
            "create_org_folder",
            "Create an org folder",
            "Create a shared folder in an organization and return { id, name, existed }. \
             Idempotent by name: an existing same-name folder is returned (existed: true) \
             instead of duplicated. Any org member can create; requires the user to be \
             signed in to Parley cloud. Get org ids from list_orgs.",
            json!({
                "type": "object",
                "properties": {
                    "orgId": { "type": "string" },
                    "name": { "type": "string", "description": "Folder display name." }
                },
                "required": ["orgId", "name"]
            }),
        ),
        tool(
            "rename_org_folder",
            "Rename an org folder",
            "Rename an organization's shared folder by id (creator or org admin/owner \
             only). Get folder ids from list_org_folders.",
            json!({
                "type": "object",
                "properties": {
                    "orgId": { "type": "string" },
                    "id": { "type": "string" },
                    "name": { "type": "string", "description": "New display name." }
                },
                "required": ["orgId", "id", "name"]
            }),
        ),
        tool(
            "delete_org_folder",
            "Delete an org folder",
            "Delete an organization's shared folder by id (creator or org admin/owner \
             only). The recordings it held are NOT deleted — they fall back to the org \
             root. Get folder ids from list_org_folders.",
            json!({
                "type": "object",
                "properties": {
                    "orgId": { "type": "string" },
                    "id": { "type": "string" }
                },
                "required": ["orgId", "id"]
            }),
        ),
        tool(
            "move_org_recording_to_folder",
            "Move an org recording between org folders",
            "Move an org-shared recording into one of that org's folders, or back to \
             the org root by omitting folderId. Get recording ids from \
             list_org_recordings and folder ids from list_org_folders.",
            json!({
                "type": "object",
                "properties": {
                    "orgId": { "type": "string" },
                    "id": { "type": "string", "description": "Org recording id (from list_org_recordings)." },
                    "folderId": { "type": "string", "description": "Target org folder id; omit for the org root." }
                },
                "required": ["orgId", "id"]
            }),
        ),
        tool(
            "share_recording_to_org",
            "Copy a recording into an org",
            "Share (COPY) a personal recording into an organization, optionally into a \
             specific org folder. The personal original stays put. Returns the new \
             org-side summary (note: the org copy gets a NEW id).",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Personal recording id (from list_recordings)." },
                    "orgId": { "type": "string" },
                    "folderId": { "type": "string", "description": "Org folder id; omit for the org root." }
                },
                "required": ["id", "orgId"]
            }),
        ),
        tool(
            "move_recording_to_org",
            "Move a recording into an org",
            "MOVE a personal recording into an organization: copy it in, then delete the \
             personal original (local + personal cloud). Destructive for the personal \
             copy — prefer share_recording_to_org to keep it. Returns the new org-side \
             summary.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Personal recording id (from list_recordings)." },
                    "orgId": { "type": "string" },
                    "folderId": { "type": "string", "description": "Org folder id; omit for the org root." }
                },
                "required": ["id", "orgId"]
            }),
        ),
        tool(
            "copy_org_recording_to_personal",
            "Copy an org recording to personal",
            "Save a copy of an org-shared recording into the personal library (local \
             disk), so it appears in list_recordings and can be opened in replay. The \
             org copy stays put (remove it with delete_org_recording).",
            json!({
                "type": "object",
                "properties": {
                    "orgId": { "type": "string" },
                    "id": { "type": "string", "description": "Org recording id (from list_org_recordings)." }
                },
                "required": ["orgId", "id"]
            }),
        ),
        tool(
            "delete_org_recording",
            "Remove a recording from an org (DESTRUCTIVE)",
            "Remove a shared recording from an organization (uploader or org \
             admin/owner only, server-enforced). Only the org copy is deleted — a \
             personal original, if one still exists, is untouched. This cannot be \
             undone; re-share from the personal copy to restore it. Get ids from \
             list_org_recordings.",
            json!({
                "type": "object",
                "properties": {
                    "orgId": { "type": "string" },
                    "id": { "type": "string", "description": "Org recording id (from list_org_recordings)." }
                },
                "required": ["orgId", "id"]
            }),
        ),
    ]
}
