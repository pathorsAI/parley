//! Eval and TODO templates: CRUD on `templates.json`, the same file the app's
//! template editor reads and writes.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::mcp::context::{new_id, required_str};
use crate::mcp::registry::{tool, Domain, Handler};

pub(super) const DOMAIN: Domain = Domain {
    schemas,
    handlers: &[
        (
            "list_eval_templates",
            Handler::Local(|state, _| Ok(json!(list_eval_templates(&state.templates_path)?))),
        ),
        (
            "get_eval_template",
            Handler::Local(|state, args| {
                Ok(json!(get_eval_template(
                    &state.templates_path,
                    required_str(&args, "id")?
                )?))
            }),
        ),
        (
            "upsert_eval_template",
            Handler::Local(|state, args| {
                Ok(json!(upsert_eval_template(&state.templates_path, args)?))
            }),
        ),
        (
            "delete_eval_template",
            Handler::Local(|state, args| {
                Ok(json!(delete_eval_template(
                    &state.templates_path,
                    required_str(&args, "id")?
                )?))
            }),
        ),
        (
            "list_todo_templates",
            Handler::Local(|state, _| Ok(json!(list_todo_templates(&state.templates_path)?))),
        ),
        (
            "get_todo_template",
            Handler::Local(|state, args| {
                Ok(json!(get_todo_template(
                    &state.templates_path,
                    required_str(&args, "id")?
                )?))
            }),
        ),
        (
            "upsert_todo_template",
            Handler::Local(|state, args| {
                Ok(json!(upsert_todo_template(&state.templates_path, args)?))
            }),
        ),
        (
            "delete_todo_template",
            Handler::Local(|state, args| {
                Ok(json!(delete_todo_template(
                    &state.templates_path,
                    required_str(&args, "id")?
                )?))
            }),
        ),
    ],
};

fn schemas() -> Vec<Value> {
    vec![
        tool(
            "list_eval_templates",
            "List eval templates",
            "List all Parley evaluation templates as { id, name, builtin, evalCount }.",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "get_eval_template",
            "Get eval template",
            "Get a full Parley evaluation template by id.",
            json!({ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }),
        ),
        tool(
            "upsert_eval_template",
            "Create or update eval template",
            "Create or update an evaluation template. Returns the saved template.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "name": { "type": "string" },
                    "evals": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": { "type": "string" },
                                "name": { "type": "string" },
                                "description": { "type": "string" },
                                "prompt": { "type": "string" }
                            },
                            "required": ["name", "description", "prompt"]
                        }
                    }
                },
                "required": ["name", "evals"]
            }),
        ),
        tool(
            "delete_eval_template",
            "Delete eval template",
            "Delete an evaluation template by id.",
            json!({ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }),
        ),
        tool(
            "list_todo_templates",
            "List TODO templates",
            "List all Parley TODO/checklist templates as { id, name, builtin, itemCount }.",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "get_todo_template",
            "Get TODO template",
            "Get a full Parley TODO template by id.",
            json!({ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }),
        ),
        tool(
            "upsert_todo_template",
            "Create or update TODO template",
            "Create or update a TODO template. Returns the saved template.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "name": { "type": "string" },
                    "items": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["name", "items"]
            }),
        ),
        tool(
            "delete_todo_template",
            "Delete TODO template",
            "Delete a TODO template by id.",
            json!({ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }),
        ),
    ]
}

#[derive(Serialize, Deserialize, Clone)]
struct EvalDef {
    id: String,
    name: String,
    description: String,
    prompt: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct EvalTemplate {
    id: String,
    name: String,
    #[serde(default)]
    builtin: bool,
    #[serde(default)]
    evals: Vec<EvalDef>,
}

#[derive(Serialize, Deserialize, Clone)]
struct TodoTemplate {
    id: String,
    name: String,
    #[serde(default)]
    builtin: bool,
    #[serde(default)]
    items: Vec<String>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TemplatesFile {
    #[serde(default)]
    eval_templates: Vec<EvalTemplate>,
    #[serde(default)]
    todo_templates: Vec<TodoTemplate>,
}

fn read_templates(path: &PathBuf) -> anyhow::Result<TemplatesFile> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TemplatesFile::default())
        }
        Err(err) => return Err(err.into()),
    };
    if raw.trim().is_empty() {
        return Ok(TemplatesFile::default());
    }
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

fn write_templates(path: &PathBuf, file: &TemplatesFile) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, format!("{}\n", serde_json::to_string_pretty(file)?))?;
    Ok(())
}

fn list_eval_templates(path: &PathBuf) -> anyhow::Result<Vec<Value>> {
    let file = read_templates(path)?;
    Ok(file
        .eval_templates
        .iter()
        .map(|t| json!({ "id": t.id, "name": t.name, "builtin": t.builtin, "evalCount": t.evals.len() }))
        .collect())
}

fn get_eval_template(path: &PathBuf, id: &str) -> anyhow::Result<EvalTemplate> {
    read_templates(path)?
        .eval_templates
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| anyhow::anyhow!("eval template not found: {id}"))
}

#[derive(Deserialize)]
struct UpsertEvalInput {
    id: Option<String>,
    name: String,
    evals: Vec<UpsertEvalDef>,
}

#[derive(Deserialize)]
struct UpsertEvalDef {
    id: Option<String>,
    name: String,
    description: String,
    prompt: String,
}

fn upsert_eval_template(path: &PathBuf, args: Value) -> anyhow::Result<EvalTemplate> {
    let input: UpsertEvalInput = serde_json::from_value(args)?;
    let mut file = read_templates(path)?;
    let evals = input
        .evals
        .into_iter()
        .map(|e| EvalDef {
            id: e.id.unwrap_or_else(new_id),
            name: e.name,
            description: e.description,
            prompt: e.prompt,
        })
        .collect();
    let saved = EvalTemplate {
        id: input.id.clone().unwrap_or_else(new_id),
        name: input.name,
        builtin: false,
        evals,
    };

    if let Some(index) = input
        .id
        .as_ref()
        .and_then(|id| file.eval_templates.iter().position(|t| &t.id == id))
    {
        let builtin = file.eval_templates[index].builtin;
        file.eval_templates[index] = EvalTemplate {
            builtin,
            ..saved.clone()
        };
    } else {
        file.eval_templates.push(saved.clone());
    }
    write_templates(path, &file)?;
    Ok(saved)
}

fn delete_eval_template(path: &PathBuf, id: &str) -> anyhow::Result<Value> {
    let mut file = read_templates(path)?;
    let before = file.eval_templates.len();
    file.eval_templates.retain(|t| t.id != id);
    let deleted = file.eval_templates.len() < before;
    if deleted {
        write_templates(path, &file)?;
    }
    Ok(json!({ "deleted": deleted, "id": id }))
}

fn list_todo_templates(path: &PathBuf) -> anyhow::Result<Vec<Value>> {
    let file = read_templates(path)?;
    Ok(file
        .todo_templates
        .iter()
        .map(|t| json!({ "id": t.id, "name": t.name, "builtin": t.builtin, "itemCount": t.items.len() }))
        .collect())
}

fn get_todo_template(path: &PathBuf, id: &str) -> anyhow::Result<TodoTemplate> {
    read_templates(path)?
        .todo_templates
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| anyhow::anyhow!("todo template not found: {id}"))
}

#[derive(Deserialize)]
struct UpsertTodoInput {
    id: Option<String>,
    name: String,
    items: Vec<String>,
}

fn upsert_todo_template(path: &PathBuf, args: Value) -> anyhow::Result<TodoTemplate> {
    let input: UpsertTodoInput = serde_json::from_value(args)?;
    let mut file = read_templates(path)?;
    let saved = TodoTemplate {
        id: input.id.clone().unwrap_or_else(new_id),
        name: input.name,
        builtin: false,
        items: input.items,
    };

    if let Some(index) = input
        .id
        .as_ref()
        .and_then(|id| file.todo_templates.iter().position(|t| &t.id == id))
    {
        let builtin = file.todo_templates[index].builtin;
        file.todo_templates[index] = TodoTemplate {
            builtin,
            ..saved.clone()
        };
    } else {
        file.todo_templates.push(saved.clone());
    }
    write_templates(path, &file)?;
    Ok(saved)
}

fn delete_todo_template(path: &PathBuf, id: &str) -> anyhow::Result<Value> {
    let mut file = read_templates(path)?;
    let before = file.todo_templates.len();
    file.todo_templates.retain(|t| t.id != id);
    let deleted = file.todo_templates.len() < before;
    if deleted {
        write_templates(path, &file)?;
    }
    Ok(json!({ "deleted": deleted, "id": id }))
}
