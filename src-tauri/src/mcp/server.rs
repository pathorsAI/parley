//! The transport: a localhost HTTP endpoint speaking MCP's JSON-RPC.

use std::{net::SocketAddr, sync::Arc};

use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::{net::TcpListener, sync::RwLock};

use super::context::McpContext;
use super::registry::{call_tool, tools};
use super::McpServerInfo;

const DEFAULT_PORT: u16 = 3011;
const MAX_PORT: u16 = 3020;
const PROTOCOL_VERSION: &str = "2025-06-18";

#[derive(Deserialize)]
struct RpcRequest {
    #[serde(default)]
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

/// Bind the first free port, publish the endpoint, and serve until the app
/// exits. `state.endpoint` is filled in here, once the port is known.
pub(super) async fn run(
    mut state: McpContext,
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
    let _ = std::fs::write(&state.results_path, "");

    state.endpoint = endpoint.clone();
    let app = Router::new()
        .route("/health", get(health))
        .route("/mcp", post(handle_rpc))
        .with_state(state);

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

async fn health(State(state): State<McpContext>) -> impl IntoResponse {
    Json(json!({
        "ok": true,
        "name": "parley-templates",
        "templatesPath": state.templates_path,
    }))
}

async fn handle_rpc(
    State(state): State<McpContext>,
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

pub(super) async fn handle_method(
    state: &McpContext,
    method: &str,
    params: Value,
) -> anyhow::Result<Value> {
    state.activity.touch(method, &params).await;
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
            state.activity.record_call(&tool, &result).await;
            result
        }
        _ if method.starts_with("notifications/") => Ok(Value::Null),
        _ => anyhow::bail!("unsupported MCP method: {method}"),
    }
}
