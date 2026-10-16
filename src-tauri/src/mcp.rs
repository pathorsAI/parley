//! Parley's built-in MCP server: a localhost endpoint through which an MCP
//! client reads and edits the templates, the phrase dictionary, the live
//! session and the recording library.
//!
//! - `server`: the HTTP transport and the JSON-RPC methods.
//! - `registry`: the tool catalog and the name → handler table; `tools`
//!   holds the tools themselves, one module per domain.
//! - `store`: read-only access to the local recording store.
//! - `bridge`: the command queue and the RPC round trip into the frontend.
//! - `activity`: the client-traffic feed the app shows.
//!
//! Only this file touches Tauri: everything below runs on a `McpContext`,
//! with the app's event bus injected.

use std::{path::PathBuf, sync::Arc};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::RwLock;

use crate::commands::{
    dictionary_path, session_command_results_path, session_commands_path, session_path,
    templates_path,
};

use activity::McpActivity;
use context::McpContext;

mod activity;
mod bridge;
mod context;
mod registry;
mod server;
mod store;
#[cfg(test)]
mod tests;
mod tools;

#[derive(Clone, Serialize)]
pub struct McpServerInfo {
    pub running: bool,
    pub endpoint: String,
    pub templates_path: String,
}

#[derive(Clone)]
pub struct McpState {
    info: Arc<RwLock<McpServerInfo>>,
    activity: McpActivity,
}

pub fn start(app: AppHandle) -> McpState {
    let config_dir = || app.path().app_config_dir().ok();
    let templates = path_or_fallback(templates_path(&app), config_dir, "templates.json");
    let info = Arc::new(RwLock::new(McpServerInfo {
        running: false,
        endpoint: String::new(),
        templates_path: templates.to_string_lossy().into_owned(),
    }));

    let dictionary = path_or_fallback(dictionary_path(&app), config_dir, "dictionary.json");
    let session = path_or_fallback(session_path(&app), config_dir, "session.json");
    let commands = path_or_fallback(
        session_commands_path(&app),
        config_dir,
        "session_commands.jsonl",
    );
    let results = path_or_fallback(
        session_command_results_path(&app),
        config_dir,
        "session_command_results.jsonl",
    );
    let history = path_or_fallback(
        crate::history::history_dir(&app),
        || app.path().app_data_dir().ok(),
        "history",
    );

    let activity = McpActivity::default();
    let state = McpState {
        info: info.clone(),
        activity: activity.clone(),
    };
    let context = McpContext {
        templates_path: templates,
        dictionary_path: dictionary,
        session_path: session,
        commands_path: commands,
        results_path: results,
        history_dir: history,
        activity,
        // Known once the server has bound its port (see `server::run`).
        endpoint: String::new(),
        emit: Arc::new(move |event: &str, payload: Value| {
            let _ = app.emit(event, payload);
        }),
    };
    tauri::async_runtime::spawn(async move {
        if let Err(err) = server::run(context, info).await {
            eprintln!("[parley-mcp] failed to start: {err}");
        }
    });

    state
}

/// The path a resolver produced, or `name` inside the fallback dir when the
/// resolver failed (`.` when that dir cannot be resolved either).
fn path_or_fallback<E>(
    resolved: Result<PathBuf, E>,
    fallback_dir: impl FnOnce() -> Option<PathBuf>,
    name: &str,
) -> PathBuf {
    resolved.unwrap_or_else(|_| {
        fallback_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(name)
    })
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
    Ok(state.activity.snapshot().await)
}
