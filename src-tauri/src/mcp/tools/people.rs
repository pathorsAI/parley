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

/// One string property of a tool's input: its name and what it is.
type Prop = (&'static str, &'static str);

/// An input schema of string properties, `required` naming the ones a call
/// fails without.
fn input(props: &[Prop], required: &[&str]) -> Value {
    let properties: serde_json::Map<String, Value> = props
        .iter()
        .map(|(name, description)| (name.to_string(), json!({ "type": "string", "description": description })))
        .collect();
    let mut schema = json!({ "type": "object", "properties": properties });
    if !required.is_empty() {
        schema["required"] = json!(required);
    }
    schema
}

const LIST_PEOPLE: &str = "List the people Parley has notes about, as { id, name, org, aliases, notes: count, \
     lastSaidAt }, most recently noted first. Notes are short things worth bringing up \
     as small talk or remembering (a trip, a move, a busy season), each dated and tied \
     to the recording it came from. They live on this computer only. `query` narrows \
     the list to names, aliases and organisations containing it.";

const GET_PERSON: &str = "One person and their notes, newest first: { id, name, org, aliases, notes: [{ id, \
     text, saidAt, recordingId, atMs, quote }] }. Look a person up by `id` (from \
     list_people) or by `name` (an alias works). `saidAt` is when it was said: say \
     'last time' or 'back in March' accordingly, and do not present an old note as \
     news. Read this for each attendee before writing a draft's `smallTalk`.";

const ADD_PERSON_NOTE: &str = "Remember one thing about a person, for small talk next time: one short sentence \
     stating the fact (e.g. '十二月要去北海道滑雪'), in the language it was said in. The \
     person is created when Parley has none by that name; `org` tells two people with \
     the same name apart. Give `recordingId` and `quote` when the note comes from a \
     recording, so it stays traceable. Do not record health or medical matters, family \
     conflict, relationships, money trouble, politics, religion, or one person's \
     opinion of another. Returns the person with all their notes.";

const DELETE_PERSON_NOTE: &str =
    "Delete one note (ids from get_person). A person with no notes left is removed.";

fn schemas() -> Vec<Value> {
    vec![
        tool(
            "list_people",
            "List people",
            LIST_PEOPLE,
            input(&[("query", "Part of a name or organisation.")], &[]),
        ),
        tool(
            "get_person",
            "Get a person's notes",
            GET_PERSON,
            input(
                &[
                    ("id", "The person's id (see list_people)."),
                    ("name", "The person's name or an alias, when the id is not known."),
                ],
                &[],
            ),
        ),
        tool(
            "add_person_note",
            "Add a note about a person",
            ADD_PERSON_NOTE,
            input(
                &[
                    ("name", "Who the note is about."),
                    ("text", "The note: one sentence, up to 200 characters."),
                    ("org", "Their company or team."),
                    ("saidAt", "When it was said, ISO 8601. Defaults to the recording's date, else now."),
                    ("recordingId", "The recording it came from (see list_recordings)."),
                    ("quote", "The words it is based on."),
                ],
                &["name", "text"],
            ),
        ),
        tool(
            "delete_person_note",
            "Delete a note about a person",
            DELETE_PERSON_NOTE,
            input(
                &[("personId", "The person (see list_people)."), ("noteId", "The note (see get_person).")],
                &["personId", "noteId"],
            ),
        ),
    ]
}
