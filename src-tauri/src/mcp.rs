use std::{net::SocketAddr, path::PathBuf, sync::Arc};

use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::{net::TcpListener, sync::RwLock};

use crate::commands::{session_commands_path, session_path, templates_path};

const DEFAULT_PORT: u16 = 3011;
const MAX_PORT: u16 = 3020;
const PROTOCOL_VERSION: &str = "2025-06-18";

#[derive(Clone, Serialize)]
pub struct McpServerInfo {
    pub running: bool,
    pub endpoint: String,
    pub templates_path: String,
}

#[derive(Clone)]
pub struct McpState {
    info: Arc<RwLock<McpServerInfo>>,
}

#[derive(Clone)]
struct HttpState {
    templates_path: PathBuf,
    session_path: PathBuf,
    commands_path: PathBuf,
}

#[derive(Deserialize)]
struct RpcRequest {
    #[serde(default)]
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
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

pub fn start(app: AppHandle) -> McpState {
    let templates = templates_path(&app).unwrap_or_else(|_| {
        app.path()
            .app_config_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("templates.json")
    });
    let info = Arc::new(RwLock::new(McpServerInfo {
        running: false,
        endpoint: String::new(),
        templates_path: templates.to_string_lossy().into_owned(),
    }));

    let session = session_path(&app).unwrap_or_else(|_| {
        app.path()
            .app_config_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("session.json")
    });
    let commands = session_commands_path(&app).unwrap_or_else(|_| {
        app.path()
            .app_config_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("session_commands.jsonl")
    });

    let state = McpState { info: info.clone() };
    tauri::async_runtime::spawn(async move {
        if let Err(err) = run_http_server(templates, session, commands, info).await {
            eprintln!("[parley-mcp] failed to start: {err}");
        }
    });

    state
}

#[tauri::command]
pub async fn get_mcp_server_info(
    state: tauri::State<'_, McpState>,
) -> Result<McpServerInfo, String> {
    Ok(state.info.read().await.clone())
}

async fn run_http_server(
    templates_path: PathBuf,
    session_path: PathBuf,
    commands_path: PathBuf,
    info: Arc<RwLock<McpServerInfo>>,
) -> anyhow::Result<()> {
    let (listener, addr) = bind_listener().await?;
    let endpoint = format!("http://{addr}/mcp");
    {
        let mut info = info.write().await;
        info.running = true;
        info.endpoint = endpoint.clone();
    }

    let app = Router::new()
        .route("/health", get(health))
        .route("/mcp", post(handle_rpc))
        .with_state(HttpState {
            templates_path,
            session_path,
            commands_path,
        });

    eprintln!("[parley-mcp] ready at {endpoint}");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn bind_listener() -> anyhow::Result<(TcpListener, SocketAddr)> {
    for port in DEFAULT_PORT..=MAX_PORT {
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        match TcpListener::bind(addr).await {
            Ok(listener) => return Ok((listener, addr)),
            Err(_) => continue,
        }
    }
    anyhow::bail!("no available localhost port in {DEFAULT_PORT}..={MAX_PORT}");
}

async fn health(State(state): State<HttpState>) -> impl IntoResponse {
    Json(json!({
        "ok": true,
        "name": "parley-templates",
        "templatesPath": state.templates_path,
    }))
}

async fn handle_rpc(
    State(state): State<HttpState>,
    Json(req): Json<RpcRequest>,
) -> impl IntoResponse {
    if req.id.is_none() {
        return StatusCode::ACCEPTED.into_response();
    }

    let id = req.id.clone();
    let result = match handle_method(&state, &req.method, req.params).await {
        Ok(value) => json!({ "jsonrpc": "2.0", "id": id, "result": value }),
        Err(err) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32000, "message": err.to_string() }
        }),
    };

    Json(result).into_response()
}

async fn handle_method(state: &HttpState, method: &str, params: Value) -> anyhow::Result<Value> {
    match method {
        "initialize" => Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "serverInfo": { "name": "parley-templates", "version": env!("CARGO_PKG_VERSION") },
            "capabilities": { "tools": { "listChanged": false } }
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools() })),
        "tools/call" => call_tool(state, params).await,
        _ if method.starts_with("notifications/") => Ok(Value::Null),
        _ => anyhow::bail!("unsupported MCP method: {method}"),
    }
}

fn tools() -> Vec<Value> {
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
        tool(
            "get_session_status",
            "Get live session status",
            "Get the current Parley meeting state: meetingStatus (idle/recording/stopped), \
             when it was last updated, and counts of transcript segments, todos, and evaluations.",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "get_transcript",
            "Get live transcript",
            "Get the full transcript of the current meeting so far, labelled by speaker.",
            json!({ "type": "object", "properties": {} }),
        ),
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
             { id, name, description, status, lastRunAt, result }.",
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
    ]
}

fn tool(name: &str, title: &str, description: &str, input_schema: Value) -> Value {
    json!({
        "name": name,
        "title": title,
        "description": description,
        "inputSchema": input_schema,
    })
}

async fn call_tool(state: &HttpState, params: Value) -> anyhow::Result<Value> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("missing tool name"))?;
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let value = match name {
        "list_eval_templates" => json!(list_eval_templates(&state.templates_path)?),
        "get_eval_template" => json!(get_eval_template(
            &state.templates_path,
            required_str(&args, "id")?
        )?),
        "upsert_eval_template" => json!(upsert_eval_template(&state.templates_path, args)?),
        "delete_eval_template" => json!(delete_eval_template(
            &state.templates_path,
            required_str(&args, "id")?
        )?),
        "list_todo_templates" => json!(list_todo_templates(&state.templates_path)?),
        "get_todo_template" => json!(get_todo_template(
            &state.templates_path,
            required_str(&args, "id")?
        )?),
        "upsert_todo_template" => json!(upsert_todo_template(&state.templates_path, args)?),
        "delete_todo_template" => json!(delete_todo_template(
            &state.templates_path,
            required_str(&args, "id")?
        )?),
        "get_session_status" => session_status(&state.session_path),
        "get_transcript" => read_session(&state.session_path)
            .get("transcript")
            .cloned()
            .unwrap_or_else(|| json!({ "text": "", "segmentCount": 0 })),
        "list_todos" => read_session(&state.session_path)
            .get("todos")
            .cloned()
            .unwrap_or_else(|| json!([])),
        "list_evaluations" => read_session(&state.session_path)
            .get("evaluations")
            .cloned()
            .unwrap_or_else(|| json!([])),
        "add_todo" => append_command(
            &state.commands_path,
            "add_todo",
            json!({ "text": required_str(&args, "text")? }),
        )?,
        "check_todo" => append_command(
            &state.commands_path,
            "check_todo",
            json!({
                "id": required_str(&args, "id")?,
                "done": args.get("done").and_then(Value::as_bool).unwrap_or(true)
            }),
        )?,
        "remove_todo" => append_command(
            &state.commands_path,
            "remove_todo",
            json!({ "id": required_str(&args, "id")? }),
        )?,
        "add_evaluation" => append_command(
            &state.commands_path,
            "add_evaluation",
            json!({
                "name": required_str(&args, "name")?,
                "description": args.get("description").and_then(Value::as_str).unwrap_or(""),
                "prompt": required_str(&args, "prompt")?
            }),
        )?,
        "remove_evaluation" => append_command(
            &state.commands_path,
            "remove_evaluation",
            json!({ "id": required_str(&args, "id")? }),
        )?,
        _ => anyhow::bail!("unknown tool: {name}"),
    };
    Ok(json!({ "content": [{ "type": "text", "text": serde_json::to_string_pretty(&value)? }] }))
}

fn required_str<'a>(value: &'a Value, key: &str) -> anyhow::Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("missing string field: {key}"))
}

/// Append one mutation command for the frontend to apply. The frontend polls
/// the file and applies new lines, so we only need to enqueue the intent.
fn append_command(path: &PathBuf, action: &str, args: Value) -> anyhow::Result<Value> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let line = json!({ "action": action, "args": args }).to_string();
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(file, "{line}")?;
    Ok(json!({ "ok": true, "queued": action }))
}

/// Read the frontend-written session snapshot as opaque JSON (empty object if
/// no meeting has written one yet). The schema is owned by the frontend.
fn read_session(path: &PathBuf) -> Value {
    match std::fs::read_to_string(path) {
        Ok(raw) if !raw.trim().is_empty() => serde_json::from_str(&raw).unwrap_or_else(|_| json!({})),
        _ => json!({}),
    }
}

/// Compact status summary derived from the session snapshot.
fn session_status(path: &PathBuf) -> Value {
    let s = read_session(path);
    let count = |key: &str| s.get(key).and_then(Value::as_array).map_or(0, |a| a.len());
    json!({
        "meetingStatus": s.get("meetingStatus").cloned().unwrap_or_else(|| json!("idle")),
        "updatedAt": s.get("updatedAt").cloned().unwrap_or(Value::Null),
        "segmentCount": s.pointer("/transcript/segmentCount").cloned().unwrap_or_else(|| json!(0)),
        "todoCount": count("todos"),
        "evalCount": count("evaluations"),
    })
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

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
