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
    dictionary_path, session_command_results_path, session_commands_path, session_path,
    templates_path,
};

const DEFAULT_PORT: u16 = 3011;
const MAX_PORT: u16 = 3020;
/// Emitted after enqueuing a session command so the frontend applies it now
/// instead of on its next (possibly suspended) poll tick.
const SESSION_COMMANDS_EVENT: &str = "session://commands";
const PROTOCOL_VERSION: &str = "2025-06-18";

/// Attached to every response that carries Parley's own analysis output
/// (findings, brief, action items, delivery assessment), so an MCP client
/// treats those as context to reason over — not as authority.
const ANALYSIS_NOTE: &str =
    "The findings, evaluations, brief, action items, and delivery assessment in this \
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
    /// The voice-typing phrase dictionary, edited by both the app and an MCP
    /// client — same shared-file arrangement as `templates_path`.
    dictionary_path: PathBuf,
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

    let dictionary = dictionary_path(&app).unwrap_or_else(|_| {
        app.path()
            .app_config_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("dictionary.json")
    });

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
            app, templates, dictionary, session, commands, results, history, activity, info,
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
    dictionary_path: PathBuf,
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
            dictionary_path,
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
    const WRITE_VERBS: [&str; 13] = [
        "upsert_", "delete_", "add_", "remove_", "check_", "set_", "update_", "rename_", "move_",
        "share_", "copy_", "create_", "import_",
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
        tool(
            "get_app_context",
            "Get what the user is looking at",
            "ALWAYS CALL THIS FIRST to know what the user is focused on. Returns focus \
             (live / replay / library), meetingStatus, and — when the user is reviewing a \
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
             (findings, study brief, action items, delivery assessment; live mode adds \
             todos and evaluations). Those analysis artifacts are CONTEXT from \
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
             recordings. Org-shared recordings live in the cloud — list those with \
             list_org_recordings.",
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
        tool(
            "list_folders",
            "List personal folders",
            "List the personal history folders as { id, name }. Recordings whose folderId \
             is null (or unknown) live at the personal root.",
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

/// JSON-Schema for one TimelineEvent, shared by set_findings. Which fields apply
/// depends on the recording's meeting kind: a sales or negotiation finding is
/// laned by `side` (`me` = a problem/mistake by ME, `them` = a point/pressure the
/// other party raised), while an internal-meeting finding has no side and is
/// bucketed by `category` instead.
fn finding_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "id": { "type": "string", "description": "Stable id; omit to mint a new one." },
            "atMs": { "type": "number", "description": "Moment on the recording timeline (ms)." },
            "side": { "type": "string", "enum": ["me", "them"], "description": "Lane: my problem vs their move. Omit for an internal meeting, which has no opposing side." },
            "category": { "type": "string", "enum": ["decision", "open", "fact"], "description": "Internal-meeting bucket: settled / still open / merely established. Omit when a side is set." },
            "severity": { "type": "string", "enum": ["info", "warn", "critical"] },
            "source": { "type": "string", "enum": ["eval", "extra"], "description": "From an eval, or an AI-caught extra moment." },
            "title": { "type": "string", "description": "Short label." },
            "detail": { "type": "string", "description": "One or two sentences explaining the moment." },
            "quotes": { "type": "array", "items": { "type": "string" }, "description": "Supporting verbatim quotes." },
            "evalIds": { "type": "array", "items": { "type": "string" }, "description": "Matching evaluation ids (for source=eval)." },
            "resolved": { "type": "boolean", "description": "True when ME later addressed/defused this moment." },
            "resolution": { "type": "string", "description": "One line on how ME handled it (only when resolved)." },
            "author": { "type": "string", "description": "Which analyst wrote this marker (e.g. 'claude'); omit for Parley's own pass." }
        },
        "required": ["atMs", "severity", "title", "detail"]
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
        "list_dictionary_phrases" => list_dictionary_phrases(&state.dictionary_path)?,
        "add_dictionary_phrase" => add_dictionary_phrase(&state.dictionary_path, args)?,
        "update_dictionary_phrase" => update_dictionary_phrase(&state.dictionary_path, args)?,
        "delete_dictionary_phrase" => {
            delete_dictionary_phrase(&state.dictionary_path, required_str(&args, "id")?)?
        }
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
        "search_meetings" => search_meetings(&state.history_dir, &args)?,
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
        "update_recording_meta" => {
            required_str(&args, "id")?; // frontend validates the rest of the patch
            call_frontend(state, "update_recording_meta", args).await?
        }
        "set_recording_analysis" => {
            required_str(&args, "id")?; // frontend normalizes findings/actionItems
            call_frontend(state, "set_recording_analysis", args).await?
        }
        "list_folders" => call_frontend(state, "list_folders", json!({})).await?,
        "create_folder" => {
            call_frontend(
                state,
                "create_folder",
                json!({ "name": required_str(&args, "name")? }),
            )
            .await?
        }
        "rename_folder" => {
            call_frontend(
                state,
                "rename_folder",
                json!({
                    "id": required_str(&args, "id")?,
                    "name": required_str(&args, "name")?
                }),
            )
            .await?
        }
        "delete_folder" => {
            call_frontend(
                state,
                "delete_folder",
                json!({ "id": required_str(&args, "id")? }),
            )
            .await?
        }
        "delete_recording" => {
            call_frontend(
                state,
                "delete_recording",
                json!({ "id": required_str(&args, "id")? }),
            )
            .await?
        }
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
        "create_org_folder" => {
            call_frontend(
                state,
                "create_org_folder",
                json!({
                    "orgId": required_str(&args, "orgId")?,
                    "name": required_str(&args, "name")?
                }),
            )
            .await?
        }
        "rename_org_folder" => {
            call_frontend(
                state,
                "rename_org_folder",
                json!({
                    "orgId": required_str(&args, "orgId")?,
                    "id": required_str(&args, "id")?,
                    "name": required_str(&args, "name")?
                }),
            )
            .await?
        }
        "delete_org_folder" => {
            call_frontend(
                state,
                "delete_org_folder",
                json!({
                    "orgId": required_str(&args, "orgId")?,
                    "id": required_str(&args, "id")?
                }),
            )
            .await?
        }
        "move_org_recording_to_folder" => {
            call_frontend(
                state,
                "move_org_recording_to_folder",
                json!({
                    "orgId": required_str(&args, "orgId")?,
                    "id": required_str(&args, "id")?,
                    "folderId": args.get("folderId").cloned().unwrap_or(Value::Null)
                }),
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
        "copy_org_recording_to_personal" | "delete_org_recording" => {
            call_frontend(
                state,
                name,
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
        // Since the app shell landed (#195) the recordings library and settings
        // are routes in the main window rather than separate windows, so they
        // show up here. Neither has content loaded — say so rather than letting
        // them fall through to a meeting-status guess.
        "library" => "library",
        "settings" => "settings",
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
        "library" => "The user is browsing the saved-recordings library — no meeting is \
                      active and no recording is loaded."
            .to_string(),
        "settings" => "The user is in Settings — no meeting is active and no recording is \
                       loaded."
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
/// replayed recording's transcript, findings, brief, action items, and
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
    copy_missing_keys(
        &mut out,
        &s,
        &["brief", "actionItems", "deliveryAssessment"],
    );
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
        add_replay_extras(&mut out, &ctx, &state.history_dir);
    }
    Value::Object(out)
}

/// Copy each non-null `keys` entry from `src` into `out`, leaving whatever `out`
/// already carries untouched.
fn copy_missing_keys(out: &mut serde_json::Map<String, Value>, src: &Value, keys: &[&str]) {
    for key in keys {
        if out.contains_key(*key) {
            continue;
        }
        if let Some(v) = src.get(*key) {
            if !v.is_null() {
                out.insert((*key).to_string(), v.clone());
            }
        }
    }
}

/// For a replay, backfill from `meta.json` anything the snapshot didn't carry
/// (e.g. a snapshot written by an older app version). A recording that isn't in
/// the local library gets a note saying so instead.
fn add_replay_extras(
    out: &mut serde_json::Map<String, Value>,
    ctx: &Value,
    history_dir: &std::path::Path,
) {
    let Some(id) = ctx
        .pointer("/replay/savedHistoryId")
        .and_then(Value::as_str)
    else {
        out.insert(
            "note".into(),
            json!(
                "This recording is not in the local library (an unsaved upload or an \
                       org recording viewed read-only), so saved extras like action items \
                       are unavailable here."
            ),
        );
        return;
    };
    if let Ok(meta) = read_meta(history_dir, id) {
        copy_missing_keys(
            out,
            &meta,
            &["title", "brief", "actionItems", "deliveryAssessment"],
        );
    }
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
    let since = args.get("since").and_then(Value::as_i64).unwrap_or(0);
    let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(50) as usize;

    let mut items: Vec<Value> = read_entry_files(history_dir, "summary.json")
        .filter(|v| in_scope(v, folder, since) && summary_matches_query(v, &query))
        .collect();
    items.sort_by_key(|v| {
        std::cmp::Reverse(v.get("createdAt").and_then(Value::as_i64).unwrap_or(0))
    });
    let total = items.len();
    items.truncate(limit);
    Ok(json!({ "recordings": items, "total": total, "returned": items.len() }))
}

/// Every entry's `file` (`summary.json` / `meta.json`) in the store, as JSON.
/// Entries that can't be read or parsed are skipped — a half-written recording
/// shouldn't fail the whole listing. Lazy: one entry is held at a time, so a
/// large library's `meta.json` files never all sit in memory at once.
fn read_entry_files<'a>(
    history_dir: &std::path::Path,
    file: &'a str,
) -> impl Iterator<Item = Value> + 'a {
    std::fs::read_dir(history_dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(move |entry| std::fs::read_to_string(entry.path().join(file)).ok())
        .filter_map(|raw| serde_json::from_str::<Value>(&raw).ok())
}

/// Folder + `since` scoping, shared by the listing and the search.
fn in_scope(v: &Value, folder: Option<&str>, since: i64) -> bool {
    if let Some(folder) = folder {
        if v.get("folderId").and_then(Value::as_str) != Some(folder) {
            return false;
        }
    }
    since <= 0 || v.get("createdAt").and_then(Value::as_i64).unwrap_or(0) >= since
}

/// The listing's shallow text filter: title or first-line snippet only (the deep
/// search is `search_meetings`). An empty query matches everything. `query` is
/// already lowercased.
fn summary_matches_query(v: &Value, query: &str) -> bool {
    if query.is_empty() {
        return true;
    }
    let title = v.get("title").and_then(Value::as_str).unwrap_or("");
    let snippet = v.get("snippet").and_then(Value::as_str).unwrap_or("");
    title.to_lowercase().contains(query) || snippet.to_lowercase().contains(query)
}

/// Where a search hit landed. Ordered by how much a reader trusts it: a line
/// somebody actually said outranks a conclusion drawn from it.
const SEARCH_FIELDS: [&str; 5] = ["transcript", "brief", "finding", "actionItem", "context"];

/// Characters of surrounding text returned with each hit.
const SNIPPET_PAD: usize = 60;

/// One match, with enough context to read it without opening the recording.
fn hit(field: &str, text: &str, at: usize, query_len: usize, at_ms: Option<i64>) -> Value {
    // Slice on char boundaries — transcripts are mostly CJK here, so byte math
    // would panic mid-character.
    let chars: Vec<char> = text.chars().collect();
    let start = at.saturating_sub(SNIPPET_PAD);
    let end = (at + query_len + SNIPPET_PAD).min(chars.len());
    let mut snippet = chars[start..end].iter().collect::<String>();
    if start > 0 {
        snippet.insert(0, '…');
    }
    if end < chars.len() {
        snippet.push('…');
    }
    let mut out = json!({ "field": field, "snippet": snippet.trim() });
    if let Some(ms) = at_ms {
        out["atMs"] = json!(ms);
    }
    out
}

/// Case-insensitive char-index search (`str::find` returns a BYTE offset, which
/// the char-based snippet window can't use).
fn find_ci(haystack: &str, needle: &str) -> Option<usize> {
    let h: Vec<char> = haystack.to_lowercase().chars().collect();
    let n: Vec<char> = needle.chars().collect();
    if n.is_empty() || n.len() > h.len() {
        return None;
    }
    (0..=h.len() - n.len()).find(|&i| h[i..i + n.len()] == n[..])
}

/// Full-text search across saved recordings — the thing `list_recordings`'s
/// `query` can't do, since that only ever saw the title and the transcript's
/// FIRST line. Scans what was said (segments) plus what the analysis concluded
/// (brief, findings, action items, meeting context).
///
/// Reads every entry's `meta.json` per call rather than maintaining an index:
/// a personal library is hundreds of recordings at most, and a stale index that
/// silently misses a meeting is worse than a scan that takes a moment.
fn search_meetings(history_dir: &std::path::Path, args: &Value) -> anyhow::Result<Value> {
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|q| !q.is_empty())
        .ok_or_else(|| anyhow::anyhow!("query is required"))?
        .to_lowercase();
    let folder = args.get("folderId").and_then(Value::as_str);
    let since = args.get("since").and_then(Value::as_i64).unwrap_or(0);
    let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(20) as usize;
    let per_recording = args
        .get("hitsPerRecording")
        .and_then(Value::as_u64)
        .unwrap_or(5) as usize;
    let qlen = query.chars().count();

    let mut results: Vec<Value> = Vec::new();
    let mut scanned = 0usize;
    for meta in read_entry_files(history_dir, "meta.json") {
        if !in_scope(&meta, folder, since) {
            continue;
        }
        scanned += 1;
        let mut hits = segment_hits(&meta, &query, qlen);
        hits.extend(summary_field_hits(&meta, &query, qlen));
        hits.extend(list_field_hits(&meta, &query, qlen));
        if hits.is_empty() {
            continue;
        }
        results.push(recording_hits(&meta, hits, per_recording));
    }
    // Recordings with the most to say about the query first; ties break newest.
    results.sort_by_key(|r| {
        (
            std::cmp::Reverse(r.get("hitCount").and_then(Value::as_i64).unwrap_or(0)),
            std::cmp::Reverse(r.get("createdAt").and_then(Value::as_i64).unwrap_or(0)),
        )
    });
    let matched = results.len();
    results.truncate(limit);
    Ok(json!({
        "query": query,
        "scanned": scanned,
        "matched": matched,
        "returned": results.len(),
        "recordings": results,
    }))
}

/// What was said. Segment-level so each hit carries a seek target.
fn segment_hits(meta: &Value, query: &str, qlen: usize) -> Vec<Value> {
    let Some(segs) = meta.get("segments").and_then(Value::as_array) else {
        return Vec::new();
    };
    segs.iter()
        .filter_map(|s| {
            let text = s.get("text").and_then(Value::as_str).unwrap_or("");
            let at = find_ci(text, query)?;
            Some(hit(
                "transcript",
                text,
                at,
                qlen,
                s.get("startMs").and_then(Value::as_i64),
            ))
        })
        .collect()
}

/// What the analysis concluded, in the single-string fields.
fn summary_field_hits(meta: &Value, query: &str, qlen: usize) -> Vec<Value> {
    [
        ("brief", meta.get("brief").and_then(Value::as_str)),
        (
            "context",
            meta.get("meetingContext").and_then(Value::as_str),
        ),
    ]
    .into_iter()
    .filter_map(|(field, text)| {
        let text = text?;
        let at = find_ci(text, query)?;
        Some(hit(field, text, at, qlen, None))
    })
    .collect()
}

/// What the analysis concluded, in the list fields (findings, action items).
/// Each item's parts are joined so a query spanning title and detail still hits.
fn list_field_hits(meta: &Value, query: &str, qlen: usize) -> Vec<Value> {
    let mut hits: Vec<Value> = Vec::new();
    // Slices, not fixed-size arrays: the two entries no longer search the same
    // number of fields (an action item is just its text now).
    for (field, key, parts) in [
        ("finding", "findings", &["title", "detail"][..]),
        ("actionItem", "actionItems", &["text"][..]),
    ] {
        for item in meta
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let text = parts
                .iter()
                .filter_map(|p| item.get(*p).and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(" — ");
            if let Some(at) = find_ci(&text, query) {
                hits.push(hit(
                    field,
                    &text,
                    at,
                    qlen,
                    item.get("atMs").and_then(Value::as_i64),
                ));
            }
        }
    }
    hits
}

/// One recording's search result: its identity plus the best `per_recording`
/// hits, most-trusted field first and chronological within a field.
fn recording_hits(meta: &Value, mut hits: Vec<Value>, per_recording: usize) -> Value {
    let total = hits.len();
    hits.sort_by_key(|h| {
        let f = h.get("field").and_then(Value::as_str).unwrap_or("");
        let rank = SEARCH_FIELDS.iter().position(|x| *x == f).unwrap_or(9);
        (rank, h.get("atMs").and_then(Value::as_i64).unwrap_or(0))
    });
    hits.truncate(per_recording);
    json!({
        "id": meta.get("id").cloned().unwrap_or(Value::Null),
        "title": meta.get("title").cloned().unwrap_or(Value::Null),
        "createdAt": meta.get("createdAt").cloned().unwrap_or(Value::Null),
        "folderId": meta.get("folderId").cloned().unwrap_or(Value::Null),
        "hitCount": total,
        "hits": hits,
    })
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
        "deliveryAssessment",
        "meetingContext",
        "folderId",
        "analyzed",
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
            let label = speaker_label(names, source, speaker);
            let text = s.get("text").and_then(Value::as_str).unwrap_or("").trim();
            format!("[{}:{:02}] [{label}] {text}", total / 60, total % 60)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// One segment's speaker label: the user's own name for that voice when there is
/// one, otherwise the same default the frontend's speakerLabel derives (store.ts).
fn speaker_label(names: &Value, source: &str, speaker: i64) -> String {
    let key = format!("{source}-{speaker}");
    if let Some(custom) = names.get(&key).and_then(Value::as_str) {
        return custom.to_string();
    }
    let display = if speaker == 0 { 1 } else { speaker };
    match source {
        "mix" => format!("Speaker {display}"),
        "me" if display <= 1 => "You".to_string(),
        "me" => format!("Speaker {display}"),
        _ if speaker > 0 => format!("Remote {speaker}"),
        _ => "Them".to_string(),
    }
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

// --- Voice-typing phrase dictionary -------------------------------------------
//
// The FRONTEND owns this file's schema; these tools only ever reach into
// `entries[]`. So the document is handled as a raw `serde_json::Value` rather
// than a typed struct: anything we don't know about — the `ignored[]` array,
// fields a newer app version added, extra keys on an individual entry — rides
// through a read/modify/write untouched instead of being silently dropped.

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
    let entry = json!({
        "id": new_id(),
        "phrase": phrase,
        "variants": clean_variants(input.variants.unwrap_or_default()),
        "createdAt": now_ms(),
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

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_ci_is_case_insensitive_and_char_indexed() {
        assert_eq!(find_ci("Hello World", "world"), Some(6));
        // CJK: the index must be in CHARS, not bytes — the snippet window
        // slices on it, and byte math would land mid-character and panic.
        assert_eq!(find_ci("我們聊到東森的席數", "東森"), Some(4));
        assert_eq!(find_ci("nothing here", "absent"), None);
        assert_eq!(find_ci("short", "a much longer needle"), None);
        assert_eq!(find_ci("anything", ""), None);
    }

    #[test]
    fn hit_windows_around_the_match_without_splitting_characters() {
        let text = "前".repeat(100) + "東森" + &"後".repeat(100);
        let at = find_ci(&text, "東森").unwrap();
        let h = hit("transcript", &text, at, 2, Some(1500));
        let snippet = h["snippet"].as_str().unwrap();
        assert!(snippet.contains("東森"));
        assert!(snippet.starts_with('…') && snippet.ends_with('…'));
        assert_eq!(h["atMs"], json!(1500));
        assert_eq!(h["field"], json!("transcript"));
    }

    #[test]
    fn hit_omits_ellipsis_at_the_text_edges_and_atms_when_absent() {
        let h = hit("brief", "東森 outbound", 0, 2, None);
        let snippet = h["snippet"].as_str().unwrap();
        assert!(
            !snippet.starts_with('…'),
            "no leading … at the start of the text"
        );
        assert!(
            !snippet.ends_with('…'),
            "no trailing … at the end of the text"
        );
        assert!(h.get("atMs").is_none());
    }

    #[test]
    fn search_requires_a_non_empty_query() {
        let dir = std::path::Path::new("/nonexistent");
        assert!(search_meetings(dir, &json!({})).is_err());
        assert!(search_meetings(dir, &json!({ "query": "   " })).is_err());
    }

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

    #[test]
    fn dictionary_tools_classify_as_read_or_write() {
        assert_eq!(tool_kind("list_dictionary_phrases"), "read");
        assert_eq!(tool_kind("add_dictionary_phrase"), "write");
        assert_eq!(tool_kind("update_dictionary_phrase"), "write");
        assert_eq!(tool_kind("delete_dictionary_phrase"), "write");
    }
}
