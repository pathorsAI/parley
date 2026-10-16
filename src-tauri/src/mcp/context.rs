//! What every tool runs against: the files the server shares with the app,
//! this server's own identity, and the app's event bus — injected, so the
//! tools run without Tauri.

use std::{path::PathBuf, sync::Arc};

use serde_json::Value;

use super::activity::McpActivity;

/// Broadcasts one app event (`name`, JSON payload) to every window.
pub(super) type EmitFn = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// The server's state, shared by the transport and every tool handler.
#[derive(Clone)]
pub(super) struct McpContext {
    pub(super) templates_path: PathBuf,
    /// The voice-typing phrase dictionary, edited by both the app and an MCP
    /// client — same shared-file arrangement as `templates_path`.
    pub(super) dictionary_path: PathBuf,
    pub(super) session_path: PathBuf,
    pub(super) commands_path: PathBuf,
    /// RPC results appended by the frontend (see `call_frontend`).
    pub(super) results_path: PathBuf,
    /// Local recording store (`<app_data_dir>/history`) for the read-only
    /// recording tools — same layout history.rs documents.
    pub(super) history_dir: PathBuf,
    /// Client-traffic record surfaced to the app UI (`get_mcp_activity`).
    pub(super) activity: McpActivity,
    /// This server's own endpoint ("http://127.0.0.1:<port>/mcp"). Stamped onto
    /// RPC commands as `instance` so that when TWO app instances run (packaged +
    /// dev share the config-dir command queue), only the frontend belonging to
    /// THIS server executes them — otherwise both would, and a mutating RPC like
    /// import_transcript would apply twice.
    pub(super) endpoint: String,
    /// Wakes the webview when a command is enqueued: macOS suspends an
    /// occluded window's JS timers, so the frontend's polling loop alone can
    /// stall until the 20s RPC deadline. An event rides the IPC instead of a
    /// timer, so delivery doesn't depend on the window being visible. Injected
    /// (the app's `emit` in production) so the tools run without Tauri in tests.
    pub(super) emit: EmitFn,
}

/// Attached to every response that carries Parley's own analysis output
/// (findings, brief, action items, delivery assessment), so an MCP client
/// treats those as context to reason over — not as authority.
pub(super) const ANALYSIS_NOTE: &str =
    "The findings, evaluations, brief, action items, and delivery assessment in this \
     response are Parley's OWN prior analysis, included as CONTEXT — not ground truth. When \
     analyzing or advising, reason from the transcript first; you are free and encouraged to \
     think critically, disagree with these results, or surface angles they missed.";

pub(super) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(super) fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub(super) fn required_str<'a>(value: &'a Value, key: &str) -> anyhow::Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("missing string field: {key}"))
}
