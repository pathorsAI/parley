//! The client-traffic feed the app UI shows: who initialized, when the last
//! request arrived, and the recent tool calls.

use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::RwLock;

use super::context::now_ms;

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
pub(super) const ACTIVITY_CAP: usize = 50;

#[derive(Clone, Default)]
pub(super) struct McpActivity {
    inner: Arc<RwLock<ActivityState>>,
}

impl McpActivity {
    /// Every request marks the client as alive; initialize also records who it is.
    pub(super) async fn touch(&self, method: &str, params: &Value) {
        let mut a = self.inner.write().await;
        a.last_request_at = Some(now_ms());
        if method == "initialize" {
            if let Some(client) = params.get("clientInfo") {
                a.client = Some(client.clone());
            }
        }
    }

    /// Log one `tools/call` (newest first, the last ACTIVITY_CAP kept).
    pub(super) async fn record_call(&self, tool: &str, result: &anyhow::Result<Value>) {
        let mut entry = json!({
            "at": now_ms(),
            "tool": tool,
            "kind": tool_kind(tool),
            "ok": result.is_ok(),
        });
        if let Err(err) = result {
            entry["error"] = json!(err.to_string());
        }
        let mut a = self.inner.write().await;
        a.recent.push_front(entry);
        a.recent.truncate(ACTIVITY_CAP);
    }

    /// The feed as the app UI reads it (`get_mcp_activity`).
    pub(super) async fn snapshot(&self) -> Value {
        let a = self.inner.read().await;
        json!({
            "client": a.client,
            "lastRequestAt": a.last_request_at,
            "recent": a.recent.iter().cloned().collect::<Vec<Value>>(),
        })
    }
}

/// Coarse read/write classification for the activity feed, by tool-name verb.
fn tool_kind(name: &str) -> &'static str {
    const WRITE_VERBS: [&str; 14] = [
        "upsert_",
        "delete_",
        "add_",
        "remove_",
        "check_",
        "set_",
        "update_",
        "rename_",
        "move_",
        "share_",
        "copy_",
        "create_",
        "import_",
        "download_",
    ];
    if WRITE_VERBS.iter().any(|v| name.starts_with(v)) {
        "write"
    } else {
        "read"
    }
}

#[cfg(test)]
mod tests {
    use super::tool_kind;

    #[test]
    fn dictionary_tools_classify_as_read_or_write() {
        assert_eq!(tool_kind("list_dictionary_phrases"), "read");
        assert_eq!(tool_kind("add_dictionary_phrase"), "write");
        assert_eq!(tool_kind("update_dictionary_phrase"), "write");
        assert_eq!(tool_kind("delete_dictionary_phrase"), "write");
    }

    #[test]
    fn pulling_a_cloud_recording_counts_as_a_write() {
        // It puts a recording on this device's disk, so the activity log must not
        // file it away as a harmless read.
        assert_eq!(tool_kind("list_cloud_recordings"), "read");
        assert_eq!(tool_kind("download_cloud_recording"), "write");
    }
}
