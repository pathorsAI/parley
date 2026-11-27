//! People notes — what is worth remembering about the people the user meets,
//! for small talk next time. RPCs into the frontend, which owns `people.json`
//! (lib/people). Only notes the user has kept are ever returned.

use serde_json::{json, Value};

use crate::mcp::registry::{tool, Domain, Field, Handler};

pub(super) const DOMAIN: Domain = Domain {
    schemas,
    handlers: &[
        ("list_people", Handler::Forward(&[Field::Optional("query")])),
        ("get_person", Handler::Forward(&[Field::Optional("id"), Field::Optional("name")])),
        (
            "add_person_note",
            Handler::Forward(&[
                Field::Required("name"),
                Field::Required("text"),
                Field::Optional("org"),
                Field::Optional("saidAt"),
                Field::Optional("recordingId"),
                Field::Optional("quote"),
            ]),
        ),
        (
            "delete_person_note",
            Handler::Forward(&[Field::Required("personId"), Field::Required("noteId")]),
        ),
    ],
};

fn schemas() -> Vec<Value> {
    vec![
        tool(
            "list_people",
            "List people",
            "List the people Parley has notes about, as { id, name, org, aliases, notes: count, \
             lastSaidAt }, most recently noted first. Notes are short things worth bringing up \
             as small talk or remembering (a trip, a move, a busy season), each dated and tied \
             to the recording it came from. They live on this computer only. `query` narrows \
             the list to names, aliases and organisations containing it.",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Part of a name or organisation." }
                }
            }),
        ),
        tool(
            "get_person",
            "Get a person's notes",
            "One person and their notes, newest first: { id, name, org, aliases, notes: [{ id, \
             text, saidAt, recordingId, atMs, quote }] }. Look a person up by `id` (from \
             list_people) or by `name` (an alias works). `saidAt` is when it was said: say \
             'last time' or 'back in March' accordingly, and do not present an old note as \
             news. Read this for each attendee before writing a draft's `smallTalk`.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "The person's id (see list_people)." },
                    "name": { "type": "string", "description": "The person's name or an alias, when the id is not known." }
                }
            }),
        ),
        tool(
            "add_person_note",
            "Add a note about a person",
            "Remember one thing about a person, for small talk next time: one short sentence \
             stating the fact (e.g. '十二月要去北海道滑雪'), in the language it was said in. The \
             person is created when Parley has none by that name; `org` tells two people with \
             the same name apart. Give `recordingId` and `quote` when the note comes from a \
             recording, so it stays traceable. Do not record health or medical matters, family \
             conflict, relationships, money trouble, politics, religion, or one person's \
             opinion of another. Returns the person with all their notes.",
            json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Who the note is about." },
                    "text": { "type": "string", "description": "The note: one sentence, up to 200 characters." },
                    "org": { "type": "string", "description": "Their company or team." },
                    "saidAt": { "type": "string", "description": "When it was said, ISO 8601. Defaults to the recording's date, else now." },
                    "recordingId": { "type": "string", "description": "The recording it came from (see list_recordings)." },
                    "quote": { "type": "string", "description": "The words it is based on." }
                },
                "required": ["name", "text"]
            }),
        ),
        tool(
            "delete_person_note",
            "Delete a note about a person",
            "Delete one note (ids from get_person). A person with no notes left is removed.",
            json!({
                "type": "object",
                "properties": {
                    "personId": { "type": "string" },
                    "noteId": { "type": "string" }
                },
                "required": ["personId", "noteId"]
            }),
        ),
    ]
}
