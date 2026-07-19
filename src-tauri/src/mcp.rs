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
use tauri::{AppHandle, Emitter, Manager};
use tokio::{net::TcpListener, sync::RwLock};

use crate::commands::{
    session_command_results_path, session_commands_path, session_path, templates_path,
};

const DEFAULT_PORT: u16 = 3011;
const MAX_PORT: u16 = 3020;
/// Emitted after enqueuing a session command so the frontend applies it now
/// instead of on its next (possibly suspended) poll tick.
const SESSION_COMMANDS_EVENT: &str = "session://commands";
const PROTOCOL_VERSION: &str = "2025-06-18";

/// Attached to every response that carries Parley's own analysis output
/// (findings, brief, intel, action items, delivery assessment), so an MCP
/// client treats those as context to reason over — not as authority.
const ANALYSIS_NOTE: &str =
    "The findings, evaluations, brief, intel, action items, and delivery assessment in this \
     response are Parley's OWN prior analysis, included as CONTEXT — not ground truth. When \
     analyzing or advising, reason from the transcript first; you are free and encouraged to \
     think critically, disagree with these results, or surface angles they missed.";

#[derive(Clone, Serialize)]
pub struct McpServerInfo {
    pub running: bool,
    pub endpoint: String,
    pub templates_path: String,
}

/// Rolling record of MCP client traffic, so the app UI can show whether a
/// client is connected and what it has been reading/writing. HTTP MCP has no
/// persistent connection, so "connected" is derived from `last_request_at`.
#[derive(Default)]
struct ActivityState {
    /// `clientInfo` from the most recent `initialize` ({ name, version }).
    client: Option<Value>,
    /// Epoch ms of the last JSON-RPC request of any kind.
    last_request_at: Option<u64>,
    /// Most-recent-first tool calls: { at, tool, kind: read|write, ok, error? }.
    recent: std::collections::VecDeque<Value>,
}

/// How many tool calls the activity feed keeps.
const ACTIVITY_CAP: usize = 50;

#[derive(Clone, Default)]
pub struct McpActivity {
    inner: Arc<RwLock<ActivityState>>,
}

#[derive(Clone)]
pub struct McpState {
    info: Arc<RwLock<McpServerInfo>>,
    activity: McpActivity,
}

#[derive(Clone)]
struct HttpState {
    templates_path: PathBuf,
    session_path: PathBuf,
    commands_path: PathBuf,
    /// RPC results appended by the frontend (see `call_frontend`).
    results_path: PathBuf,
    /// Local recording store (`<app_data_dir>/history`) for the read-only
    /// recording tools — same layout history.rs documents.
    history_dir: PathBuf,
    /// Client-traffic record surfaced to the app UI (`get_mcp_activity`).
    activity: McpActivity,
    /// This server's own endpoint ("http://127.0.0.1:<port>/mcp"). Stamped onto
    /// RPC commands as `instance` so that when TWO app instances run (packaged +
    /// dev share the config-dir command queue), only the frontend belonging to
    /// THIS server executes them — otherwise both would, and a mutating RPC like
    /// import_transcript would apply twice.
    endpoint: String,
    /// Handle for waking the webview when a command is enqueued: macOS suspends
    /// an occluded window's JS timers, so the frontend's polling loop alone can
    /// stall until the 20s RPC deadline. An event rides the IPC instead of a
    /// timer, so delivery doesn't depend on the window being visible.
    app: AppHandle,
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
    let results = session_command_results_path(&app).unwrap_or_else(|_| {
        app.path()
            .app_config_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("session_command_results.jsonl")
    });
    let history = crate::history::history_dir(&app).unwrap_or_else(|_| {
        app.path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("history")
    });

    let activity = McpActivity::default();
    let state = McpState {
        info: info.clone(),
        activity: activity.clone(),
    };
    tauri::async_runtime::spawn(async move {
        if let Err(err) = run_http_server(
            app, templates, session, commands, results, history, activity, info,
        )
        .await
        {
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

/// Client-traffic snapshot for the app UI: who initialized (name/version), when
/// the last request arrived, and the recent tool calls (newest first). The UI
/// derives "connected" from `lastRequestAt` recency — HTTP MCP has no session.
#[tauri::command]
pub async fn get_mcp_activity(state: tauri::State<'_, McpState>) -> Result<Value, String> {
    let a = state.activity.inner.read().await;
    Ok(json!({
        "client": a.client,
        "lastRequestAt": a.last_request_at,
        "recent": a.recent.iter().cloned().collect::<Vec<Value>>(),
    }))
}

#[allow(clippy::too_many_arguments)]
async fn run_http_server(
    app: AppHandle,
    templates_path: PathBuf,
    session_path: PathBuf,
    commands_path: PathBuf,
    results_path: PathBuf,
    history_dir: PathBuf,
    activity: McpActivity,
    info: Arc<RwLock<McpServerInfo>>,
) -> anyhow::Result<()> {
    let (listener, addr) = bind_listener().await?;
    let endpoint = format!("http://{addr}/mcp");
    {
        let mut info = info.write().await;
        info.running = true;
        info.endpoint = endpoint.clone();
    }

    // RPC ids are minted per run; drop any results left over from a previous
    // launch so the scan stays small and stale lines can never match.
    let _ = std::fs::write(&results_path, "");

    let app = Router::new()
        .route("/health", get(health))
        .route("/mcp", post(handle_rpc))
        .with_state(HttpState {
            templates_path,
            session_path,
            commands_path,
            results_path,
            history_dir,
            activity,
            endpoint: endpoint.clone(),
            app,
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
    // Every request marks the client as alive; initialize also records who it is.
    {
        let mut a = state.activity.inner.write().await;
        a.last_request_at = Some(now_ms());
        if method == "initialize" {
            if let Some(client) = params.get("clientInfo") {
                a.client = Some(client.clone());
            }
        }
    }
    match method {
        "initialize" => Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "serverInfo": { "name": "parley", "version": env!("CARGO_PKG_VERSION") },
            "capabilities": { "tools": { "listChanged": false } }
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools() })),
        "tools/call" => {
            let tool = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("?")
                .to_string();
            let result = call_tool(state, params).await;
            let mut entry = json!({
                "at": now_ms(),
                "tool": tool,
                "kind": tool_kind(&tool),
                "ok": result.is_ok(),
            });
            if let Err(err) = &result {
                entry["error"] = json!(err.to_string());
            }
            let mut a = state.activity.inner.write().await;
            a.recent.push_front(entry);
            a.recent.truncate(ACTIVITY_CAP);
            result
        }
        _ if method.starts_with("notifications/") => Ok(Value::Null),
        _ => anyhow::bail!("unsupported MCP method: {method}"),
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Coarse read/write classification for the activity feed, by tool-name verb.
fn tool_kind(name: &str) -> &'static str {
    const WRITE_VERBS: [&str; 11] = [
        "upsert_", "delete_", "add_", "remove_", "check_", "set_", "update_", "rename_", "move_",
        "share_", "copy_",
    ];
    if WRITE_VERBS.iter().any(|v| name.starts_with(v)) {
        "write"
    } else {
        "read"
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
            "get_app_context",
            "Get what the user is looking at",
            "ALWAYS CALL THIS FIRST to know what the user is focused on. Returns focus \
             (live / replay / accounts), meetingStatus, and — when the user is reviewing a \
             recording — which one. IMPORTANT: meetingStatus 'stopped' means the last live \
             meeting ENDED; if focus is 'replay' the user is reviewing a SAVED recording, \
             not sitting in a meeting. Never assume a meeting is happening unless \
             meetingStatus is 'recording'.",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "get_focused_content",
            "Get the content the user is viewing",
            "Get the data behind whatever screen the user is on right now, plus the focus \
             context: the transcript and EVERYTHING Parley's own analysis produced for it \
             (findings, study brief, intel board, action items, delivery assessment; live \
             mode adds todos and evaluations). Those analysis artifacts are CONTEXT from \
             Parley's earlier passes, not ground truth — when giving advice, reason from \
             the transcript yourself and feel free to challenge or go beyond them. Use \
             this to give advice about what the user is currently seeing.",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "get_session_status",
            "Get live session status",
            "Get the current Parley meeting state: meetingStatus (idle/recording/stopped), \
             when it was last updated, counts of transcript segments, todos, evaluations, \
             and timeline-analysis findings — plus the focus context (live vs replay). \
             'stopped' = the last meeting has ENDED, not an active meeting.",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "get_transcript",
            "Get the loaded transcript",
            "Get the transcript currently loaded in the app, labelled by speaker. During a \
             live meeting this is the live transcript so far; in replay it is the transcript \
             of the recording being reviewed; after a meeting ends it is the finished \
             meeting's transcript. Check the returned context to know which one you got.",
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
                    "severity": { "type": "string", "enum": ["info", "warn", "critical"] },
                    "source": { "type": "string", "enum": ["eval", "extra"] },
                    "title": { "type": "string" },
                    "detail": { "type": "string" },
                    "quotes": { "type": "array", "items": { "type": "string" } },
                    "evalIds": { "type": "array", "items": { "type": "string" } },
                    "resolved": { "type": "boolean" },
                    "resolution": { "type": "string" }
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
        tool(
            "list_recordings",
            "List saved recordings (history)",
            "List the user's locally saved recordings (the personal history library), \
             newest first, as summary cards: { id, title, source, createdAt, durationMs, \
             speakerCount, findingsCount, actionItemsCount, hasAudio, snippet, folderId }. \
             Optional text query filters by title + transcript snippet. Org-shared \
             recordings live in the cloud — list those with list_org_recordings.",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Case-insensitive text filter over title + snippet." },
                    "folderId": { "type": "string", "description": "Only recordings in this personal folder (get ids from list_folders)." },
                    "limit": { "type": "number", "description": "Max results (default 50)." }
                }
            }),
        ),
        tool(
            "get_recording",
            "Read one saved recording",
            "Read a locally saved recording in full: title, dates, speaker names, the \
             complete timestamped transcript, plus everything Parley's analysis saved with \
             it (findings, action items, study brief, intel board, delivery assessment). \
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
            "list_folders",
            "List personal folders",
            "List the personal history folders as { id, name }. Recordings whose folderId \
             is null (or unknown) live at the personal root.",
            json!({ "type": "object", "properties": {} }),
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
             org copy stays put (removing it needs uploader/admin rights in the app).",
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

/// JSON-Schema for one TimelineEvent, shared by set_findings. `me` = a problem/
/// mistake by ME; `them` = a point/pressure the other party raised.
fn finding_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "id": { "type": "string", "description": "Stable id; omit to mint a new one." },
            "atMs": { "type": "number", "description": "Moment on the recording timeline (ms)." },
            "side": { "type": "string", "enum": ["me", "them"], "description": "Lane: my problem vs their move." },
            "severity": { "type": "string", "enum": ["info", "warn", "critical"] },
            "source": { "type": "string", "enum": ["eval", "extra"], "description": "From an eval, or an AI-caught extra moment." },
            "title": { "type": "string", "description": "Short label." },
            "detail": { "type": "string", "description": "One or two sentences explaining the moment." },
            "quotes": { "type": "array", "items": { "type": "string" }, "description": "Supporting verbatim quotes." },
            "evalIds": { "type": "array", "items": { "type": "string" }, "description": "Matching evaluation ids (for source=eval)." },
            "resolved": { "type": "boolean", "description": "True when ME later addressed/defused this moment." },
            "resolution": { "type": "string", "description": "One line on how ME handled it (only when resolved)." }
        },
        "required": ["atMs", "side", "severity", "title", "detail"]
    })
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
        "get_app_context" => {
            let s = read_session(&state.session_path);
            focus_context(&s)
        }
        "get_focused_content" => focused_content(state),
        "get_session_status" => session_status(&state.session_path),
        "get_transcript" => {
            let s = read_session(&state.session_path);
            let transcript = s
                .get("transcript")
                .cloned()
                .unwrap_or_else(|| json!({ "text": "", "segmentCount": 0 }));
            json!({ "context": focus_context(&s), "transcript": transcript })
        }
        "list_todos" => read_session(&state.session_path)
            .get("todos")
            .cloned()
            .unwrap_or_else(|| json!([])),
        "list_evaluations" => read_session(&state.session_path)
            .get("evaluations")
            .cloned()
            .unwrap_or_else(|| json!([])),
        "add_todo" => append_command(
            state,
            "add_todo",
            json!({ "text": required_str(&args, "text")? }),
        )?,
        "check_todo" => append_command(
            state,
            "check_todo",
            json!({
                "id": required_str(&args, "id")?,
                "done": args.get("done").and_then(Value::as_bool).unwrap_or(true)
            }),
        )?,
        "remove_todo" => append_command(
            state,
            "remove_todo",
            json!({ "id": required_str(&args, "id")? }),
        )?,
        "add_evaluation" => append_command(
            state,
            "add_evaluation",
            json!({
                "name": required_str(&args, "name")?,
                "description": args.get("description").and_then(Value::as_str).unwrap_or(""),
                "prompt": required_str(&args, "prompt")?
            }),
        )?,
        "remove_evaluation" => append_command(
            state,
            "remove_evaluation",
            json!({ "id": required_str(&args, "id")? }),
        )?,
        "list_findings" => read_session(&state.session_path)
            .get("findings")
            .cloned()
            .unwrap_or_else(|| json!([])),
        "add_finding" => append_command(state, "add_finding", args)?,
        "set_findings" => append_command(
            state,
            "set_findings",
            json!({ "events": args.get("events").cloned().unwrap_or_else(|| json!([])) }),
        )?,
        "update_finding" => {
            required_str(&args, "id")?; // validate before queueing the raw patch
            append_command(state, "update_finding", args)?
        }
        "remove_finding" => append_command(
            state,
            "remove_finding",
            json!({ "id": required_str(&args, "id")? }),
        )?,
        "list_recordings" => list_recordings(&state.history_dir, &args)?,
        "get_recording" => get_recording(&state.history_dir, required_str(&args, "id")?)?,
        "rename_recording" => {
            call_frontend(
                state,
                "rename_recording",
                json!({
                    "id": required_str(&args, "id")?,
                    "title": required_str(&args, "title")?
                }),
            )
            .await?
        }
        "list_folders" => call_frontend(state, "list_folders", json!({})).await?,
        "import_transcript" => {
            let paths = args
                .get("paths")
                .and_then(Value::as_array)
                .filter(|a| !a.is_empty())
                .ok_or_else(|| anyhow::anyhow!("paths (non-empty array) is required"))?;
            call_frontend(
                state,
                "import_transcript",
                json!({
                    "paths": paths,
                    "folder": args.get("folder").cloned().unwrap_or(Value::Null)
                }),
            )
            .await?
        }
        "move_recording_to_folder" => {
            call_frontend(
                state,
                "move_recording_to_folder",
                json!({
                    "id": required_str(&args, "id")?,
                    "folderId": args.get("folderId").cloned().unwrap_or(Value::Null)
                }),
            )
            .await?
        }
        "list_orgs" => call_frontend(state, "list_orgs", json!({})).await?,
        "list_org_recordings" => {
            call_frontend(
                state,
                "list_org_recordings",
                json!({ "orgId": required_str(&args, "orgId")? }),
            )
            .await?
        }
        "list_org_folders" => {
            call_frontend(
                state,
                "list_org_folders",
                json!({ "orgId": required_str(&args, "orgId")? }),
            )
            .await?
        }
        "share_recording_to_org" | "move_recording_to_org" => {
            call_frontend(
                state,
                name,
                json!({
                    "id": required_str(&args, "id")?,
                    "orgId": required_str(&args, "orgId")?,
                    "folderId": args.get("folderId").cloned().unwrap_or(Value::Null)
                }),
            )
            .await?
        }
        "copy_org_recording_to_personal" => {
            call_frontend(
                state,
                "copy_org_recording_to_personal",
                json!({
                    "orgId": required_str(&args, "orgId")?,
                    "id": required_str(&args, "id")?
                }),
            )
            .await?
        }
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
/// the file and applies new lines, so we only need to enqueue the intent —
/// stamped with this server's `instance` (same scoping rule as call_frontend)
/// and followed by a wake event so an occluded window applies it promptly.
fn append_command(state: &HttpState, action: &str, args: Value) -> anyhow::Result<Value> {
    use std::io::Write;
    let path = &state.commands_path;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let line = json!({ "instance": state.endpoint, "action": action, "args": args }).to_string();
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(file, "{line}")?;
    let _ = state.app.emit(SESSION_COMMANDS_EVENT, ());
    Ok(json!({ "ok": true, "queued": action }))
}

/// Read the frontend-written session snapshot as opaque JSON (empty object if
/// no meeting has written one yet). The schema is owned by the frontend.
fn read_session(path: &PathBuf) -> Value {
    match std::fs::read_to_string(path) {
        Ok(raw) if !raw.trim().is_empty() => {
            serde_json::from_str(&raw).unwrap_or_else(|_| json!({}))
        }
        _ => json!({}),
    }
}

/// Compact status summary derived from the session snapshot.
fn session_status(path: &PathBuf) -> Value {
    let s = read_session(path);
    let count = |key: &str| s.get(key).and_then(Value::as_array).map_or(0, |a| a.len());
    json!({
        "context": focus_context(&s),
        "meetingStatus": s.get("meetingStatus").cloned().unwrap_or_else(|| json!("idle")),
        "updatedAt": s.get("updatedAt").cloned().unwrap_or(Value::Null),
        "segmentCount": s.pointer("/transcript/segmentCount").cloned().unwrap_or_else(|| json!(0)),
        "todoCount": count("todos"),
        "evalCount": count("evaluations"),
        "findingCount": count("findings"),
    })
}

/// The focus context derived from the snapshot's `context` block (written by the
/// frontend): which screen the user is on, whether a meeting is truly active, and
/// which recording is loaded in replay. `focusSummary` spells out the situation in
/// prose so an MCP client can't misread "stopped + transcript" as a live meeting.
fn focus_context(s: &Value) -> Value {
    let app_mode = s
        .pointer("/context/appMode")
        .and_then(Value::as_str)
        .unwrap_or("live");
    let meeting_status = s
        .get("meetingStatus")
        .and_then(Value::as_str)
        .unwrap_or("idle");
    let replay = s.pointer("/context/replay").cloned().unwrap_or(Value::Null);
    let study_tab = s
        .pointer("/context/studyTab")
        .cloned()
        .unwrap_or(Value::Null);

    let focus = match app_mode {
        "replay" => "replay",
        "accounts" => "accounts",
        _ => match meeting_status {
            // A paused meeting is still THE live meeting (capture held, resume
            // is one click) — same focus, the summary spells out the pause.
            "recording" | "paused" => "live-meeting",
            "stopped" => "live-post-meeting",
            _ => "idle",
        },
    };
    let summary = match focus {
        "replay" => {
            let name = replay
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("(unnamed)");
            let saved = replay.get("savedHistoryId").and_then(Value::as_str);
            format!(
                "The user is REVIEWING a saved recording ('{name}'{}) in the replay/study \
                 screen — they are NOT in a live meeting (the last meeting, if any, already \
                 ended). The transcript and findings in this session snapshot belong to that \
                 recording.",
                match saved {
                    Some(id) => format!(", history id {id}"),
                    None => ", not saved to the local library".to_string(),
                }
            )
        }
        "accounts" => "The user is on the accounts (mini-CRM) screen — no meeting is active \
                       and no recording is loaded."
            .to_string(),
        "live-meeting" => {
            if meeting_status == "paused" {
                "A live meeting is in progress but PAUSED — audio is not being \
                 transcribed or recorded until the user resumes. The transcript \
                 below covers the meeting so far."
                    .to_string()
            } else {
                "A live meeting is being recorded RIGHT NOW; the transcript below \
                 is growing in real time."
                    .to_string()
            }
        }
        "live-post-meeting" => "No meeting is active: the last live meeting has ENDED and \
                                the user is looking at its post-meeting state. The transcript \
                                and findings below are from that finished meeting — do not \
                                treat it as ongoing."
            .to_string(),
        _ => "Nothing is happening: no meeting is active and no recording is loaded.".to_string(),
    };
    json!({
        "focus": focus,
        "appMode": app_mode,
        "meetingStatus": meeting_status,
        "studyTab": study_tab,
        "replay": replay,
        "updatedAt": s.get("updatedAt").cloned().unwrap_or(Value::Null),
        "focusSummary": summary,
    })
}

/// What the user is looking at, with its content AND everything Parley's own
/// analysis has produced for it. The snapshot fields already track the loaded
/// content (in replay mode the store — and therefore the snapshot — holds the
/// replayed recording's transcript, findings, brief, intel, action items, and
/// delivery assessment), so one read covers live, post-meeting, and replay. For
/// a saved replay, `meta.json` backfills anything the snapshot doesn't carry.
fn focused_content(state: &HttpState) -> Value {
    let s = read_session(&state.session_path);
    let ctx = focus_context(&s);
    let focus = ctx.get("focus").and_then(Value::as_str).unwrap_or("idle");
    let mut out = serde_json::Map::new();
    out.insert("context".into(), ctx.clone());
    out.insert("analysisNote".into(), json!(ANALYSIS_NOTE));
    out.insert(
        "transcript".into(),
        s.get("transcript")
            .cloned()
            .unwrap_or_else(|| json!({ "text": "", "segmentCount": 0 })),
    );
    out.insert(
        "findings".into(),
        s.get("findings").cloned().unwrap_or_else(|| json!([])),
    );
    // Every analysis artifact the app has for the loaded content.
    for key in [
        "brief",
        "intel",
        "actionItems",
        "deliveryAssessment",
        "meetingType",
    ] {
        if let Some(v) = s.get(key) {
            if !v.is_null() {
                out.insert(key.into(), v.clone());
            }
        }
    }
    if focus == "live-meeting" || focus == "live-post-meeting" {
        out.insert(
            "todos".into(),
            s.get("todos").cloned().unwrap_or_else(|| json!([])),
        );
        out.insert(
            "evaluations".into(),
            s.get("evaluations").cloned().unwrap_or_else(|| json!([])),
        );
    }
    if focus == "replay" {
        if let Some(id) = ctx
            .pointer("/replay/savedHistoryId")
            .and_then(Value::as_str)
        {
            // Backfill from disk anything the snapshot didn't carry (e.g. a
            // snapshot written by an older app version).
            if let Ok(meta) = read_meta(&state.history_dir, id) {
                for key in [
                    "title",
                    "brief",
                    "intel",
                    "actionItems",
                    "deliveryAssessment",
                    "meetingType",
                ] {
                    if out.contains_key(key) {
                        continue;
                    }
                    if let Some(v) = meta.get(key) {
                        if !v.is_null() {
                            out.insert(key.into(), v.clone());
                        }
                    }
                }
            }
        } else {
            out.insert(
                "note".into(),
                json!(
                    "This recording is not in the local library (an unsaved upload or an \
                       org recording viewed read-only), so saved extras like action items \
                       are unavailable here."
                ),
            );
        }
    }
    Value::Object(out)
}

// ── Local recording store (read-only; mirrors the history.rs layout) ─────────

/// Read one entry's `meta.json`.
fn read_meta(history_dir: &std::path::Path, id: &str) -> anyhow::Result<Value> {
    let path = history_dir
        .join(crate::history::safe_id(id))
        .join("meta.json");
    let raw = std::fs::read_to_string(&path).map_err(|_| {
        anyhow::anyhow!(
            "recording not found: {id} (only locally saved personal recordings are \
             readable here — use list_recordings for valid ids)"
        )
    })?;
    Ok(serde_json::from_str(&raw)?)
}

/// List local recording summaries, newest first, with an optional text filter.
fn list_recordings(history_dir: &std::path::Path, args: &Value) -> anyhow::Result<Value> {
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let folder = args.get("folderId").and_then(Value::as_str);
    let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(50) as usize;

    let mut items: Vec<Value> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(history_dir) {
        for entry in entries.flatten() {
            let Ok(raw) = std::fs::read_to_string(entry.path().join("summary.json")) else {
                continue;
            };
            let Ok(v) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            if let Some(folder) = folder {
                if v.get("folderId").and_then(Value::as_str) != Some(folder) {
                    continue;
                }
            }
            if !query.is_empty() {
                let title = v.get("title").and_then(Value::as_str).unwrap_or("");
                let snippet = v.get("snippet").and_then(Value::as_str).unwrap_or("");
                if !title.to_lowercase().contains(&query)
                    && !snippet.to_lowercase().contains(&query)
                {
                    continue;
                }
            }
            items.push(v);
        }
    }
    items.sort_by_key(|v| {
        std::cmp::Reverse(v.get("createdAt").and_then(Value::as_i64).unwrap_or(0))
    });
    let total = items.len();
    items.truncate(limit);
    Ok(json!({ "recordings": items, "total": total, "returned": items.len() }))
}

/// Read one recording in full: curated meta fields + the transcript rebuilt as
/// timestamped, speaker-labelled text (the segments themselves stay on disk).
/// Includes every analysis artifact saved with the entry, labelled as context
/// via `analysisNote`.
fn get_recording(history_dir: &std::path::Path, id: &str) -> anyhow::Result<Value> {
    let meta = read_meta(history_dir, id)?;
    let names = meta
        .get("speakerNames")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let transcript = transcript_text(&meta, &names);
    let mut out = serde_json::Map::new();
    out.insert("analysisNote".into(), json!(ANALYSIS_NOTE));
    for key in [
        "id",
        "title",
        "source",
        "createdAt",
        "durationMs",
        "speakerNames",
        "findings",
        "actionItems",
        "brief",
        "intel",
        "deliveryAssessment",
        "meetingType",
        "meetingContext",
        "folderId",
    ] {
        if let Some(v) = meta.get(key) {
            if !v.is_null() {
                out.insert(key.into(), v.clone());
            }
        }
    }
    out.insert("transcript".into(), json!(transcript));
    Ok(Value::Object(out))
}

/// Rebuild the saved transcript as "[m:ss] [Speaker] text" lines — the same
/// labelling the frontend's transcriptAsText/speakerLabel produce (store.ts).
fn transcript_text(meta: &Value, names: &Value) -> String {
    let Some(segments) = meta.get("segments").and_then(Value::as_array) else {
        return String::new();
    };
    let mut finals: Vec<&Value> = segments
        .iter()
        .filter(|s| {
            s.get("isFinal").and_then(Value::as_bool).unwrap_or(false)
                && !s
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .is_empty()
        })
        .collect();
    finals.sort_by_key(|s| s.get("startMs").and_then(Value::as_i64).unwrap_or(0));
    finals
        .iter()
        .map(|s| {
            let start = s.get("startMs").and_then(Value::as_i64).unwrap_or(0).max(0);
            let total = start / 1000;
            let source = s.get("source").and_then(Value::as_str).unwrap_or("me");
            let speaker = s.get("speaker").and_then(Value::as_i64).unwrap_or(0);
            let key = format!("{source}-{speaker}");
            let label = match names.get(&key).and_then(Value::as_str) {
                Some(custom) => custom.to_string(),
                None => {
                    let display = if speaker == 0 { 1 } else { speaker };
                    match source {
                        "mix" => format!("Speaker {display}"),
                        "me" => {
                            if display <= 1 {
                                "You".to_string()
                            } else {
                                format!("Speaker {display}")
                            }
                        }
                        _ => {
                            if speaker > 0 {
                                format!("Remote {speaker}")
                            } else {
                                "Them".to_string()
                            }
                        }
                    }
                }
            };
            let text = s.get("text").and_then(Value::as_str).unwrap_or("").trim();
            format!("[{}:{:02}] [{label}] {text}", total / 60, total % 60)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// ── RPC bridge: enqueue a command, wait for the frontend's result ─────────────

/// Enqueue a command carrying an id and wait for the frontend to execute it and
/// append `{ id, ok, data|error }` to the results file. The frontend polls the
/// queue every ~1.5s, so a round trip is typically 2–3s; cloud operations (org
/// listing/moves) add their own network time. Times out after 20s.
async fn call_frontend(state: &HttpState, action: &str, args: Value) -> anyhow::Result<Value> {
    use std::io::Write;
    let id = new_id();
    if let Some(parent) = state.commands_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // `instance` scopes the command to THIS server's own frontend (see HttpState).
    let line =
        json!({ "id": id, "instance": state.endpoint, "action": action, "args": args }).to_string();
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&state.commands_path)?;
    writeln!(file, "{line}")?;
    // Wake the webview AFTER the line is on disk — occluded windows have their
    // timers suspended, so without this kick the poll loop may never run.
    let _ = state.app.emit(SESSION_COMMANDS_EVENT, ());

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        if let Some(result) = find_result(&state.results_path, &id) {
            if result.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                return Ok(result.get("data").cloned().unwrap_or(Value::Null));
            }
            let err = result
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            anyhow::bail!("the Parley app could not apply '{action}': {err}");
        }
        if std::time::Instant::now() >= deadline {
            anyhow::bail!(
                "timed out waiting for the Parley app to apply '{action}' — make sure the \
                 app is running (and signed in, for cloud/org operations)"
            );
        }
    }
}

/// Scan the results file for the line matching `id` (the file is truncated on
/// every server start, so it stays small).
fn find_result(path: &PathBuf, id: &str) -> Option<Value> {
    let raw = std::fs::read_to_string(path).ok()?;
    raw.lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .find(|v| v.get("id").and_then(Value::as_str) == Some(id))
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
