//! The voice-typing phrase dictionary: CRUD on `dictionary.json`, which the
//! app's dictionary settings read and write too.

use std::path::PathBuf;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::mcp::context::{new_id, now_ms, required_str, McpContext};
use crate::mcp::registry::{tool, Domain, Handler};

/// Emitted after a dictionary tool rewrites `dictionary.json`, the same
/// broadcast a window sends after its own write (lib/dictionary), so every
/// window re-reads the file now (and the main window schedules a cloud sync)
/// instead of waiting for its next focus. The voice-typing overlay, which
/// rewrites dictated text, never takes focus, so the focus re-read alone would
/// leave it on the old dictionary until the app restarted. `origin` tells the
/// windows it is not one of their own writes.
const DICTIONARY_UPDATED_EVENT: &str = "dictionary://updated";

pub(super) const DOMAIN: Domain = Domain {
    schemas,
    handlers: &[
        (
            "list_dictionary_phrases",
            Handler::Local(|state, _| list_dictionary_phrases(&state.dictionary_path)),
        ),
        (
            "add_dictionary_phrase",
            Handler::Local(|state, args| {
                announced(state, add_dictionary_phrase(&state.dictionary_path, args))
            }),
        ),
        (
            "update_dictionary_phrase",
            Handler::Local(|state, args| {
                announced(
                    state,
                    update_dictionary_phrase(&state.dictionary_path, args),
                )
            }),
        ),
        (
            "delete_dictionary_phrase",
            Handler::Local(|state, args| {
                let id = required_str(&args, "id")?;
                announced(state, delete_dictionary_phrase(&state.dictionary_path, id))
            }),
        ),
    ],
};

/// A successful write's output, after telling every window about it.
fn announced(state: &McpContext, written: anyhow::Result<Value>) -> anyhow::Result<Value> {
    let out = written?;
    announce_dictionary_change(state);
    Ok(out)
}

fn schemas() -> Vec<Value> {
    vec![
        tool(
            "list_dictionary_phrases",
            "List dictionary phrases",
            "List every phrase in the voice-typing dictionary as { id, phrase, variants, createdAt, source }. \
             These are the terms dictation is biased toward — product names, jargon, people.",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "add_dictionary_phrase",
            "Add dictionary phrase",
            "Add a phrase to the voice-typing dictionary so speech recognition spells it this way. \
             `variants` are the mis-transcriptions that should be corrected to it. Returns the new entry.",
            json!({
                "type": "object",
                "properties": {
                    "phrase": { "type": "string", "description": "The correct spelling, e.g. \"Parley\"." },
                    "variants": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Known mis-transcriptions of the phrase, e.g. [\"派勒\"]."
                    }
                },
                "required": ["phrase"]
            }),
        ),
        tool(
            "update_dictionary_phrase",
            "Update dictionary phrase",
            "Update an existing dictionary phrase by id. Omitted fields are left untouched; \
             supplying `variants` REPLACES the whole list. Returns the updated entry.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "phrase": { "type": "string" },
                    "variants": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["id"]
            }),
        ),
        tool(
            "delete_dictionary_phrase",
            "Delete dictionary phrase",
            "Remove a phrase from the voice-typing dictionary by id.",
            json!({ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }),
        ),
    ]
}

// --- Voice-typing phrase dictionary -------------------------------------------
//
// The FRONTEND owns this file's schema; these tools only ever reach into
// `entries[]`. So the document is handled as a raw `serde_json::Value` rather
// than a typed struct: anything we don't know about — the `ignored[]` array,
// fields a newer app version added, extra keys on an individual entry — rides
// through a read/modify/write untouched instead of being silently dropped.
//
// The one field these tools do maintain beyond the tool arguments is an entry's
// `updatedAt` (epoch ms of its last content change): cloud dictionary sync is
// last-write-wins on it, so an agent's edit must carry the time it was made.

/// A dictionary document with nothing in it. Written keys match the frontend's
/// schema so a file we create from scratch looks like one the app wrote.
fn empty_dictionary() -> Value {
    json!({ "entries": [], "ignored": [] })
}

/// Read `dictionary.json` as a JSON object. A missing or empty file is an empty
/// dictionary (the same convention every optional config file here follows).
///
/// Malformed JSON is an ERROR rather than a silent fallback: these tools write
/// the document back, so treating an unreadable file as empty would erase a
/// dictionary we merely failed to parse.
fn read_dictionary_doc(path: &PathBuf) -> anyhow::Result<Value> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(empty_dictionary()),
        Err(err) => return Err(err.into()),
    };
    if raw.trim().is_empty() {
        return Ok(empty_dictionary());
    }
    match serde_json::from_str::<Value>(&raw) {
        Ok(value) if value.is_object() => Ok(value),
        Ok(_) => anyhow::bail!("dictionary.json is not a JSON object"),
        Err(err) => anyhow::bail!("dictionary.json is not valid JSON: {err}"),
    }
}

/// Tell every window the dictionary file changed (see DICTIONARY_UPDATED_EVENT).
/// Best effort: a failed emit leaves the windows' focus re-read as the fallback.
fn announce_dictionary_change(state: &McpContext) {
    (state.emit)(DICTIONARY_UPDATED_EVENT, json!({ "origin": "mcp" }));
}

fn write_dictionary_doc(path: &PathBuf, doc: &Value) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, format!("{}\n", serde_json::to_string_pretty(doc)?))?;
    Ok(())
}

/// The `entries` array, or an empty one when the key is absent or isn't an array.
fn dictionary_entries(doc: &Value) -> Vec<Value> {
    doc.get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// Trim, drop blanks, and de-duplicate a variants list (order preserved), so an
/// MCP client can't stuff the dictionary with whitespace-only "variants".
fn clean_variants(variants: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for v in variants {
        let v = v.trim().to_string();
        if v.is_empty() || out.contains(&v) {
            continue;
        }
        out.push(v);
    }
    out
}

fn list_dictionary_phrases(path: &PathBuf) -> anyhow::Result<Value> {
    Ok(Value::Array(dictionary_entries(&read_dictionary_doc(
        path,
    )?)))
}

#[derive(Deserialize)]
struct AddPhraseInput {
    phrase: String,
    #[serde(default)]
    variants: Option<Vec<String>>,
}

fn add_dictionary_phrase(path: &PathBuf, args: Value) -> anyhow::Result<Value> {
    let input: AddPhraseInput = serde_json::from_value(args)?;
    let phrase = input.phrase.trim();
    if phrase.is_empty() {
        anyhow::bail!("phrase must not be empty");
    }
    let now = now_ms();
    let entry = json!({
        "id": new_id(),
        "phrase": phrase,
        "variants": clean_variants(input.variants.unwrap_or_default()),
        "createdAt": now,
        "updatedAt": now,
        // Stamped so the app can tell an agent-added phrase from one the user
        // typed in Settings or accepted from a correction.
        "source": "mcp",
    });
    let mut doc = read_dictionary_doc(path)?;
    let mut entries = dictionary_entries(&doc);
    entries.push(entry.clone());
    doc["entries"] = Value::Array(entries);
    write_dictionary_doc(path, &doc)?;
    Ok(entry)
}

#[derive(Deserialize)]
struct UpdatePhraseInput {
    id: String,
    #[serde(default)]
    phrase: Option<String>,
    #[serde(default)]
    variants: Option<Vec<String>>,
}

fn update_dictionary_phrase(path: &PathBuf, args: Value) -> anyhow::Result<Value> {
    let input: UpdatePhraseInput = serde_json::from_value(args)?;
    let mut doc = read_dictionary_doc(path)?;
    let mut entries = dictionary_entries(&doc);
    let entry = entries
        .iter_mut()
        .find(|e| e.get("id").and_then(Value::as_str) == Some(input.id.as_str()))
        .ok_or_else(|| anyhow::anyhow!("dictionary phrase not found: {}", input.id))?;
    // Indexing a non-object Value would panic, so refuse a malformed entry
    // instead of rewriting the file around it.
    if !entry.is_object() {
        anyhow::bail!("dictionary entry {} is not an object", input.id);
    }
    if let Some(phrase) = input.phrase {
        let phrase = phrase.trim();
        if phrase.is_empty() {
            anyhow::bail!("phrase must not be empty");
        }
        entry["phrase"] = json!(phrase);
    }
    if let Some(variants) = input.variants {
        entry["variants"] = json!(clean_variants(variants));
    }
    entry["updatedAt"] = json!(now_ms());
    let updated = entry.clone();
    doc["entries"] = Value::Array(entries);
    write_dictionary_doc(path, &doc)?;
    Ok(updated)
}

fn delete_dictionary_phrase(path: &PathBuf, id: &str) -> anyhow::Result<Value> {
    let mut doc = read_dictionary_doc(path)?;
    let mut entries = dictionary_entries(&doc);
    let before = entries.len();
    entries.retain(|e| e.get("id").and_then(Value::as_str) != Some(id));
    let deleted = entries.len() < before;
    if deleted {
        doc["entries"] = Value::Array(entries);
        write_dictionary_doc(path, &doc)?;
    }
    Ok(json!({ "deleted": deleted, "id": id }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch `dictionary.json` path under the OS temp dir, unique per test.
    fn temp_dictionary(tag: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "parley-dictionary-test-{tag}-{}.json",
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::remove_file(&path);
        path
    }

    #[test]
    fn a_missing_or_empty_dictionary_reads_as_empty() {
        let path = temp_dictionary("missing");
        assert_eq!(
            dictionary_entries(&read_dictionary_doc(&path).unwrap()).len(),
            0
        );
        std::fs::write(&path, "   \n").unwrap();
        assert_eq!(
            dictionary_entries(&read_dictionary_doc(&path).unwrap()).len(),
            0
        );
        // Malformed JSON must NOT read as empty — writing that back would erase
        // a dictionary we only failed to parse.
        std::fs::write(&path, "{ not json").unwrap();
        assert!(read_dictionary_doc(&path).is_err());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn writes_round_trip_ignored_and_unknown_fields_untouched() {
        let path = temp_dictionary("roundtrip");
        std::fs::write(
            &path,
            json!({
                "entries": [
                    { "id": "e1", "phrase": "Parley", "variants": ["派勒"],
                      "createdAt": 1756000000000u64, "source": "correction",
                      "futureField": "keep me" }
                ],
                "ignored": [ { "variant": "派勒", "phrase": "Parley", "count": 2 } ],
                "schemaVersion": 3
            })
            .to_string(),
        )
        .unwrap();

        // Adding a phrase must not disturb anything else in the document.
        let added = add_dictionary_phrase(
            &path,
            json!({ "phrase": " Cerana ", "variants": ["  ", "色瑞納", "色瑞納"] }),
        )
        .unwrap();
        assert_eq!(added["phrase"], json!("Cerana"));
        assert_eq!(added["source"], json!("mcp"));
        assert_eq!(added["updatedAt"], added["createdAt"]);
        // Blank dropped, duplicate collapsed.
        assert_eq!(added["variants"], json!(["色瑞納"]));

        let doc = read_dictionary_doc(&path).unwrap();
        assert_eq!(
            doc["ignored"],
            json!([{ "variant": "派勒", "phrase": "Parley", "count": 2 }])
        );
        assert_eq!(doc["schemaVersion"], json!(3));
        assert_eq!(doc["entries"][0]["futureField"], json!("keep me"));
        assert_eq!(dictionary_entries(&doc).len(), 2);

        // Updating touches only the named fields of the named entry.
        let updated =
            update_dictionary_phrase(&path, json!({ "id": "e1", "phrase": "Parley Inc" })).unwrap();
        assert_eq!(updated["phrase"], json!("Parley Inc"));
        assert_eq!(updated["variants"], json!(["派勒"]));
        assert_eq!(updated["futureField"], json!("keep me"));
        assert_eq!(updated["createdAt"], json!(1756000000000u64));
        // ...and stamps the change time cloud sync orders edits by.
        assert!(updated["updatedAt"].as_u64().unwrap() > 1756000000000u64);

        // Deleting reports whether it actually removed something.
        let gone = delete_dictionary_phrase(&path, "e1").unwrap();
        assert_eq!(gone, json!({ "deleted": true, "id": "e1" }));
        let missing = delete_dictionary_phrase(&path, "e1").unwrap();
        assert_eq!(missing, json!({ "deleted": false, "id": "e1" }));

        let doc = read_dictionary_doc(&path).unwrap();
        assert_eq!(dictionary_entries(&doc).len(), 1);
        assert_eq!(doc["ignored"][0]["count"], json!(2));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn dictionary_writes_reject_blank_phrases_and_unknown_ids() {
        let path = temp_dictionary("validation");
        assert!(add_dictionary_phrase(&path, json!({ "phrase": "   " })).is_err());
        assert!(update_dictionary_phrase(&path, json!({ "id": "nope", "phrase": "x" })).is_err());
        let _ = std::fs::remove_file(&path);
    }
}
